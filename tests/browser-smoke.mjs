import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const root = process.cwd();
const scratch = await mkdtemp(join(tmpdir(), 'keybit-browser-'));
console.log('Test artifacts:', scratch);
const fixture = createServer(async (req, res) => {
  const name = basename(new URL(req.url, 'http://localhost').pathname) || 'basic-login.html';
  if (name === 'save-redirect') { req.resume(); res.writeHead(303, {Location: '/empty.html'}); res.end(); return; }
  try {
    const body = await readFile(name.startsWith('framework-') && process.env.KEYBIT_FRAMEWORK_FIXTURES ? join(process.env.KEYBIT_FRAMEWORK_FIXTURES, name) : join(root, 'tests/fixtures', name));
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(body);
  } catch { res.statusCode = 404; res.end('Not found'); }
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${fixture.address().port}`;
const profile = await mkdtemp(join(scratch, 'profile-'));
const browser = spawn(process.env.KEYBIT_BROWSER || '/Applications/Helium.app/Contents/MacOS/Helium', [
  '--headless=new', '--window-size=1280,1000', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
  '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-component-update', '--disable-sync',
  ...(process.env.KEYBIT_BROWSER_ARGS ?? '').split(' ').filter(Boolean),
  `--user-data-dir=${profile}`, 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let stderr = '';
browser.stderr.on('data', chunk => { stderr += chunk; });
let nextId = 1;
let buffer = '';
const pending = new Map();
const errors = [];
browser.stdio[4].on('data', chunk => {
  buffer += chunk.toString();
  let end;
  while ((end = buffer.indexOf('\0')) !== -1) {
    const event = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (event.id) {
      const item = pending.get(event.id);
      if (item) {
        pending.delete(event.id);
        clearTimeout(item.timer);
        if (event.error) { item.callSite.message = item.method + ': ' + JSON.stringify(event.error); item.reject(item.callSite); }
        else item.resolve(event.result);
      }
    } else if (event.method === 'Runtime.exceptionThrown' ||
      (event.method === 'Log.entryAdded' && event.params.entry.level === 'error')) errors.push(event);
  }
});
function send(method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 12000);
    pending.set(id, { resolve, reject, timer, method, callSite: new Error(method) });
    browser.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
  });
}
async function attach(targetId) {
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  return sessionId;
}
async function evaluate(sessionId, expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sessionId);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function page(pageUrl) {
  const { targetId } = await send('Target.createTarget', { url: pageUrl });
  const session = await attach(targetId);
  await send('Log.enable', {}, session);
  for (let i = 0; i < 40; i++) {
    if (await evaluate(session, `document.readyState === 'complete' && location.href === ${JSON.stringify(pageUrl)}`)) return { targetId, session };
    await delay(100);
  }
  throw new Error(`Page did not load: ${pageUrl}`);
}
async function waitFor(session, expression) {
  for (let i = 0; i < 50; i++) {
    if (await evaluate(session, expression)) return;
    await delay(100);
  }
  throw new Error(`Condition did not complete: ${expression}`);
}
const password = 'a unique browser test passphrase';
const loginPassword = 'test-only-login-secret';
const credentials = { name: 'Test production', username: 'test-user@example.test', password: loginPassword, notes: 'test-only-private-notes', environment: 'production' };
async function input(session, id, value) { await evaluate(session, `document.querySelector(${JSON.stringify(id)}).value = ${JSON.stringify(value)}`); }
async function click(session, id) { await evaluate(session, `document.querySelector(${JSON.stringify(id)}).click()`); }
async function shot(session, name) {
  const capture = await send('Page.captureScreenshot', { captureBeyondViewport: false }, session);
  await writeFile(join(scratch, `${name}.png`), Buffer.from(capture.data, 'base64'));
}
// Screenshots in both themes: the extension follows the system's light/dark setting.
async function shotBoth(sessions, name, capture = sessions[0]) {
  for (const value of ['light', 'dark']) {
    for (const session of sessions) await send('Emulation.setEmulatedMedia', {features: [{name: 'prefers-color-scheme', value}]}, session);
    await delay(150);
    await shot(capture, `${name}-${value}`);
  }
  for (const session of sessions) await send('Emulation.setEmulatedMedia', {features: []}, session);
}
async function rpc(session, type, args = {}) {
  return evaluate(session, `chrome.runtime.sendMessage(${JSON.stringify({ type, ...args })})`);
}
async function savePanel() {
  for (let i = 0; i < 50; i++) {
    const target = (await send('Target.getTargets')).targetInfos.find(t => t.url.includes('/src/inline/save.html#'));
    if (target) {
      const session = await attach(target.targetId);
      await send('Log.enable', {}, session);
      await waitFor(session, '!!document.querySelector("#save") && !document.querySelector("#save").disabled');
      return session;
    }
    await delay(100);
  }
  throw new Error('Save-password prompt did not appear');
}
async function frameTarget(path) {
  for (let i = 0; i < 50; i++) {
    const target = (await send('Target.getTargets')).targetInfos.find(t => t.url.includes(path));
    if (target) { const session = await attach(target.targetId); await send('Log.enable', {}, session); return session; }
    await delay(100);
  }
  throw new Error(`${path} did not appear`);
}
async function absent(path) {
  await delay(500);
  assert.equal((await send('Target.getTargets')).targetInfos.some(t => t.url.includes(path)), false, `${path} should not be open`);
}
async function trustedClick(session, selector) {
  const {x, y} = await evaluate(session, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2}; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', {type, x, y, button: 'left', clickCount: 1}, session);
}
const PANEL = '/src/inline/panel.html#';
async function noSavePanel() {
  await delay(400);
  assert.equal((await send('Target.getTargets')).targetInfos.some(t => t.url.includes('/src/inline/save.html#')), false);
}
try {
  console.log('Browser:', (await send('Browser.getVersion')).product);
  // Opened before install: manifest scripts only reach it through the install-time injection.
  const early = await page(`${url}/email-login.html`);
  await send('Extensions.loadUnpacked', { path: root });
  let worker;
  for (let i = 0; i < 50; i++) {
    worker = (await send('Target.getTargets')).targetInfos.find(t => t.type === 'service_worker' && t.url.endsWith('/src/background/service-worker.js'));
    if (worker) break;
    await delay(100);
  }
  assert.ok(worker, stderr);
  const workerSession = await attach(worker.targetId);
  const id = new URL(worker.url).host;
  const origin = `chrome-extension://${id}`;
  const permissionPage = await page('chrome://extensions/');
  assert.equal(await evaluate(permissionPage.session, 'new Promise(resolve => chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true}, () => resolve(chrome.runtime.lastError?.message ?? true)))'), true);
  await send('Target.closeTarget', {targetId: permissionPage.targetId});
  const manager = await page(`${origin}/src/vault-ui/vault.html`);
  await waitFor(manager.session, '!!document.querySelector("#confirm-password")');
  await input(manager.session, '#master-password', password);
  await input(manager.session, '#confirm-password', password);
  await evaluate(manager.session, 'document.querySelector("#auth form").requestSubmit()');
  await waitFor(manager.session, '!document.querySelector("#app").hidden');
  console.log('PASS: master password creates encrypted vault through UI.');
  await click(manager.session, '#add-login');
  await waitFor(manager.session, 'document.querySelector("#login-dialog")?.open && document.activeElement.id === "website"');
  await click(manager.session, '#generate');
  assert.equal(await evaluate(manager.session, 'document.querySelector("#password").value.length'), 20);
  assert.equal(await evaluate(manager.session, 'document.querySelector("#strength").dataset.level'), '3');
  // A bare host is completed to a full URL, and the preview says where the login will fill.
  await input(manager.session, '#website', url.replace('http://', ''));
  await evaluate(manager.session, 'document.querySelector("#website").dispatchEvent(new Event("blur"))');
  assert.equal(await evaluate(manager.session, 'document.querySelector("#website").value'), url);
  assert.equal(await evaluate(manager.session, 'document.querySelector("#scope-preview > span:last-child").textContent'), `Fills on ${new URL(url).host}`);
  await shotBoth([manager.session], 'add-login-modal');
  for (const [key, value] of Object.entries(credentials)) await input(manager.session, `#${key}`, value);
  await evaluate(manager.session, 'document.querySelector("#login-form").requestSubmit()');
  await waitFor(manager.session, 'document.querySelectorAll(".login-item").length === 1 && !document.querySelector("#login-dialog").open && !document.querySelector("#detail").hidden');
  const persisted = await evaluate(manager.session, 'chrome.storage.local.get(null).then(JSON.stringify)');
  for (const value of [password, loginPassword, credentials.username, credentials.notes, credentials.name]) assert.ok(!persisted.includes(value));
  await shot(manager.session, 'vault');
  console.log('PASS: credential saved; all credential fields encrypted in persistent storage.');
  assert.deepEqual((await rpc(manager.session, 'DISABLED_SITES')).data, []);
  assert.equal((await rpc(manager.session, 'STATUS')).data.settings.autoLockMinutes, 0);
  await send('Target.activateTarget', { targetId: early.targetId });
  await evaluate(early.session, 'document.querySelector("#user").focus()');
  const earlyPanel = await frameTarget(PANEL);
  await waitFor(earlyPanel, 'document.querySelectorAll(".account").length === 1');
  await send('Target.closeTarget', { targetId: early.targetId });
  console.log('PASS: KeyBit is on for every site by default, including tabs opened before install; new vaults default to Never.');
  await input(manager.session, '#search', 'does not exist');
  await evaluate(manager.session, 'document.querySelector("#search").dispatchEvent(new Event("input"))');
  await waitFor(manager.session, 'document.querySelectorAll(".login-item").length === 0');
  await input(manager.session, '#search', '');
  await evaluate(manager.session, 'document.querySelector("#search").dispatchEvent(new Event("input"))');
  await waitFor(manager.session, 'document.querySelectorAll(".login-item").length === 1');
  await click(manager.session, '.login-item');
  await waitFor(manager.session, '!!document.querySelector("#edit-login")');
  await click(manager.session, '#edit-login');
  await waitFor(manager.session, `document.querySelector("#login-dialog").open && document.querySelector("#editor-title").textContent === "Edit login" && document.querySelector("#password").value === ${JSON.stringify(loginPassword)}`);
  await input(manager.session, '#name', 'Edited production');
  await evaluate(manager.session, 'document.querySelector("#login-form").requestSubmit()');
  await waitFor(manager.session, 'document.querySelector(".item-row .primary").textContent === "Edited production" && document.querySelector(".detail-header h3")?.firstChild.textContent === "Edited production"');
  console.log('PASS: search and edit work through the UI.');
  const login = await page(`${url}/basic-login.html`);
  await send('Target.activateTarget', { targetId: login.targetId });
  const tabs = await send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] });
  const loginTab = tabs.targetInfos.find(t => t.url === `${url}/basic-login.html`);
  await send('Extensions.triggerAction', { id, targetId: loginTab.targetId });
  await delay(400);
  const popupTarget = (await send('Target.getTargets')).targetInfos.find(t => t.url.endsWith('/src/popup/popup.html'));
  const popup = await attach(popupTarget.targetId);
  await send('Log.enable', {}, popup);
  await waitFor(popup, 'document.querySelectorAll("#matches .login-item").length === 1');
  await click(popup, '.login-item [data-action="fill"]');
  await waitFor(login.session, `document.querySelector('#pass').value === ${JSON.stringify(loginPassword)}`);
  assert.equal(await evaluate(login.session, 'document.querySelector("#user").value'), credentials.username);
  const events = await evaluate(login.session, 'window.fixtureEvents');
  assert.equal(events.input, 2); assert.equal(events.change, 2); assert.equal(events.submit, 0);
  await shot(popup, 'popup');
  console.log('PASS: matching, explicit autofill, input/change events, and no form submission.');
  for (const [name, forms] of [['email-login', 1], ['bootstrap-login', 1], ['controlled-login', 1], ['multiple-password-fields', 0], ['iframe-login', 0], ['empty', 0], ['dynamic-login', 0]]) {
    await send('Page.navigate', { url: `${url}/${name}.html` }, login.session);
    await waitFor(login.session, `document.readyState === 'complete' && location.href === ${JSON.stringify(`${url}/${name}.html`)}`);
    await click(popup, '#check-page');
    await waitFor(popup, '!document.querySelector("#check-page").disabled');
    const supported = await evaluate(popup, 'document.querySelector("#detection-status").textContent');
    assert.equal(supported.startsWith('Login form detected'), forms === 1, name + ': ' + supported);
    if (forms) {
      await waitFor(popup, '!!document.querySelector(".login-item [data-action=fill]:not(:disabled)")');
      await click(popup, '.login-item [data-action="fill"]');
      await waitFor(login.session, `document.querySelector('#pass').value === ${JSON.stringify(loginPassword)}`);
      if (name === 'controlled-login') assert.deepEqual(await evaluate(login.session, 'window.controlledState'), { user: credentials.username, pass: loginPassword });
    }
  }
  await click(login.session, '#add-form');
  await click(popup, '#check-page');
  await waitFor(popup, '!document.querySelector("#check-page").disabled && document.querySelector("#detection-status").textContent.startsWith("Login form detected")');
  console.log('PASS: plain, email, Bootstrap-style, controlled, dynamic, ambiguous, and iframe fixtures.');
  await input(popup, '#search', 'zzz-no-match');
  await evaluate(popup, 'document.querySelector("#search").dispatchEvent(new Event("input"))');
  await waitFor(popup, '!document.querySelector("#others").hidden && document.querySelectorAll("#matches .login-item").length === 0');
  await input(popup, '#search', '');
  await evaluate(popup, 'document.querySelector("#search").dispatchEvent(new Event("input"))');
  await waitFor(popup, 'document.querySelector("#others").hidden && document.querySelectorAll("#matches .login-item").length === 1');
  await click(popup, '#toggle-generator');
  await waitFor(popup, 'document.querySelector("#generated").textContent.length === 20');
  await click(popup, '#symbols');
  await waitFor(popup, '/^[A-Za-z0-9]{20}$/.test(document.querySelector("#generated").textContent)');
  // Turn symbols back on: the generator choice is remembered for the rest of the run.
  await click(popup, '#symbols');
  await waitFor(popup, '/[^A-Za-z0-9]/.test(document.querySelector("#generated").textContent)');
  await shotBoth([popup], 'popup-generator');
  await click(popup, '#toggle-generator');
  console.log('PASS: popup search across all logins and the quick generator.');
  // Add a login from the popup in a modal, prefilled with this site.
  await click(popup, '#add-login');
  await waitFor(popup, 'document.querySelector("#login-dialog")?.open');
  assert.equal(await evaluate(popup, 'document.querySelector("#website").value'), `${url}/`);
  await input(popup, '#username', credentials.username);
  await evaluate(popup, 'document.querySelector("#username").dispatchEvent(new Event("input"))');
  assert.equal(await evaluate(popup, '!document.querySelector("#duplicate-note").hidden'), true, 'Same username on the same site is pointed out');
  await input(popup, '#username', 'popup-added');
  await evaluate(popup, 'document.querySelector("#username").dispatchEvent(new Event("input"))');
  assert.equal(await evaluate(popup, 'document.querySelector("#duplicate-note").hidden'), true);
  await click(popup, '#generate');
  await shotBoth([popup], 'popup-add-modal');
  await evaluate(popup, 'document.querySelector("#login-form").requestSubmit()');
  await waitFor(popup, '!document.querySelector("#login-dialog").open && document.querySelectorAll("#matches .login-item").length === 2');
  let popupState = (await rpc(popup, 'STATUS')).data;
  const popupAdded = (await rpc(popup, 'LIST', {session: popupState.session, query: 'popup-added'})).data[0];
  assert.equal(popupAdded.name, new URL(url).host, 'An empty name defaults to the site');
  await rpc(popup, 'DELETE', {session: popupState.session, revision: popupState.revision, id: popupAdded.id});
  await waitFor(popup, 'document.querySelectorAll("#matches .login-item").length === 1');
  console.log('PASS: Add login opens as a modal in the popup, prefilled with the site, with a duplicate warning.');
  if (process.env.KEYBIT_FRAMEWORK_FIXTURES) {
    for (const framework of ['react', 'vue', 'jquery']) {
      await send('Page.navigate', {url: `${url}/framework-${framework}.html`}, login.session);
      await waitFor(login.session, `document.readyState === 'complete' && location.href === ${JSON.stringify(`${url}/framework-${framework}.html`)} && !!document.querySelector('#pass')`);
      await click(popup, '#check-page');
      await waitFor(popup, '!document.querySelector("#check-page").disabled && !!document.querySelector(".login-item [data-action=fill]:not(:disabled)")');
      await click(popup, '.login-item [data-action="fill"]');
      await waitFor(login.session, `window.frameworkState?.pass === ${JSON.stringify(loginPassword)}`);
      assert.equal(await evaluate(login.session, 'window.frameworkState.user'), credentials.username);
      console.log(`PASS: real ${framework} form state receives autofill.`);
    }
    await send('Page.navigate', {url: `${url}/dynamic-login.html`}, login.session);
    await waitFor(login.session, `document.readyState === 'complete' && location.href === ${JSON.stringify(`${url}/dynamic-login.html`)} && !!document.querySelector('#add-form')`);
    await click(login.session, '#add-form');
    await waitFor(login.session, '!!document.querySelector("#user")');
  }
  // On by default: neither site approval nor the toolbar popup is needed for field suggestions.
  assert.equal(await evaluate(popup, '!document.querySelector("#site-toggle").hidden && document.querySelector("#site-enabled").checked'), true);
  await evaluate(popup, 'window.close()');
  await send('Target.activateTarget', { targetId: login.targetId });
  await evaluate(login.session, 'document.querySelector("#user").focus()');
  let panel = await frameTarget(PANEL);
  await waitFor(panel, 'document.querySelectorAll(".account").length === 1');
  await waitFor(login.session, 'document.documentElement.lastElementChild.style.opacity === "1"');
  assert.equal(await evaluate(panel, 'chrome.runtime.sendMessage({type:"EXPORT"}).then(result=>!result).catch(()=>true)'), true);
  assert.equal(await evaluate(login.session, 'document.body.textContent.includes("test-user@example.test")'), false);
  await shotBoth([login.session, panel], 'inline');
  await evaluate(login.session, 'window.dispatchEvent(new Event("scroll"))');
  await delay(300);
  assert.ok((await send('Target.getTargets')).targetInfos.some(t => t.url.includes(PANEL)), 'Scrolling should reposition, not close, the dropdown');
  await evaluate(login.session, 'document.querySelector("#user").dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}))');
  await absent(PANEL);
  assert.equal(await evaluate(login.session, 'document.activeElement.id'), 'user');
  // A field that already has focus fires no focusin; clicking it must still reopen KeyBit.
  await trustedClick(login.session, '#user');
  panel = await frameTarget(PANEL);
  await waitFor(panel, 'document.querySelectorAll(".account").length === 1');
  await click(panel, '.account');
  await waitFor(login.session, `document.querySelector('#pass').value === ${JSON.stringify(loginPassword)}`);
  await absent(PANEL);
  console.log('PASS: field dropdown appears by default, survives scrolling, reopens on click of a focused field, and fills in an isolated frame.');
  async function openPopup() {
    await send('Extensions.triggerAction', { id, targetId: loginTab.targetId });
    const session = await frameTarget('/src/popup/popup.html');
    await waitFor(session, '!document.querySelector("#site-toggle").hidden && !document.querySelector("#site-enabled").disabled');
    return session;
  }
  let sitePopup = await openPopup();
  await click(sitePopup, '#site-enabled');
  await waitFor(sitePopup, 'document.querySelector("#message").textContent.includes("is off")');
  assert.deepEqual((await rpc(sitePopup, 'DISABLED_SITES')).data, [url]);
  await evaluate(sitePopup, 'window.close()');
  await send('Target.activateTarget', { targetId: login.targetId });
  await evaluate(login.session, 'document.querySelector("#user").blur(); document.querySelector("#user").focus()');
  await absent(PANEL);
  await trustedClick(login.session, '#user');
  await absent(PANEL);
  sitePopup = await openPopup();
  assert.equal(await evaluate(sitePopup, 'document.querySelector("#site-enabled").checked'), false);
  await click(sitePopup, '#site-enabled');
  await waitFor(sitePopup, 'document.querySelector("#message").textContent.includes("will appear")');
  assert.deepEqual((await rpc(sitePopup, 'DISABLED_SITES')).data, []);
  await evaluate(sitePopup, 'window.close()');
  await send('Target.activateTarget', { targetId: login.targetId });
  await evaluate(login.session, 'document.querySelector("#user").blur(); document.querySelector("#user").focus()');
  const keyboardPanel = await frameTarget(PANEL);
  await waitFor(keyboardPanel, 'document.querySelectorAll(".account").length === 1');
  console.log('PASS: the popup switch turns KeyBit off and back on for one site.');
  await waitFor(login.session, 'document.documentElement.lastElementChild.style.opacity === "1"');
  await evaluate(login.session, 'document.querySelector("#pass").value = ""');
  const key = async (session, keyName, code, text) => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', {type, key: keyName, code: keyName, windowsVirtualKeyCode: code, ...(text && type === 'keyDown' ? {text} : {})}, session); };
  await key(login.session, 'ArrowDown', 40);
  await waitFor(keyboardPanel, 'document.activeElement?.classList.contains("account")');
  // CDP routes key events to the target's own frame; a real keypress goes to the focused frame.
  await key(keyboardPanel, 'Enter', 13, '\r');
  await waitFor(login.session, `document.querySelector('#pass').value === ${JSON.stringify(loginPassword)}`);
  await absent(PANEL);
  assert.equal(await evaluate(login.session, 'document.activeElement.id'), 'user');
  console.log('PASS: ArrowDown moves into the dropdown, Enter fills, and focus returns to the field.');
  // Sign-up: a new-password field offers a generated password, and submitting offers to save it.
  await send('Page.navigate', {url: `${url}/signup.html`}, login.session);
  await waitFor(login.session, `document.readyState === 'complete' && location.href === ${JSON.stringify(`${url}/signup.html`)}`);
  await evaluate(login.session, 'document.querySelector("#new").focus()');
  const signupPanel = await frameTarget(PANEL);
  await waitFor(signupPanel, '!!document.querySelector("#use-generated") && document.querySelector(".generated").textContent.length === 20');
  await waitFor(login.session, 'document.documentElement.lastElementChild.style.opacity === "1"');
  await shot(login.session, 'signup-generator');
  const suggested = await evaluate(signupPanel, 'document.querySelector(".generated").textContent');
  await click(signupPanel, '#use-generated');
  await waitFor(login.session, `document.querySelector("#new").value === ${JSON.stringify(suggested)} && document.querySelector("#confirm").value === ${JSON.stringify(suggested)}`);
  await absent(PANEL);
  await input(login.session, '#email', 'new-signup@example.test');
  await click(login.session, 'button');
  await waitFor(login.session, `document.readyState === 'complete' && location.href === ${JSON.stringify(`${url}/empty.html`)}`);
  const signupCard = await savePanel();
  assert.equal(await evaluate(signupCard, 'document.querySelector("#heading").textContent'), 'Save this password?');
  await click(signupCard, '#save');
  await noSavePanel();
  let signupState = (await rpc(manager.session, 'STATUS')).data;
  const signedUp = (await rpc(manager.session, 'LIST', {session: signupState.session, query: 'new-signup'})).data[0];
  assert.equal((await rpc(manager.session, 'ITEM', {session: signupState.session, id: signedUp.id})).data.item.password, suggested);
  await rpc(manager.session, 'DELETE', {session: signupState.session, revision: signupState.revision, id: signedUp.id});
  console.log('PASS: sign-up fields get a generated password in both fields, and the new account is offered for saving.');
  // The keyboard shortcut's message opens KeyBit on the page's login field even when nothing is focused.
  await send('Page.navigate', {url: `${url}/basic-login.html`}, login.session);
  await waitFor(login.session, `document.readyState === 'complete' && location.href === ${JSON.stringify(`${url}/basic-login.html`)}`);
  await evaluate(manager.session, `chrome.tabs.query({url: 'http://127.0.0.1/*'}).then(tabs => Promise.all(tabs.map(tab => chrome.tabs.sendMessage(tab.id, {event: 'keybit-show'}, {frameId: 0}).catch(() => null))))`);
  await waitFor(await frameTarget(PANEL), 'document.querySelectorAll(".account").length === 1');
  assert.equal(await evaluate(login.session, 'document.activeElement.id'), 'user');
  await evaluate(login.session, 'document.querySelector("#user").dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}))');
  await absent(PANEL);
  console.log('PASS: the show-suggestions shortcut opens the dropdown on the page\'s login field.');
  // Real form navigation: pending credentials survive the same-origin 303 redirect.
  await send('Page.navigate', {url: `${url}/save-login.html`}, login.session);
  await waitFor(login.session, `document.readyState === 'complete' && location.href === ${JSON.stringify(`${url}/save-login.html`)}`);
  await delay(300);
  const beforeSubmission = await evaluate(manager.session, 'chrome.storage.local.get(null).then(JSON.stringify)');
  await input(login.session, '#user', 'captured-user');
  await input(login.session, '#pass', 'captured-secret');
  await click(login.session, 'button');
  await waitFor(login.session, `document.readyState === 'complete' && location.href === ${JSON.stringify(`${url}/empty.html`)}`);
  let saveCard = await savePanel();
  assert.equal(await evaluate(saveCard, 'document.querySelector("#heading").textContent'), 'Save this password?');
  assert.equal(await evaluate(manager.session, 'chrome.storage.local.get(null).then(JSON.stringify)'), beforeSubmission);
  assert.equal(await evaluate(saveCard, 'document.body.textContent.includes("captured-secret")'), false);
  assert.equal(await evaluate(saveCard, 'chrome.runtime.sendMessage({type:"EXPORT"}).then(result=>!result).catch(()=>true)'), true);
  await waitFor(saveCard, 'innerHeight < 300');
  await shot(login.session, 'save-prompt');
  await click(saveCard, '#save');
  await noSavePanel();
  let captureState = (await rpc(manager.session, 'STATUS')).data;
  let captured = (await rpc(manager.session, 'LIST', {session: captureState.session})).data.find(item => item.username === 'captured-user');
  assert.ok(captured);
  assert.equal((await rpc(manager.session, 'ITEM', {session: captureState.session, id: captured.id})).data.item.password, 'captured-secret');
  assert.equal((await evaluate(manager.session, 'chrome.storage.local.get(null).then(JSON.stringify)')).includes('captured-secret'), false);
  console.log('PASS: save prompt survives a real login redirect, waits for confirmation, then stores encrypted credentials.');
  await send('Page.navigate', {url: `${url}/basic-login.html`}, login.session);
  await waitFor(login.session, `document.readyState === 'complete' && location.href === ${JSON.stringify(`${url}/basic-login.html`)}`);
  await delay(300);
  await input(login.session, '#user', 'captured-user');
  await input(login.session, '#pass', 'captured-secret');
  await click(login.session, 'button');
  await noSavePanel();
  await input(login.session, '#pass', 'changed-secret');
  await evaluate(login.session, 'document.querySelector("form").dispatchEvent(new Event("submit", {bubbles:true, cancelable:true}))');
  await noSavePanel();
  await click(login.session, 'button');
  saveCard = await savePanel();
  assert.equal(await evaluate(saveCard, 'document.querySelector("#heading").textContent'), 'Update this password?');
  await shotBoth([login.session, saveCard], 'update-prompt');
  await click(saveCard, '#dismiss');
  await noSavePanel();
  assert.equal((await rpc(manager.session, 'ITEM', {session: captureState.session, id: captured.id})).data.item.password, 'captured-secret');
  await click(login.session, 'button');
  saveCard = await savePanel();
  await click(saveCard, '#save');
  await noSavePanel();
  assert.equal((await rpc(manager.session, 'ITEM', {session: captureState.session, id: captured.id})).data.item.password, 'changed-secret');
  console.log('PASS: identical credentials are skipped; changed passwords offer update; Not now leaves the vault unchanged.');
  // A sign-up form (new-password field) now offers to save; the existing username offers an update, never silently.
  await input(login.session, '#pass', 'registration-secret');
  await evaluate(login.session, 'document.querySelector("#pass").autocomplete = "new-password"');
  await click(login.session, 'button');
  saveCard = await savePanel();
  assert.equal(await evaluate(saveCard, 'document.querySelector("#heading").textContent'), 'Update this password?');
  assert.equal(await evaluate(saveCard, '!document.querySelector("#alternate").hidden && document.querySelector("#alternate").textContent'), 'Save as new');
  await click(saveCard, '#dismiss');
  await noSavePanel();
  await evaluate(login.session, 'document.querySelector("#pass").autocomplete = "current-password"; document.querySelector("form").action = "https://other.example.test/login"');
  await click(login.session, 'button');
  await noSavePanel();
  await evaluate(login.session, 'document.querySelector("form").removeAttribute("action")');
  console.log('PASS: synthetic submissions and cross-origin form actions do not produce save prompts; sign-up forms offer an explicit choice.');
  await input(login.session, '#pass', 'must-not-save-after-lock');
  await click(login.session, 'button');
  await savePanel();
  await rpc(manager.session, 'LOCK');
  await noSavePanel();
  await click(login.session, 'button');
  await noSavePanel();
  await rpc(manager.session, 'UNLOCK', {password});
  captureState = (await rpc(manager.session, 'STATUS')).data;
  assert.equal((await rpc(manager.session, 'ITEM', {session: captureState.session, id: captured.id})).data.item.password, 'changed-secret');
  console.log('PASS: locking clears the pending prompt; submissions while locked do not save credentials.');
  await send('Target.activateTarget', {targetId: manager.targetId});
  await waitFor(manager.session, '!document.querySelector("#app").hidden && document.querySelectorAll(".login-item").length === 2');
  await click(manager.session, `.login-item[data-id="${captured.id}"]`);
  await waitFor(manager.session, 'document.querySelector(".history summary")?.textContent === "Password history (1)"');
  await evaluate(manager.session, 'document.querySelector(".history").open = true');
  await shotBoth([manager.session], 'detail-history');
  const originalRestore = await evaluate(manager.session, 'window.confirm = () => true');
  void originalRestore;
  await click(manager.session, '.history-entry [aria-label="Restore this password"]');
  captureState = (await rpc(manager.session, 'STATUS')).data;
  for (let i = 0; i < 50 && (await rpc(manager.session, 'ITEM', {session: captureState.session, id: captured.id})).data.item.password !== 'captured-secret'; i++) await delay(100);
  const restoredItem = (await rpc(manager.session, 'ITEM', {session: captureState.session, id: captured.id})).data.item;
  assert.equal(restoredItem.password, 'captured-secret');
  assert.deepEqual(restoredItem.history.map(entry => entry.password), ['changed-secret']);
  // A weak password shows up in Weak & reused.
  captureState = (await rpc(manager.session, 'STATUS')).data;
  await rpc(manager.session, 'SAVE', {session: captureState.session, revision: captureState.revision, item: {name: 'Weak one', urls: ['https://weak.example.test'], username: 'weak', password: 'admin123', notes: '', environment: 'other'}});
  await waitFor(manager.session, 'document.querySelector("#count-health").textContent === "1" && !document.querySelector("#count-health").hidden');
  await click(manager.session, '[data-view="health"]');
  await waitFor(manager.session, '!document.querySelector("#view-health").hidden && document.querySelectorAll("#health-list .login-item").length === 1');
  await shot(manager.session, 'health');
  await click(manager.session, '#health-list .login-item');
  await waitFor(manager.session, '!document.querySelector("#view-logins").hidden && !!document.querySelector(".warning.weak")');
  captureState = (await rpc(manager.session, 'STATUS')).data;
  const weak = (await rpc(manager.session, 'LIST', {session: captureState.session, query: 'Weak one'})).data[0];
  captureState = (await rpc(manager.session, 'DELETE', {session: captureState.session, revision: captureState.revision, id: weak.id})).data;
  await rpc(manager.session, 'DELETE', {session: captureState.session, revision: captureState.revision, id: captured.id});
  console.log('PASS: password history restore, and weak passwords flagged in Weak & reused.');
  await send('Target.activateTarget', {targetId: manager.targetId});
  const current = (await rpc(manager.session, 'STATUS')).data;
  const backup = (await rpc(manager.session, 'EXPORT')).data;
  assert.equal(backup.formatVersion, 1);
  const prepare = await rpc(manager.session, 'PREPARE_IMPORT', {text: JSON.stringify(backup), password});
  assert.equal(prepare.ok, true);
  assert.equal(prepare.data.count, 1);
  assert.equal((await rpc(manager.session, 'COMMIT_IMPORT', {token: prepare.data.token, confirmed: false})).ok, false);
  assert.equal((await rpc(manager.session, 'COMMIT_IMPORT', {token: prepare.data.token, confirmed: true})).ok, true);
  await waitFor(manager.session, 'document.querySelector("#app").hidden && !!document.querySelector("#master-password")');
  assert.equal(await evaluate(manager.session, 'document.querySelectorAll(".login-item").length'), 0);
  assert.equal((await rpc(manager.session, 'LIST', {session: current.session})).ok, false);
  await input(manager.session, '#master-password', 'incorrect password');
  await evaluate(manager.session, 'document.querySelector("#auth form").requestSubmit()');
  await waitFor(manager.session, 'document.querySelector("#message").textContent.includes("Incorrect master")');
  await input(manager.session, '#master-password', password);
  await evaluate(manager.session, 'document.querySelector("#auth form").requestSubmit()');
  await waitFor(manager.session, '!document.querySelector("#app").hidden');
  console.log('PASS: encrypted restore, replacement confirmation, wrong password, lock cleanup, and unlock.');
  const settings = await page(`${origin}/src/vault-ui/vault.html#backup`);
  await waitFor(settings.session, '!document.querySelector("#app").hidden && !document.querySelector("#view-backup").hidden');
  // Auto-lock is an icon whose tooltip names the setting; Never is the default.
  assert.equal(await evaluate(settings.session, 'document.querySelector("#autolock").title'), 'Auto-lock: Never');
  assert.equal(await evaluate(settings.session, 'document.querySelector("#autolock-menu [data-minutes=\'0\']").getAttribute("aria-checked")'), 'true');
  // Sites turned off only appears when a site is off; nothing explains the default.
  assert.equal(await evaluate(settings.session, 'document.querySelector("#nav-sites").hidden'), true);
  await click(settings.session, '#autolock');
  await shot(settings.session, 'autolock-menu');
  await click(settings.session, '#autolock-menu [data-minutes="1"]');
  await waitFor(settings.session, 'document.querySelector("#message").textContent.includes("1 minute") && document.querySelector("#autolock").title === "Auto-lock: 1 minute"');
  assert.equal((await rpc(settings.session, 'STATUS')).data.settings.autoLockMinutes, 1);
  // Another window changes the vault revision; the next setting change must still save.
  const other = (await rpc(settings.session, 'STATUS')).data;
  await rpc(settings.session, 'SAVE', {session: other.session, revision: other.revision, item: {name: 'Revision bump', urls: ['https://bump.example.test'], username: 'bump', password: 'bump-secret', notes: '', environment: 'other'}});
  await click(settings.session, '#autolock-menu [data-minutes="0"]');
  await waitFor(settings.session, 'document.querySelector("#message").textContent.includes("Never") && document.querySelector("#autolock").title === "Auto-lock: Never"');
  const bumped = (await rpc(settings.session, 'STATUS')).data;
  assert.equal(bumped.settings.autoLockMinutes, 0);
  const bump = (await rpc(settings.session, 'LIST', {session: bumped.session, query: 'Revision bump'})).data[0];
  await rpc(settings.session, 'DELETE', {session: bumped.session, revision: bumped.revision, id: bump.id});
  await shot(settings.session, 'backup');
  await click(settings.session, '[data-view="generator"]');
  await waitFor(settings.session, 'document.querySelector("#gen-output").textContent.length === 20 && location.hash === "#generator"');
  await shot(settings.session, 'generator');
  await click(settings.session, '[data-view="logins"]');
  console.log('PASS: auto-lock icon menu defaults to Never and saves immediately, even after another window edits the vault; sidebar views.');
  await send('Emulation.setDeviceMetricsOverride', {width: 360, height: 900, deviceScaleFactor: 1, mobile: false}, settings.session);
  const overflow = 'JSON.stringify([...document.querySelectorAll("body *")].filter(node => node.getBoundingClientRect().right > innerWidth + 1 && !node.closest(".sidebar")).slice(0, 6).map(node => node.tagName + "#" + node.id + "." + node.className + " " + Math.round(node.getBoundingClientRect().right)))';
  assert.equal(await evaluate(settings.session, 'document.documentElement.scrollWidth <= innerWidth'), true, await evaluate(settings.session, overflow));
  await click(settings.session, '.login-item');
  await waitFor(settings.session, '!document.querySelector("#detail").hidden && getComputedStyle(document.querySelector(".list-pane")).display === "none"');
  assert.equal(await evaluate(settings.session, 'document.documentElement.scrollWidth <= innerWidth'), true, await evaluate(settings.session, overflow));
  await shotBoth([settings.session], 'app-narrow-detail');
  await click(settings.session, '.back-button');
  await click(settings.session, '[data-view="backup"]');
  await shot(settings.session, 'app-narrow');
  await send('Emulation.clearDeviceMetricsOverride', {}, settings.session);
  await send('Browser.setDownloadBehavior', {behavior:'allow',downloadPath:scratch});
  await click(settings.session, '#export');
  let exported;
  for (let i = 0; i < 50; i++) {
    exported = (await readdir(scratch)).find(name => name.endsWith('.kvault'));
    if (exported) break;
    await delay(100);
  }
  assert.ok(exported, 'Export button should download an encrypted backup');
  assert.equal(JSON.parse(await readFile(join(scratch, exported), 'utf8')).formatVersion, 1);
  await waitFor(settings.session, 'document.querySelector("#last-backup").textContent.startsWith("Last exported")');
  const {root: domRoot} = await send('DOM.getDocument', {}, settings.session);
  const fileInput = await send('DOM.querySelector', {nodeId:domRoot.nodeId,selector:'#backup-file'}, settings.session);
  await send('DOM.setFileInputFiles', {nodeId:fileInput.nodeId,files:[join(scratch,exported)]}, settings.session);
  await input(settings.session, '#backup-password', password);
  await evaluate(settings.session, 'document.querySelector("#import-form").requestSubmit()');
  await waitFor(settings.session, '!document.querySelector("#import-confirmation").hidden && !document.querySelector("#app").hidden');
  await click(settings.session, '#confirm-import');
  await waitFor(settings.session, 'document.querySelector("#message").textContent.includes("Backup restored") && !document.querySelector("#locked").hidden');
  await input(settings.session, '#master-password', password);
  await evaluate(settings.session, 'document.querySelector("#auth form").requestSubmit()');
  await waitFor(settings.session, '!document.querySelector("#app").hidden && document.querySelector("#count-logins").textContent === "1"');
  console.log('PASS: backup download, reminder timestamp, and file restore work through the app window.');
  console.log('Checking that Never outlasts the 30-second worker idle timeout…');
  assert.equal((await rpc(settings.session, 'STATUS')).data.settings.autoLockMinutes, 0);
  // DevTools sessions and open extension pages would keep the worker alive on their own.
  await send('Target.detachFromTarget', { sessionId: workerSession });
  for (const target of [settings, manager]) await send('Target.closeTarget', { targetId: target.targetId });
  await send('Page.navigate', {url: `${url}/empty.html`}, login.session);
  await delay(45000);
  const reopened = await page(`${origin}/src/vault-ui/vault.html`);
  const awake = (await rpc(reopened.session, 'STATUS')).data;
  assert.equal(awake.unlocked, true, 'Never must not lock when the worker would otherwise go idle');
  console.log('PASS: with auto-lock set to Never, the vault stays unlocked after 45 idle seconds with no KeyBit page open.');
  if (process.env.KEYBIT_TEST_IDLE === '1') {
    console.log('Checking the actual one-minute inactivity timer…');
    await rpc(reopened.session, 'SETTINGS', {session: awake.session, settings: {autoLockMinutes: 1}});
    await delay(61000);
    assert.equal((await rpc(reopened.session, 'STATUS')).data.unlocked, false);
    assert.equal(await evaluate(reopened.session, 'document.querySelector("#app").hidden'), true);
    console.log('PASS: inactivity locks the vault despite status polling.');
  }
  // Simulate an upgrade from 1.0 (per-site registered scripts) and an extension restart.
  await evaluate(reopened.session, `chrome.scripting.registerContentScripts([{id: 'keybit-legacy', matches: ['http://127.0.0.1/*'], js: ['src/content/save.js'], persistAcrossSessions: true}]).then(() => chrome.storage.local.set({suggestionOrigins: [${JSON.stringify(url)}]}))`);
  await evaluate(reopened.session, 'chrome.runtime.reload()').catch(() => {});
  for (let i = 0; i < 80; i++) {
    const targets = (await send('Target.getTargets')).targetInfos;
    if (targets.some(target => target.type === 'service_worker' && target.url === worker.url && target.targetId !== worker.targetId)) break;
    await delay(100);
  }
  const restarted = await page(`${origin}/src/vault-ui/vault.html`);
  await waitFor(restarted.session, '!!document.querySelector("#master-password")');
  assert.equal((await rpc(restarted.session, 'STATUS')).data.unlocked, false);
  assert.deepEqual(await evaluate(restarted.session, 'chrome.scripting.getRegisteredContentScripts().then(scripts => scripts.map(script => script.id))'), []);
  assert.equal(await evaluate(restarted.session, 'chrome.storage.local.get("suggestionOrigins").then(value => "suggestionOrigins" in value)'), false);
  await input(restarted.session, '#master-password', password);
  await evaluate(restarted.session, 'document.querySelector("#auth form").requestSubmit()');
  await waitFor(restarted.session, 'document.querySelectorAll(".login-item").length === 1');
  console.log('PASS: restart locks the vault and encrypted contents reopen with the master password.');
  console.log('PASS: 1.0 per-site scripts and site lists are cleaned up on upgrade.');
  await evaluate(restarted.session, `Promise.all([chrome.runtime.sendMessage({type:'UNLOCK',password:${JSON.stringify(password)}}),chrome.runtime.sendMessage({type:'UNLOCK',password:${JSON.stringify(password)}}),chrome.runtime.sendMessage({type:'LOCK'})])`);
  assert.equal((await rpc(restarted.session, 'STATUS')).data.unlocked, false);
  console.log('PASS: manual lock cancels in-flight and queued unlocks.');
  const unexpected = errors.filter(event => !JSON.stringify(event).includes('favicon.ico'));
  assert.deepEqual(unexpected, []);
  console.log('PASS: no captured extension JavaScript/CSP errors.');
} finally {
  await send('Browser.close').catch(() => {});
  browser.kill(); fixture.close();
  await delay(300);
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
