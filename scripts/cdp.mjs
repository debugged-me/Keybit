// A small Chrome DevTools Protocol harness for KeyBit's browser scripts. Uses isolated temporary profiles only.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export { delay };
export const root = process.cwd();
export const browserPath = process.env.KEYBIT_BROWSER || '/Applications/Helium.app/Contents/MacOS/Helium';

export async function launch(profile, extraArgs = []) {
  const scratch = profile ? null : await mkdtemp(join(tmpdir(), 'keybit-cdp-'));
  const dataDir = profile ?? join(scratch, 'profile');
  const extra = [...(process.env.KEYBIT_BROWSER_ARGS ?? '').split(' ').filter(Boolean), ...extraArgs];
  const browser = spawn(browserPath, ['--headless=new', '--window-size=1280,1000', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', ...extra,
    `--user-data-dir=${dataDir}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let nextId = 1, buffer = '';
  const pending = new Map();
  const errors = [];
  const contexts = [];
  browser.stdio[4].on('data', chunk => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf('\0')) !== -1) {
      const event = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (event.id) {
        const item = pending.get(event.id);
        if (!item) continue;
        pending.delete(event.id); clearTimeout(item.timer);
        if (event.error) { item.callSite.message = `${item.method}: ${JSON.stringify(event.error)}`; item.reject(item.callSite); } else item.resolve(event.result);
      } else if (event.method === 'Runtime.executionContextCreated') contexts.push(event.params.context);
      else if (event.method === 'Runtime.executionContextDestroyed') { const i = contexts.findIndex(c => c.uniqueId === event.params.executionContextUniqueId || c.id === event.params.executionContextId); if (i >= 0) contexts.splice(i, 1); }
      else if (event.method === 'Runtime.exceptionThrown' || (event.method === 'Log.entryAdded' && event.params.entry.level === 'error')) errors.push(event);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer, method, callSite: new Error(method) });
    browser.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
  });
  const attach = async targetId => {
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Runtime.enable', {}, sessionId); await send('Log.enable', {}, sessionId);
    return sessionId;
  };
  const evaluate = async (session, expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, session);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 800));
    return result.result.value;
  };
  const waitFor = async (session, expression, tries = 60) => {
    for (let i = 0; i < tries; i++) { if (await evaluate(session, expression).catch(() => false)) return; await delay(100); }
    throw new Error(`Condition did not complete: ${expression}`);
  };
  const page = async pageUrl => {
    const { targetId } = await send('Target.createTarget', { url: pageUrl });
    const session = await attach(targetId);
    await waitFor(session, `document.readyState === 'complete' && location.href.split('#')[0] === ${JSON.stringify(pageUrl.split('#')[0])}`);
    return { targetId, session };
  };
  const navigate = async (session, pageUrl) => {
    await send('Page.navigate', { url: pageUrl }, session);
    await waitFor(session, `document.readyState === 'complete' && location.href === ${JSON.stringify(pageUrl)}`);
  };
  const frameTarget = async path => {
    for (let i = 0; i < 60; i++) {
      const target = (await send('Target.getTargets')).targetInfos.find(t => t.url.includes(path));
      if (target) return attach(target.targetId);
      await delay(100);
    }
    throw new Error(`${path} did not appear`);
  };
  const absent = async path => {
    for (let i = 0; i < 30; i++) {
      if (!(await send('Target.getTargets')).targetInfos.some(t => t.url.includes(path))) return;
      await delay(100);
    }
    throw new Error(`${path} should not be open`);
  };
  const trustedClick = async (session, selector) => {
    const { x, y } = await evaluate(session, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2}; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, session);
  };
  const key = async (session, name, code, text) => {
    for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode: code, ...(text && type === 'keyDown' ? { text } : {}) }, session);
  };
  const typeText = (session, text) => send('Input.insertText', { text }, session);
  const shot = async (session, file) => writeFile(file, Buffer.from((await send('Page.captureScreenshot', { captureBeyondViewport: false }, session)).data, 'base64'));
  const loadExtension = async path => {
    await send('Extensions.loadUnpacked', { path });
    for (let i = 0; i < 50; i++) {
      const worker = (await send('Target.getTargets')).targetInfos.find(t => t.type === 'service_worker' && t.url.endsWith('/src/background/service-worker.js'));
      if (worker) return { worker, id: new URL(worker.url).host };
      await delay(100);
    }
    throw new Error('Extension worker did not start');
  };
  const developerMode = async () => {
    const extensions = await page('chrome://extensions/');
    await evaluate(extensions.session, 'new Promise(resolve => chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode: true}, resolve))');
    await send('Target.closeTarget', { targetId: extensions.targetId });
  };
  const close = async () => {
    await send('Browser.close').catch(() => {});
    browser.kill(); await delay(300);
    if (scratch) await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
  };
  return { send, attach, evaluate, waitFor, page, navigate, frameTarget, absent, trustedClick, key, typeText, shot, loadExtension, developerMode, close, errors, contexts };
}
