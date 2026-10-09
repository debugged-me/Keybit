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
const serveFixture = async (req, res) => {
  const name = basename(new URL(req.url, 'http://localhost').pathname) || 'basic-login.html';
  if (name === 'save-redirect') { req.resume(); res.writeHead(303, {Location: '/empty.html'}); res.end(); return; }
  try {
    const body = await readFile(name.startsWith('framework-') && process.env.KEYBIT_FRAMEWORK_FIXTURES ? join(process.env.KEYBIT_FRAMEWORK_FIXTURES, name) : join(root, 'tests/fixtures', name));
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(body);
  } catch { res.statusCode = 404; res.end('Not found'); }
};
const fixture = createServer(serveFixture);
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${fixture.address().port}`;
// A second loopback port is a genuinely different origin — the cross-origin iframe tests use it.
const fixture2 = createServer(serveFixture);
await new Promise(resolve => fixture2.listen(0, '127.0.0.1', resolve));
const url2 = `http://127.0.0.1:${fixture2.address().port}`;
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
// Execution contexts per session — lets tests evaluate inside a cross-origin frame's world.
const contexts = [];
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
    } else if (event.method === 'Runtime.executionContextCreated') contexts.push({ ...event.params.context, sessionId: event.sessionId });
    else if (event.method === 'Runtime.executionContextDestroyed') {
      const index = contexts.findIndex(c => c.uniqueId === event.params.executionContextUniqueId || c.id === event.params.executionContextId);
      if (index >= 0) contexts.splice(index, 1);
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
async function evaluate(sessionId, expression, contextId) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true,
    ...(contextId ? { uniqueContextId: contextId } : {}) }, sessionId);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
// The default-world context of the frame whose URL contains urlPart, on the given session.
async function frameContext(sessionId, urlPart) {
  for (let i = 0; i < 50; i++) {
    const context = contexts.find(c => c.sessionId === sessionId && c.auxData?.isDefault && c.origin === urlPart);
    if (context) return context;
    await delay(100);
  }
  throw new Error(`No execution context for ${urlPart}`);
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
async function waitFor(session, expression, contextId) {
  for (let i = 0; i < 50; i++) {
    if (await evaluate(session, expression, contextId).catch(() => false)) return;
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
  await waitFor(manager.session, 'document.querySelectorAll(".login-item").length === 1 && !document.querySelector("#login-dialog").open && document.querySelector("#detail").open');
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
  // The detail dialog makes the page inert; close it before driving the list again.
  await evaluate(manager.session, 'document.querySelector("#detail").close()');
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
  for (const [name, forms] of [['email-login', 1], ['bootstrap-login', 1], ['controlled-login', 1], ['multiple-password-fields', 0], ['empty', 0], ['dynamic-login', 0]]) {
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
  // Open Shadow DOM: fields inside an open root are detected, fill through the popup, and the
  // in-field dropdown opens once even when focus moves between shadow fields.
  await send('Page.navigate', {url: `${url}/shadow-login.html`}, login.session);
  await waitFor(login.session, `document.readyState === 'complete' && location.href === ${JSON.stringify(`${url}/shadow-login.html`)}`);
  await click(popup, '#check-page');
  await waitFor(popup, '!document.querySelector("#check-page").disabled && document.querySelector("#detection-status").textContent.startsWith("Login form detected")');
  await click(popup, '.login-item [data-action="fill"]');
  await waitFor(login.session, `document.querySelector('login-card').shadowRoot.querySelector('#pass').value === ${JSON.stringify(loginPassword)}`);
  assert.equal(await evaluate(login.session, `document.querySelector('login-card').shadowRoot.querySelector('#user').value`), credentials.username);
  await absent(PANEL);
  await evaluate(login.session, `document.querySelector('login-card').shadowRoot.querySelector('#user').focus()`);
  let shadowPanel = await frameTarget(PANEL);
  await waitFor(shadowPanel, 'document.querySelectorAll(".account").length === 1');
  // Focusing the sibling shadow field repositions the same dropdown instead of stacking another.
  await evaluate(login.session, `document.querySelector('login-card').shadowRoot.querySelector('#pass').focus()`);
  await delay(400);
  assert.equal((await send('Target.getTargets')).targetInfos.filter(t => t.url.includes(PANEL)).length, 1, 'one dropdown across shadow fields');
  await click(shadowPanel, '.account');
  await waitFor(login.session, `document.querySelector('login-card').shadowRoot.querySelector('#pass').value === ${JSON.stringify(loginPassword)}`);
  await absent(PANEL);
  // Submitting a shadow form is captured like any other: a changed password offers an update.
  await evaluate(login.session, `const r = document.querySelector('login-card').shadowRoot; r.querySelector('#user').value = ${JSON.stringify(credentials.username)}; r.querySelector('#pass').value = 'shadow-secret'`);
  await evaluate(login.session, `document.querySelector('login-card').shadowRoot.querySelector('button').click()`);
  const shadowSave = await savePanel();
  await waitFor(shadowSave, 'document.querySelector("#heading").textContent === "Update this password?"');
  await click(shadowSave, '#dismiss');
  await noSavePanel();
  console.log('PASS: open shadow root login detected, filled, deduped dropdown, and save-capture.');
  // Nested open roots: username in the outer tree, password inside an inner component.
  await send('Page.navigate', {url: `${url}/shadow-nested.html`}, login.session);
  await waitFor(login.session, `document.readyState === 'complete' && location.href === ${JSON.stringify(`${url}/shadow-nested.html`)}`);
  await click(popup, '#check-page');
  await waitFor(popup, '!document.querySelector("#check-page").disabled && document.querySelector("#detection-status").textContent.startsWith("Login form detected")');
  await click(popup, '.login-item [data-action="fill"]');
  await waitFor(login.session, `document.querySelector('login-shell').shadowRoot.querySelector('login-fields').shadowRoot.querySelector('#pass').value === ${JSON.stringify(loginPassword)}`);
  assert.equal(await evaluate(login.session, `document.querySelector('login-shell').shadowRoot.querySelector('#user').value`), credentials.username);
  console.log('PASS: nested open shadow roots fill username and password.');
  // A shadow root attached after load is detected when its field gets focus.
  await send('Page.navigate', {url: `${url}/shadow-dynamic.html`}, login.session);
  await waitFor(login.session, `document.readyState === 'complete' && location.href === ${JSON.stringify(`${url}/shadow-dynamic.html`)}`);
  await click(popup, '#check-page');
  await waitFor(popup, '!document.querySelector("#check-page").disabled && document.querySelector("#detection-status").textContent.startsWith("No login form")');
  await evaluate(login.session, `document.querySelector('#add-shadow').click()`);
  await waitFor(login.session, `!!document.querySelector('#mount').firstElementChild?.shadowRoot?.querySelector('#pass')`);
  await evaluate(login.session, `document.querySelector('#mount').firstElementChild.shadowRoot.querySelector('#user').focus()`);
  shadowPanel = await frameTarget(PANEL);
  await waitFor(shadowPanel, 'document.querySelectorAll(".account").length === 1');
  await evaluate(login.session, `document.querySelector('#mount').firstElementChild.shadowRoot.querySelector('#user').dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, composed: true}))`);
  await absent(PANEL);
  console.log('PASS: dynamically inserted open shadow root fields are detected.');
  // A closed root stays invisible: nothing detected, and a real click inside shows no dropdown.
  await send('Page.navigate', {url: `${url}/shadow-closed.html`}, login.session);
  await waitFor(login.session, `document.readyState === 'complete' && location.href === ${JSON.stringify(`${url}/shadow-closed.html`)}`);
  await click(popup, '#check-page');
  await waitFor(popup, '!document.querySelector("#check-page").disabled && document.querySelector("#detection-status").textContent.startsWith("No login form")');
  await trustedClick(login.session, 'login-card');
  await absent(PANEL);
  console.log('PASS: closed shadow roots fail safe.');
  // Same-origin iframe: the form inside the frame is detected, and the in-frame dropdown fills it.
  await send('Page.navigate', {url: `${url}/iframe-login.html`}, login.session);
  await waitFor(login.session, `document.readyState === 'complete' && location.href === ${JSON.stringify(`${url}/iframe-login.html`)} && !!document.querySelector('iframe')?.contentDocument?.querySelector('#pass')`);
  await click(popup, '#check-page');
  await waitFor(popup, '!document.querySelector("#check-page").disabled && document.querySelector("#detection-status").textContent.startsWith("Login form detected")');
  await evaluate(login.session, `document.querySelector('iframe').contentDocument.querySelector('#user').focus()`);
  let iframePanel = await frameTarget(PANEL);
  await waitFor(iframePanel, 'document.querySelectorAll(".account").length === 1');
  await click(iframePanel, '.account');
  await waitFor(login.session, `document.querySelector('iframe').contentDocument.querySelector('#pass').value === ${JSON.stringify(loginPassword)}`);
  await absent(PANEL);
  // A submit inside a frame is never captured — credential capture stays top-frame only.
  await evaluate(login.session, `document.querySelector('iframe').contentDocument.querySelector('button').click()`);
  await noSavePanel();
  console.log('PASS: same-origin iframe detected, in-frame dropdown fills, no iframe save capture.');
  // Cross-origin iframe: credentials bind to the frame's own origin, never the parent's.
  const frameLogin = { type: 'login', name: 'Frame account', urls: [`${url2}/`], username: 'iframe-user', password: 'iframe-secret', notes: '', environment: 'other', project: '', favorite: false, totp: '', history: [] };
  let frameState = (await rpc(manager.session, 'STATUS')).data;
  await rpc(manager.session, 'SAVE', { session: frameState.session, revision: frameState.revision, item: frameLogin });
  await send('Page.navigate', { url: `${url}/iframe-cross.html?child=${encodeURIComponent(`${url2}/basic-login.html`)}` }, login.session);
  await waitFor(login.session, `document.readyState === 'complete' && document.querySelector('#child')?.src === ${JSON.stringify(`${url2}/basic-login.html`)}`);
  const crossCtx = (await frameContext(login.session, url2)).uniqueId;
  for (let i = 0; i < 50; i++) {
    if (await evaluate(login.session, `document.readyState === 'complete' && !!document.querySelector('#pass')`, crossCtx).catch(() => false)) break;
    await delay(100);
    if (i === 49) throw new Error('cross-origin iframe did not load');
  }
  await click(popup, '#check-page');
  await waitFor(popup, '!document.querySelector("#check-page").disabled && document.querySelector("#detection-status").textContent.startsWith("Login form detected")');
  const crossTab = await evaluate(manager.session, `chrome.tabs.query({url: 'http://127.0.0.1/*'}).then(tabs => tabs.find(tab => tab.url?.includes('iframe-cross'))?.id)`);
  const frameId2 = (await rpc(manager.session, 'LIST', { session: frameState.session, query: 'iframe-user' })).data[0].id;
  // The popup is bound to the parent page's origin — the iframe-origin login cannot fill "the page".
  const denied = await rpc(manager.session, 'FILL', { session: frameState.session, id: frameId2, tabId: crossTab, url: `${url}/iframe-cross.html` });
  assert.equal(denied.ok, false);
  // Inside the iframe, only its own origin's logins are offered — never the parent's accounts.
  await evaluate(login.session, `document.querySelector('#user').focus()`, crossCtx);
  iframePanel = await frameTarget(PANEL);
  await waitFor(iframePanel, 'document.querySelectorAll(".account").length === 1');
  assert.equal(await evaluate(iframePanel, 'document.body.textContent.includes("iframe-user")'), true);
  assert.equal(await evaluate(iframePanel, 'document.body.textContent.includes("Edited production")'), false);
  await click(iframePanel, '.account');
  await waitFor(login.session, `document.querySelector('#pass').value === 'iframe-secret'`, crossCtx);
  assert.equal(await evaluate(login.session, `document.querySelector('#user').value`, crossCtx), 'iframe-user');
  await absent(PANEL);
  // A frame that navigates away, then one that is removed, can never receive a fill.
  await evaluate(login.session, `document.querySelector('#child').src = ${JSON.stringify(`${url2}/empty.html`)}`);
  await waitFor(login.session, `document.querySelector('#child')?.src === ${JSON.stringify(`${url2}/empty.html`)}`);
  await delay(500);
  let stale = await rpc(manager.session, 'FILL', { session: frameState.session, id: frameId2, tabId: crossTab, url: `${url2}/empty.html` });
  assert.equal(stale.ok, false);
  await evaluate(login.session, `document.querySelector('#child').remove()`);
  await delay(500);
  stale = await rpc(manager.session, 'FILL', { session: frameState.session, id: frameId2, tabId: crossTab, url: `${url2}/empty.html` });
  assert.equal(stale.ok, false);
  await rpc(manager.session, 'PURGE', { session: frameState.session, revision: (await rpc(manager.session, 'STATUS')).data.revision, id: frameId2 });
  console.log('PASS: cross-origin iframe binds to its own origin; parent logins hidden; removed/navigated frames refuse fills.');
  // Developer Form Inspector: a per-frame structural report — field metadata and deterministic
  // recommendations, never values.
  const inspectPage = async pageUrl => {
    // background:true — a foreground tab would blur the popup and close it mid-suite.
    const { targetId } = await send('Target.createTarget', { url: `${origin}/src/developer/inspector.html?url=${encodeURIComponent(pageUrl)}`, background: true });
    const session = await attach(targetId);
    const inspector = { targetId, session };
    await waitFor(inspector.session, `document.querySelector("#page-url").textContent === ${JSON.stringify(pageUrl)}`);
    await waitFor(inspector.session, '!!document.querySelector(".frame-card")');
    return inspector;
  };
  const bodyText = session => evaluate(session, 'document.body.textContent');
  await send('Page.navigate', {url: `${url}/basic-login.html`}, login.session);
  await waitFor(login.session, `document.readyState === 'complete' && location.href === ${JSON.stringify(`${url}/basic-login.html`)}`);
  // Fill the real fields first: the report must still contain no credential material.
  await evaluate(login.session, `document.querySelector('#pass').value = ${JSON.stringify(loginPassword)}; document.querySelector('#user').value = 'typed-user'`);
  let inspector = await inspectPage(`${url}/basic-login.html`);
  await waitFor(inspector.session, `document.querySelector(".frame-summary")?.textContent.includes("1 login form")`);
  let report = await bodyText(inspector.session);
  assert.ok(report.includes('autocomplete=current-password') && report.includes('autocomplete=username'), 'inspector shows autocomplete metadata');
  assert.ok(report.includes('password') && report.includes('username'), 'inspector names detected roles');
  assert.ok(!report.includes(loginPassword) && !report.includes('typed-user'), 'report carries no field values');
  await send('Target.closeTarget', {targetId: inspector.targetId});
  await send('Page.navigate', {url: `${url}/no-autocomplete.html`}, login.session);
  await waitFor(login.session, 'document.readyState === "complete"');
  inspector = await inspectPage(`${url}/no-autocomplete.html`);
  await waitFor(inspector.session, `document.querySelector(".recommendations")?.textContent.includes('Add autocomplete="current-password"')`);
  await send('Target.closeTarget', {targetId: inspector.targetId});
  await send('Page.navigate', {url: `${url}/readonly-login.html`}, login.session);
  await waitFor(login.session, 'document.readyState === "complete"');
  inspector = await inspectPage(`${url}/readonly-login.html`);
  await waitFor(inspector.session, `document.querySelector(".issues")?.textContent.includes("readonly")`);
  await send('Target.closeTarget', {targetId: inspector.targetId});
  await send('Page.navigate', {url: `${url}/shadow-login.html`}, login.session);
  await waitFor(login.session, 'document.readyState === "complete"');
  inspector = await inspectPage(`${url}/shadow-login.html`);
  await waitFor(inspector.session, `document.querySelector(".badge.info")?.textContent === "Shadow DOM" && document.querySelector(".frame-summary")?.textContent.includes("1 login form")`);
  await send('Target.closeTarget', {targetId: inspector.targetId});
  await send('Page.navigate', { url: `${url}/iframe-cross.html?child=${encodeURIComponent(`${url2}/basic-login.html`)}` }, login.session);
  await waitFor(login.session, `document.readyState === 'complete' && document.querySelector('#child')?.src === ${JSON.stringify(`${url2}/basic-login.html`)}`);
  for (let i = 0; i < 50; i++) {
    const ctx = await frameContext(login.session, url2).catch(() => null);
    if (ctx && await evaluate(login.session, 'document.readyState === "complete"', ctx.uniqueId).catch(() => false)) break;
    await delay(100);
    if (i === 49) throw new Error('cross-origin iframe did not reload');
  }
  inspector = await inspectPage(`${url}/iframe-cross.html?child=${encodeURIComponent(`${url2}/basic-login.html`)}`);
  await waitFor(inspector.session, `document.querySelectorAll(".frame-card").length === 2 && document.querySelector(".badge.warn")?.textContent === "cross-origin"`);
  report = await bodyText(inspector.session);
  assert.ok(report.includes(url2) && report.includes('Embedded frame'), 'inspector lists the cross-origin frame by its own origin');
  await send('Target.closeTarget', {targetId: inspector.targetId});
  await send('Page.navigate', {url: `${url}/shadow-closed.html`}, login.session);
  await waitFor(login.session, 'document.readyState === "complete"');
  inspector = await inspectPage(`${url}/shadow-closed.html`);
  await waitFor(inspector.session, `document.querySelector(".frame-summary")?.textContent.includes("No fillable forms detected")`);
  await send('Target.closeTarget', {targetId: inspector.targetId});
  await send('Page.navigate', {url: `${url}/otp.html`}, login.session);
  await waitFor(login.session, 'document.readyState === "complete"');
  inspector = await inspectPage(`${url}/otp.html`);
  await waitFor(inspector.session, `document.body.textContent.includes("One-time code input detected")`);
  await send('Target.closeTarget', {targetId: inspector.targetId});
  console.log('PASS: form inspector reports per-frame structure, hints, issues — and no secret values.');
  // Project Environment Switcher: chips on a project login move the tab between the project's
  // addresses, preserving path/query/hash, and production asks first.
  const demoProd = { type: 'login', name: 'Demo prod', urls: [`${url}/`], username: 'prod-user', password: 'prod-secret', notes: '', environment: 'production', project: 'Demo', favorite: false, totp: '', history: [] };
  const demoStage = { ...demoProd, name: 'Demo staging', username: 'stage-user', password: 'stage-secret', urls: [`${url2}/`], environment: 'staging' };
  let envState = (await rpc(manager.session, 'STATUS')).data;
  await rpc(manager.session, 'SAVE', { session: envState.session, revision: envState.revision, item: demoProd });
  envState = (await rpc(manager.session, 'STATUS')).data;
  await rpc(manager.session, 'SAVE', { session: envState.session, revision: envState.revision, item: demoStage });
  await send('Page.navigate', {url: `${url}/basic-login.html`}, login.session);
  await waitFor(login.session, `document.readyState === 'complete' && location.href === ${JSON.stringify(`${url}/basic-login.html`)}`);
  await send('Target.activateTarget', { targetId: login.targetId });
  await click(popup, '#check-page');
  await waitFor(popup, '!document.querySelector("#check-page").disabled');
  await waitFor(popup, 'document.querySelectorAll("#matches .env-chip").length === 2');
  // The current environment is the one the page is on — production here.
  assert.equal(await evaluate(popup, `document.querySelector('.env-chip[data-env="production"]')?.getAttribute("aria-pressed")`), 'true');
  assert.equal(await evaluate(popup, `document.querySelector('.env-chip[data-env="production"]')?.textContent`), '⚠ production');
  // Switching to staging keeps the path on the new origin.
  await click(popup, '.env-chip[data-env="staging"]');
  await waitFor(login.session, `location.href === ${JSON.stringify(`${url2}/basic-login.html`)}`);
  await click(popup, '#check-page');
  await waitFor(popup, `document.querySelector('.env-chip[data-env="staging"]')?.getAttribute("aria-pressed") === "true"`);
  // Production asks first: one press arms the chip, a second press navigates.
  await click(popup, '.env-chip[data-env="production"]');
  await delay(300);
  assert.equal(await evaluate(login.session, 'location.href'), `${url2}/basic-login.html`);
  assert.equal(await evaluate(popup, `document.querySelector('.env-chip[data-env="production"]').textContent`), 'Open production?');
  await click(popup, '.env-chip[data-env="production"]');
  await waitFor(login.session, `location.href === ${JSON.stringify(`${url}/basic-login.html`)}`);
  // Vault-side: the project view edits the environment map.
  await evaluate(manager.session, `document.querySelector('[data-view="project:Demo"]').click()`);
  await waitFor(manager.session, `!document.querySelector("#env-editor").hidden && document.querySelectorAll("#env-editor .env-row").length >= 2`);
  const stageInput = await evaluate(manager.session, `document.querySelector('#env-editor input[aria-label="staging address"]').value`);
  assert.equal(stageInput, `${url2}/`);
  await evaluate(manager.session, `document.querySelector('[data-view="logins"]').click()`);
  console.log('PASS: environment switcher preserves path, marks and confirms production, project editor round-trips.');
  // Command palette: the same tab message the keyboard shortcut sends opens an overlay iframe whose
  // document is the extension's palette page — driven here through its own execution context.
  const paletteTab = await evaluate(manager.session, `chrome.tabs.query({url: 'http://127.0.0.1/*'}).then(tabs => tabs.find(tab => tab.url?.includes('basic-login'))?.id)`);
  // The palette iframe is inside a closed shadow root, so it is invisible to page queries — but the
  // iframe is a real target, attachable exactly like the inline suggestion panel.
  async function paletteOpen() {
    await evaluate(manager.session, `chrome.tabs.sendMessage(${paletteTab}, {event: 'keybit-palette'}, {frameId: 0})`);
    return frameTarget('/src/command/palette.html#');
  }
  await send('Target.activateTarget', { targetId: login.targetId });
  let palette = await paletteOpen();
  await waitFor(palette, 'document.querySelectorAll("#results .row").length >= 6');
  let rows = await evaluate(palette, `[...document.querySelectorAll("#results .row .label")].map(row => row.textContent)`);
  assert.ok(rows.some(label => label.includes('Fill Edited production')), 'palette offers the matching login');
  assert.ok(rows.some(label => label.includes('Switch Demo to staging')), 'palette offers environment switches');
  assert.ok(rows.some(label => label.includes('Lock KeyBit')) && rows.some(label => label.includes('Inspect login form')), 'fixed commands present');
  // The page sits on the Demo production address — that environment is never offered as a switch.
  assert.ok(!rows.some(label => label.includes('Switch Demo to production')), 'the current environment is excluded');
  // Arrow keys move the selection; typing filters through the fuzzy matcher.
  await evaluate(palette, `document.querySelector("#query").dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowDown"}))`);
  assert.equal(await evaluate(palette, `document.querySelectorAll("#results .row")[1]?.getAttribute("aria-selected")`), 'true');
  await evaluate(palette, `document.querySelector("#query").value = "staging"; document.querySelector("#query").dispatchEvent(new Event("input"))`);
  await waitFor(palette, `[...document.querySelectorAll("#results .row .label")].some(row => row.textContent.includes("Switch Demo to staging"))`);
  // Escape closes the overlay outright.
  await evaluate(palette, `document.querySelector("#query").dispatchEvent(new KeyboardEvent("keydown", {key: "Escape"}))`);
  await waitFor(login.session, `!document.querySelector('[data-keybit="palette"]')`);
  // A fill command runs the same origin-bound fill path as the popup.
  palette = await paletteOpen();
  await waitFor(palette, `document.querySelectorAll("#results .row").length >= 6`);
  await evaluate(palette, `[...document.querySelectorAll("#results .row")].find(row => row.textContent.includes("Fill Edited production")).click()`);
  await waitFor(login.session, `document.querySelector('#user').value === 'test-user@example.test' && document.querySelector('#pass').value.length > 0`);
  await waitFor(login.session, `!document.querySelector('[data-keybit="palette"]')`);
  // Locked: only non-secret commands, and no vault names anywhere in the page.
  await rpc(manager.session, 'LOCK');
  palette = await paletteOpen();
  await waitFor(palette, `document.querySelectorAll("#results .row").length === 3`);
  rows = await evaluate(palette, `[...document.querySelectorAll("#results .row .label")].map(row => row.textContent)`);
  assert.deepEqual(rows.sort(), ['Inspect login form', 'Open KeyBit', 'Unlock KeyBit']);
  await evaluate(palette, `document.querySelector("#query").value = "demo prod test"; document.querySelector("#query").dispatchEvent(new Event("input"))`);
  await delay(300);
  const lockedText = await evaluate(palette, 'document.body.textContent');
  assert.ok(!/Test production|Demo|test-user/i.test(lockedText), 'locked palette leaks no vault metadata');
  await evaluate(palette, `document.querySelector("#query").dispatchEvent(new KeyboardEvent("keydown", {key: "Escape"}))`);
  await waitFor(login.session, `!document.querySelector('[data-keybit="palette"]')`);
  const unlockState = (await rpc(manager.session, 'UNLOCK', { password })).data;
  assert.ok(unlockState.session);
  console.log('PASS: command palette lists, filters, marks production, fills on-site, and leaks nothing while locked.');
  // Remove the demo project logins and re-anchor the popup on the page, so later counts hold.
  envState = (await rpc(manager.session, 'STATUS')).data;
  for (const item of (await rpc(manager.session, 'LIST', { session: envState.session, query: 'Demo' })).data) {
    envState = (await rpc(manager.session, 'PURGE', { session: envState.session, revision: envState.revision, id: item.id })).data;
  }
  await click(popup, '#check-page');
  await waitFor(popup, '!document.querySelector("#check-page").disabled');
  await waitFor(popup, 'document.querySelectorAll("#matches .login-item").length === 1');
  // The site card exposes the per-site rules editor.
  await waitFor(popup, '!document.querySelector("#site-rules-toggle").hidden');
  await click(popup, '#site-rules-toggle');
  await waitFor(popup, 'document.querySelectorAll("#site-rules [data-rule]").length === 7');
  await click(popup, '#site-rules-toggle');
  await waitFor(login.session, `document.readyState === 'complete' && location.href === ${JSON.stringify(`${url}/basic-login.html`)}`);
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
  await rpc(popup, 'PURGE', {session: popupState.session, revision: popupState.revision, id: popupAdded.id});
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
  assert.deepEqual((await rpc(popup, 'DISABLED_SITES')).data, []);
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
  // A site can still be switched off through the Sites turned off list (or the per-site API);
  // with it off, no dropdown appears, and turning it back on restores it.
  async function openPopup() {
    await send('Extensions.triggerAction', { id, targetId: loginTab.targetId });
    const session = await frameTarget('/src/popup/popup.html');
    await waitFor(session, '!!document.querySelector("#site-name")');
    return session;
  }
  let sitePopup = await openPopup();
  await rpc(sitePopup, 'SET_SITE_ENABLED', { origin: url, enabled: false });
  assert.deepEqual((await rpc(sitePopup, 'DISABLED_SITES')).data, [url]);
  await evaluate(sitePopup, 'window.close()');
  await send('Target.activateTarget', { targetId: login.targetId });
  await evaluate(login.session, 'document.querySelector("#user").blur(); document.querySelector("#user").focus()');
  await absent(PANEL);
  await trustedClick(login.session, '#user');
  await absent(PANEL);
  sitePopup = await openPopup();
  await rpc(sitePopup, 'SET_SITE_ENABLED', { origin: url, enabled: true });
  assert.deepEqual((await rpc(sitePopup, 'DISABLED_SITES')).data, []);
  await evaluate(sitePopup, 'window.close()');
  await send('Target.activateTarget', { targetId: login.targetId });
  await evaluate(login.session, 'document.querySelector("#user").blur(); document.querySelector("#user").focus()');
  const keyboardPanel = await frameTarget(PANEL);
  await waitFor(keyboardPanel, 'document.querySelectorAll(".account").length === 1');
  console.log('PASS: a site can be turned off and back on, and the dropdown follows.');
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
  // Per-site rules: individual offers turn off without disabling the site for everything else.
  await rpc(manager.session, 'SET_SITE_RULE', { origin: url, patch: { logins: false } });
  assert.equal((await rpc(manager.session, 'SITE_RULE', { origin: url })).data.logins, false);
  await evaluate(login.session, 'document.querySelector("#user").blur(); document.querySelector("#user").focus()');
  await absent(PANEL);
  // The Site rules view lists the customized origin and Reset restores defaults.
  await click(manager.session, '[data-view="sites"]');
  await waitFor(manager.session, `document.querySelector('#disabled-sites .rule-card')?.textContent.includes(${JSON.stringify(url)})`);
  await evaluate(manager.session, 'document.querySelector("#disabled-sites .rule-card .text-button").click()');
  await waitFor(manager.session, 'document.querySelector("#nav-sites").hidden');
  await click(manager.session, '[data-view="logins"]');
  assert.deepEqual((await rpc(manager.session, 'SITE_RULES')).data, {});
  // "Offer to save" off: a real sign-in submit produces no prompt, while fills keep working.
  await rpc(manager.session, 'SET_SITE_RULE', { origin: url, patch: { save: false } });
  await input(login.session, '#pass', 'a-different-secret');
  await click(login.session, 'button');
  await waitFor(login.session, 'window.fixtureEvents.submit === 1');
  await absent('/src/inline/save.html#');
  await rpc(manager.session, 'SET_SITE_RULE', { origin: url, patch: { save: true } });
  await send('Page.navigate', { url: `${url}/basic-login.html` }, login.session);
  await waitFor(login.session, `document.readyState === 'complete' && location.href === ${JSON.stringify(`${url}/basic-login.html`)}`);
  await evaluate(login.session, 'document.querySelector("#user").focus()');
  const rulesPanel = await frameTarget(PANEL);
  await waitFor(rulesPanel, 'document.querySelectorAll(".account").length === 1');
  console.log('PASS: per-site rules gate logins/save offers, list in the vault, and reset to defaults.');
  // Context menu (worker→page path; the real menu click can't be synthesized): a contextmenu event
  // records the field, then the same messages the onClicked handler sends act on it.
  await evaluate(login.session, `document.querySelector("#user").dispatchEvent(new MouseEvent("contextmenu", {bubbles: true, composed: true}))`);
  await evaluate(manager.session, `chrome.tabs.query({url: 'http://*/*'}).then(tabs => chrome.tabs.sendMessage(tabs.find(t => t.url?.includes('basic-login'))?.id, {event: 'keybit-context-fill'}, {frameId: 0}))`);
  const menuPanel = await frameTarget(PANEL);
  await waitFor(menuPanel, 'document.querySelectorAll(".account").length === 1');
  await evaluate(login.session, `document.querySelector("#user").dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true, composed: true}))`);
  await absent(PANEL);
  await send('Page.navigate', {url: `${url}/signup.html`}, login.session);
  await waitFor(login.session, `document.readyState === 'complete' && location.href === ${JSON.stringify(`${url}/signup.html`)}`);
  await evaluate(login.session, `document.querySelector("#new").dispatchEvent(new MouseEvent("contextmenu", {bubbles: true, composed: true}))`);
  await evaluate(manager.session, `chrome.tabs.query({url: 'http://*/*'}).then(tabs => chrome.tabs.sendMessage(tabs.find(t => t.url?.includes('signup'))?.id, {event: 'keybit-context-generate'}, {frameId: 0}))`);
  await waitFor(login.session, 'document.querySelector("#new").value.length === 20 && document.querySelector("#confirm").value === document.querySelector("#new").value');
  await absent(PANEL);
  // The note item: the worker parks the selection in storage.session; a fresh #new-note page prefills it.
  await evaluate(manager.session, `chrome.storage.session.set({"pending-note": "a selected sentence"})`);
  await evaluate(manager.session, `location.hash = "#new-note"`);
  await send('Page.reload', {}, manager.session);
  await waitFor(manager.session, 'document.querySelector("#login-dialog")?.open === true && document.querySelector("#notes").value === "a selected sentence"');
  await click(manager.session, '#cancel');
  await click(manager.session, '[data-view="logins"]');
  await waitFor(manager.session, 'document.querySelectorAll(".login-item").length >= 1');
  console.log('PASS: context-menu fill and generate act on the right-clicked field; save-as-note prefills the editor.');
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
  await rpc(manager.session, 'PURGE', {session: signupState.session, revision: signupState.revision, id: signedUp.id});
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
  await evaluate(manager.session, 'document.querySelector("#detail").close()');
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
  await evaluate(manager.session, 'document.querySelector("#detail").close()');
  await click(manager.session, '[data-view="health"]');
  await waitFor(manager.session, '!document.querySelector("#view-health").hidden && document.querySelectorAll("#health-list .login-item").length === 1');
  // Security Center: the score explains itself and every metric tile renders.
  await waitFor(manager.session, '/\\d+%/.test(document.querySelector("#health-score-big").textContent) ' +
    '&& document.querySelectorAll("#health-factors li").length >= 1 ' +
    '&& document.querySelectorAll("#health-metrics .metric").length >= 10');
  const factorText = await evaluate(manager.session, 'document.querySelector("#health-factors").textContent');
  assert.ok(/weak passwords/.test(factorText), 'The weak-password factor explains the score');
  await shot(manager.session, 'health');
  await click(manager.session, '#health-list .login-item');
  await waitFor(manager.session, '!document.querySelector("#view-logins").hidden && !!document.querySelector(".warning.weak")');
  captureState = (await rpc(manager.session, 'STATUS')).data;
  const weak = (await rpc(manager.session, 'LIST', {session: captureState.session, query: 'Weak one'})).data[0];
  captureState = (await rpc(manager.session, 'PURGE', {session: captureState.session, revision: captureState.revision, id: weak.id})).data;
  await rpc(manager.session, 'PURGE', {session: captureState.session, revision: captureState.revision, id: captured.id});
  console.log('PASS: password history restore, weak passwords flagged, and the Security Center explains its score.');
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
  await rpc(settings.session, 'PURGE', {session: bumped.session, revision: bumped.revision, id: bump.id});
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
  await waitFor(settings.session, 'document.querySelector("#detail").open');
  assert.equal(await evaluate(settings.session, 'document.documentElement.scrollWidth <= innerWidth'), true, await evaluate(settings.session, overflow));
  await shotBoth([settings.session], 'app-narrow-detail');
  await click(settings.session, '.back-button');
  await waitFor(settings.session, '!document.querySelector("#detail").open');
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
  browser.kill(); fixture.close(); fixture2.close();
  await delay(300);
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
