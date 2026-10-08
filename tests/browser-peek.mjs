// Real-click regression checks in an isolated Helium/Chromium profile; no personal browser data.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, root, delay } from './cdp.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'keybit-peek-'));
let external;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('Content-Type', 'text/html');
  if (path === '/denied') res.setHeader('X-Frame-Options', 'DENY');
  if (path === '/restricted') res.setHeader('Content-Security-Policy', "frame-src 'self'");
  if (path === '/preview' || path === '/denied' || path === '/slow') {
    const body = '<!doctype html><html><head><title>Destination preview</title><style>body{font:18px system-ui;padding:40px;background:#f6faf9;color:#193a31}button{padding:14px}</style></head><body><h1>Destination preview</h1><p>The original page stays underneath.</p><button id="inside">Focus inside preview</button></body></html>';
    if (path === '/slow') setTimeout(() => res.end(body), 1200); else res.end(body);
    return;
  }
  res.end(`<!doctype html><html><head><title>Peek click fixture</title><style>
    body{font:16px system-ui;margin:0;background:#eef2f6;color:#20302e;min-height:1500px} main{margin:50px auto;width:80%;max-width:1000px}
    .card{background:white;border-radius:18px;padding:24px;margin:20px 0} a,button{display:inline-block;margin:6px;padding:10px;color:#215d50}h1{font-size:28px}
    </style></head><body><main><h1>Messages and links</h1><p>Site controls stay normal. Outbound links open above this page.</p>
    <section class="card"><button data-native id="button">Ordinary button</button><a data-native id="internal" href="/profile">Profile</a>
    <a data-native id="hash" href="#comments">Comments</a><a data-native id="role" role="button" href="${external}/preview">Menu trigger</a>
    <a data-native id="expand-control" aria-expanded="false" href="${external}/preview">Expand comments</a>
    <a data-native id="inline" onclick="return false" href="${external}/preview">Inline control</a>
    <nav><a data-native id="nav" href="${external}/preview">Navigation</a></nav>
    <a data-native id="download" download href="${external}/preview">Download</a>
    <a data-native id="nested" href="${external}/preview"><button id="nested-button" data-native>Nested control</button></a></section>
    <section class="card"><a id="external" href="${external}/preview" target="_blank"><span id="external-child">Preview an external link</span></a>
    <a id="wrapped" href="https://l.facebook.com/l.php?u=${encodeURIComponent(`${external}/preview`)}&h=tracking">Facebook wrapped link</a>
    <a id="blocked" href="${external}/denied">Blocked destination</a><a id="slow" href="${external}/slow">Slow destination</a><div id="shadow-link"></div></section></main>
    <script>window.nativeClicks=[];document.addEventListener('click',event=>{const control=event.target.closest('[data-native]');if(control){event.preventDefault();nativeClicks.push(control.id)}});
    document.querySelector('#shadow-link').attachShadow({mode:'open'}).innerHTML='<a href="${external}/preview">Shadow link</a>';</script></body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
external = `http://localhost:${server.address().port}`;
const browser = await launch();
const { send, evaluate, waitFor, page, trustedClick, key } = browser;
const rpc = (session, type, args = {}) => evaluate(session, `chrome.runtime.sendMessage(${JSON.stringify({ type, ...args })})`);
const findHost = node => {
  if (node.attributes?.some((value, index) => index % 2 === 0 && value === 'id' && node.attributes[index + 1] === 'keybit-peek-host')) return node;
  for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) { const found = findHost(child); if (found) return found; }
  return null;
};
async function shadowEval(session, expression) {
  const { root: doc } = await send('DOM.getDocument', { depth: -1, pierce: true }, session);
  const host = findHost(doc);
  assert.ok(host?.shadowRoots?.[0], 'Preview has a shadow root');
  const { object } = await send('DOM.resolveNode', { nodeId: host.shadowRoots[0].nodeId }, session);
  try {
    const result = await send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: `function() { return (${expression}); }`, returnByValue: true }, session);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  } finally { await send('Runtime.releaseObject', { objectId: object.objectId }, session); }
}
async function mouse(session, point, modifiers = 0) {
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1, modifiers }, session);
}
const shadowClick = async (session, selector) => mouse(session, await shadowEval(session, `(() => { const r = this.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2 }; })()`));
async function waitShadow(session, expression) {
  for (let i = 0; i < 60; i++) { if (await shadowEval(session, expression).catch(() => false)) return; await delay(100); }
  throw new Error(`Preview condition failed: ${expression}`);
}
const closed = session => waitFor(session, '!document.querySelector("#keybit-peek-host")');
const clickWithModifier = async (session, selector, modifiers) => mouse(session, await evaluate(session, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`), modifiers);

console.log('Peek browser artifacts:', scratch);
try {
  await browser.developerMode();
  const { id } = await browser.loadExtension(root);
  const app = await page(`chrome-extension://${id}/src/vault-ui/vault.html`);
  const defaults = (await rpc(app.session, 'PEEK_GET_SETTINGS')).data;
  assert.equal(defaults.peekTrigger, 'click');
  // Reproduce an existing install that had selected a floating window before this fix.
  await evaluate(app.session, `chrome.storage.local.set({peek:{...${JSON.stringify(defaults)},peekMode:'window'}})`);
  const source = await page(`${base}/fixture`);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }, source.session);
  await delay(300);
  const windowsBefore = await evaluate(app.session, 'chrome.windows.getAll().then(windows=>windows.length)');
  const tabsBefore = await evaluate(app.session, 'chrome.tabs.query({}).then(tabs=>tabs.length)');
  for (const selector of ['#button', '#internal', '#hash', '#role', '#expand-control', '#inline', '#nav', '#download', '#nested-button']) {
    await trustedClick(source.session, selector);
    assert.equal(await evaluate(source.session, '!!document.querySelector("#keybit-peek-host")'), false, selector);
  }
  assert.equal(await evaluate(source.session, 'nativeClicks.length'), 9);
  await evaluate(source.session, 'document.querySelector("#external").click()');
  assert.equal(await evaluate(source.session, '!!document.querySelector("#keybit-peek-host")'), false, 'Synthetic clicks stay native');
  // The synthetic target=_blank click belongs to the page, so close that native tab.
  await evaluate(app.session, `chrome.tabs.query({url:${JSON.stringify(`${external}/preview`)}}).then(tabs=>Promise.all(tabs.map(tab=>chrome.tabs.remove(tab.id))))`);
  console.log('PASS: buttons, controls, internal links, navigation, downloads, and synthetic clicks are not intercepted.');

  await send('Target.activateTarget', { targetId: source.targetId });
  await trustedClick(source.session, '#external-child');
  await waitShadow(source.session, 'this.querySelector(".kb-peek-loading").hidden');
  await delay(2000); // Wait past the handshake timeout to verify the real frame acknowledged.
  assert.equal(await shadowEval(source.session, 'this.querySelector(".kb-peek-notice").hidden'), true);
  assert.equal(await shadowEval(source.session, 'getComputedStyle(this.querySelector(".kb-peek-loading")).display'), 'none');
  assert.equal(await shadowEval(source.session, 'getComputedStyle(this.querySelector(".kb-peek-fallback")).display'), 'none');
  assert.equal(await shadowEval(source.session, 'this.querySelector("iframe").src'), `${external}/preview`);
  assert.equal(await evaluate(app.session, 'chrome.windows.getAll().then(windows=>windows.length)'), windowsBefore);
  assert.equal(await evaluate(app.session, 'chrome.tabs.query({}).then(tabs=>tabs.length)'), tabsBefore);
  assert.equal(await evaluate(source.session, 'location.href'), `${base}/fixture`);
  await browser.shot(source.session, join(scratch, 'peek-desktop.png'));
  const bounds = await shadowEval(source.session, 'this.querySelector(".kb-peek-window").getBoundingClientRect().toJSON()');
  await key(source.session, 'Tab', 9);
  assert.equal(await shadowEval(source.session, 'this.activeElement === this.querySelector(".kb-peek-expand") && getComputedStyle(this.activeElement).outlineWidth === "3px"'), true);
  assert.deepEqual(await shadowEval(source.session, 'this.querySelector(".kb-peek-window").getBoundingClientRect().toJSON()'), bounds, 'Keyboard focus does not move the preview');
  await delay(350);
  await browser.shot(source.session, join(scratch, 'peek-keyboard-focus.png'));
  const normalWidth = await shadowEval(source.session, 'this.querySelector(".kb-peek-window").getBoundingClientRect().width');
  await shadowClick(source.session, '.kb-peek-expand');
  await waitShadow(source.session, '!this.querySelector(".kb-peek-window").getAnimations().some(animation => animation.playState === "running")');
  assert.ok(await shadowEval(source.session, 'this.querySelector(".kb-peek-window").getBoundingClientRect().width') > normalWidth);
  await shadowClick(source.session, '.kb-peek-expand');
  await waitShadow(source.session, '!this.querySelector(".kb-peek-window").getAnimations().some(animation => animation.playState === "running")');
  assert.equal(await shadowEval(source.session, 'this.querySelector(".kb-peek-window").getBoundingClientRect().width'), normalWidth);
  // The live page remains visible throughout close, avoiding a white flash before removal.
  await shadowClick(source.session, '.kb-peek-close');
  assert.equal(await shadowEval(source.session, '!!this.querySelector("iframe")'), true);
  await closed(source.session);
  assert.equal(await evaluate(source.session, 'document.documentElement.style.overflow'), '');
  assert.equal(await evaluate(source.session, 'document.activeElement.id'), 'external');
  console.log('PASS: old window settings now show an in-page preview, loading clears, expand stays in page, and close restores focus/scrolling.');

  await trustedClick(source.session, '#slow');
  await waitShadow(source.session, '!this.querySelector(".kb-peek-loading").hidden');
  await delay(280);
  await browser.shot(source.session, join(scratch, 'peek-loading.png'));
  await waitShadow(source.session, 'this.querySelector(".kb-peek-loading").hidden');
  const hoverPoint = await shadowEval(source.session, '(() => {const r=this.querySelector(".kb-peek-open-tab").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...hoverPoint }, source.session);
  await delay(450);
  assert.equal(await shadowEval(source.session, 'getComputedStyle(this.querySelector(".kb-peek-open-tab"), "::after").opacity'), '1');
  await browser.shot(source.session, join(scratch, 'peek-hover.png'));
  await shadowClick(source.session, '.kb-peek-close'); await closed(source.session);

  await trustedClick(source.session, '#wrapped');
  await waitShadow(source.session, 'this.querySelector(".kb-peek-loading").hidden');
  assert.equal(await shadowEval(source.session, 'this.querySelector("iframe").src'), `${external}/preview`);
  await delay(150);
  // Focus the embedded document, then send a real Escape key to its active frame.
  await shadowClick(source.session, 'iframe');
  await key(source.session, 'Escape', 27);
  await closed(source.session);
  console.log('PASS: Facebook redirect links resolve to their destination; Escape works from inside the preview.');

  await trustedClick(source.session, '#blocked');
  await waitShadow(source.session, '!this.querySelector(".kb-peek-notice").hidden');
  assert.equal(await evaluate(app.session, 'chrome.windows.getAll().then(windows=>windows.length)'), windowsBefore);
  assert.equal(await evaluate(app.session, 'chrome.tabs.query({}).then(tabs=>tabs.length)'), tabsBefore);
  await browser.shot(source.session, join(scratch, 'peek-blocked.png'));
  await shadowClick(source.session, '.kb-peek-close');
  await closed(source.session);
  const restricted = await page(`${base}/restricted`);
  await trustedClick(restricted.session, '#external');
  await waitShadow(restricted.session, 'this.querySelector(".kb-peek-loading").hidden');
  await delay(2000);
  // Some Chromium versions exempt an isolated-world frame insertion from the parent's CSP.
  // If enforced, show the fallback; if exempted, the real document must acknowledge readiness.
  assert.equal(await shadowEval(restricted.session, '!this.querySelector(".kb-peek-fallback").hidden || this.querySelector(".kb-peek-notice").hidden'), true);
  await shadowClick(restricted.session, '.kb-peek-close');
  await closed(restricted.session);
  await send('Target.closeTarget', { targetId: restricted.targetId });
  console.log('PASS: destination and parent embedding restrictions keep the source page and never open another window/tab.');

  // Explicit triggers still allow same-site links, and changing settings updates the open page.
  await rpc(app.session, 'PEEK_SAVE_SETTINGS', { settings: { ...defaults, peekTrigger: 'shift-click' } });
  await delay(150);
  await clickWithModifier(source.session, '#internal', 8);
  await waitShadow(source.session, 'this.querySelector("iframe").src.endsWith("/profile")');
  await key(source.session, 'Escape', 27); await closed(source.session);
  await rpc(app.session, 'PEEK_SAVE_SETTINGS', { settings: defaults });
  await delay(150);
  await clickWithModifier(source.session, '#external', process.platform === 'darwin' ? 4 : 2); // Cmd/Ctrl+Click stays native.
  await waitFor(app.session, `chrome.tabs.query({}).then(tabs=>tabs.length===${tabsBefore + 1})`);
  assert.equal(await evaluate(source.session, '!!document.querySelector("#keybit-peek-host")'), false);
  await evaluate(app.session, `chrome.tabs.query({url:${JSON.stringify(`${external}/preview`)}}).then(tabs=>Promise.all(tabs.map(tab=>chrome.tabs.remove(tab.id))))`);
  console.log('PASS: explicit Shift+Click previews internal links; Cmd/Ctrl+Click retains native tab behavior.');

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }, source.session);
  await evaluate(source.session, 'document.querySelector("#external").scrollIntoView({block:"center"})');
  const scroll = await evaluate(source.session, 'scrollY');
  await trustedClick(source.session, '#external');
  await waitShadow(source.session, 'this.querySelector(".kb-peek-loading").hidden');
  assert.equal(await shadowEval(source.session, '(() => {const r=this.querySelector(".kb-peek-window").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})()'), true);
  assert.equal(await shadowEval(source.session, 'this.querySelector(".kb-peek-toolbar").scrollWidth <= this.querySelector(".kb-peek-toolbar").clientWidth'), true);
  assert.equal(await shadowEval(source.session, '[...this.querySelectorAll(".kb-peek-toolbar button, .kb-peek-site")].every(node=>{const r=node.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})'), true);
  await browser.shot(source.session, join(scratch, 'peek-narrow.png'));
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, source.session);
  await delay(180);
  await browser.shot(source.session, join(scratch, 'peek-dark.png'));
  await mouse(source.session, { x: 3, y: 3 }); await closed(source.session);
  assert.equal(await evaluate(source.session, 'scrollY'), scroll);
  console.log('PASS: narrow/light/dark previews fit the viewport; backdrop close preserves the source scroll position.');

  await send('Emulation.setDeviceMetricsOverride', { width: 740, height: 360, deviceScaleFactor: 1, mobile: false }, source.session);
  await evaluate(source.session, 'document.querySelector("#external").scrollIntoView({block:"center"})');
  await trustedClick(source.session, '#external');
  await waitShadow(source.session, 'this.querySelector(".kb-peek-loading").hidden');
  await delay(280);
  assert.equal(await shadowEval(source.session, '[...this.querySelectorAll(".kb-peek-window, .kb-peek-toolbar button, .kb-peek-site")].every(node=>{const r=node.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})'), true);
  await browser.shot(source.session, join(scratch, 'peek-short.png'));
  await shadowClick(source.session, '.kb-peek-close'); await closed(source.session);

  await send('Emulation.clearDeviceMetricsOverride', {}, source.session);
  await evaluate(source.session, 'scrollTo(0,0)');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, source.session);
  await trustedClick(source.session, '#external');
  await waitShadow(source.session, 'this.querySelector(".kb-peek-loading").hidden');
  assert.equal(await shadowEval(source.session, 'this.querySelector(".kb-peek-window").getAnimations().length'), 0);
  await shadowClick(source.session, '.kb-peek-expand');
  assert.equal(await shadowEval(source.session, 'this.querySelector(".kb-peek-window").getAnimations().length'), 0);
  await shadowClick(source.session, '.kb-peek-open-tab');
  await closed(source.session);
  await waitFor(app.session, `chrome.tabs.query({}).then(tabs=>tabs.length===${tabsBefore + 1})`);
  assert.equal(await evaluate(app.session, 'chrome.windows.getAll().then(windows=>windows.length)'), windowsBefore);
  console.log('PASS: only the explicit Open in tab action promotes a preview, in the same browser window.');
  const exceptions = browser.errors.filter(event => event.method === 'Runtime.exceptionThrown');
  assert.deepEqual(exceptions, []);
  console.log('PASS: no JavaScript exceptions.');
} finally {
  await browser.close();
  server.close();
}
