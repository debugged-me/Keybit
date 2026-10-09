// Saved logins must survive quitting and relaunching the browser (the same as restarting the computer).
// Uses an isolated temporary profile; never the user's browser profile.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = process.cwd();
const scratch = await mkdtemp(join(tmpdir(), 'keybit-restart-'));
const profile = join(scratch, 'profile');
const password = 'a unique restart test passphrase';
function launch() {
  const browser = spawn(process.env.KEYBIT_BROWSER || '/Applications/Helium.app/Contents/MacOS/Helium', ['--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', ...(process.env.KEYBIT_BROWSER_ARGS ?? '').split(' ').filter(Boolean), `--user-data-dir=${profile}`, 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let id = 1, buffer = '';
  const pending = new Map();
  browser.stdio[4].on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\0')) !== -1) {
      const event = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const item = event.id && pending.get(event.id);
      if (item) { pending.delete(event.id); clearTimeout(item.timer); event.error ? item.reject(new Error(`${item.method}: ${JSON.stringify(event.error)}`)) : item.resolve(event.result); }
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const n = id++;
    const timer = setTimeout(() => { pending.delete(n); reject(new Error(`Timeout: ${method}`)); }, 15000);
    pending.set(n, { resolve, reject, timer, method });
    browser.stdio[3].write(JSON.stringify({ id: n, method, params, sessionId }) + '\0');
  });
  async function load(path) {
    await send('Extensions.loadUnpacked', { path });
    for (let i = 0; i < 50; i++) {
      const worker = (await send('Target.getTargets')).targetInfos.find(t => t.type === 'service_worker' && t.url.includes(`/src/background/service-worker.js`) && !seen.has(t.url));
      if (worker) { seen.add(worker.url); return new URL(worker.url).host; }
      await delay(100);
    }
    throw new Error('Extension worker did not start');
  }
  const seen = new Set();
  async function rpc(extensionId, type, args = {}) {
    const { targetId } = await send('Target.createTarget', { url: `chrome-extension://${extensionId}/src/popup/popup.html` });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    for (let i = 0; i < 40; i++) {
      const ready = await send('Runtime.evaluate', { expression: 'location.protocol === "chrome-extension:" && document.readyState === "complete"', returnByValue: true }, sessionId);
      if (ready.result.value) break;
      await delay(100);
    }
    const result = await send('Runtime.evaluate', { expression: `chrome.runtime.sendMessage(${JSON.stringify({ type, ...args })})`, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(`${type}: ${JSON.stringify(result.exceptionDetails)}`);
    await send('Target.closeTarget', { targetId });
    return result.result.value;
  }
  async function evalPage(extensionId, path, expression) {
    const { targetId } = await send('Target.createTarget', { url: `chrome-extension://${extensionId}/${path}` });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    for (let i = 0; i < 40; i++) {
      const ready = await send('Runtime.evaluate', { expression: 'location.protocol === "chrome-extension:" && document.readyState === "complete"', returnByValue: true }, sessionId);
      if (ready.result.value) break;
      await delay(100);
    }
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    await send('Target.closeTarget', { targetId });
    return result.result.value;
  }
  async function quit() { await send('Browser.close').catch(() => {}); await delay(1500); browser.kill(); await delay(500); }
  return { load, rpc, evalPage, quit };
}

let session;
try {
  session = launch();
  const id = await session.load(root);
  let state = (await session.rpc(id, 'CREATE', { password })).data;
  state = (await session.rpc(id, 'SAVE', { session: state.session, revision: state.revision, item: { name: 'Survives restarts', urls: ['http://localhost/srms-college/'], username: 'admin', password: 'first-secret', notes: 'kept', environment: 'local' } })).data;
  const saved = (await session.rpc(id, 'LIST', { session: state.session })).data[0];
  const item = (await session.rpc(id, 'ITEM', { session: state.session, id: saved.id })).data.item;
  state = (await session.rpc(id, 'SAVE', { session: state.session, revision: state.revision, item: { ...item, password: 'second-secret' } })).data;
  state = (await session.rpc(id, 'SETTINGS', { session: state.session, settings: { autoLockMinutes: 15 } })).data;
  await session.quit();

  // Quit and relaunch the browser on the same profile. The unpacked folder path, and so the extension ID, is unchanged.
  session = launch();
  assert.equal(await session.load(root), id, 'Same folder, same extension ID');
  assert.deepEqual((({ exists, unlocked }) => ({ exists, unlocked }))((await session.rpc(id, 'STATUS')).data), { exists: true, unlocked: false });
  assert.equal((await session.rpc(id, 'UNLOCK', { password: 'wrong passphrase here' })).ok, false);
  state = (await session.rpc(id, 'UNLOCK', { password })).data;
  assert.equal(state.settings.autoLockMinutes, 15);
  const reopened = (await session.rpc(id, 'ITEM', { session: state.session, id: saved.id })).data.item;
  assert.equal(reopened.password, 'second-secret');
  assert.deepEqual(reopened.history.map(entry => entry.password), ['first-secret']);
  assert.equal(reopened.notes, 'kept');
  console.log('PASS: after quitting and relaunching the browser, the vault, logins, password history, and settings are intact (and locked until unlocked).');

  // A copy of the extension from another folder is a different extension with its own, empty storage.
  const moved = join(scratch, 'moved-keybit');
  await cp(join(root, 'manifest.json'), join(moved, 'manifest.json'));
  await cp(join(root, 'src'), join(moved, 'src'), { recursive: true });
  await cp(join(root, 'icons'), join(moved, 'icons'), { recursive: true });
  const movedId = await session.load(moved);
  assert.notEqual(movedId, id);
  assert.equal((await session.rpc(movedId, 'STATUS')).data.exists, false);
  console.log('PASS (documented limit): a copy loaded from a different folder gets a new ID and an empty vault; restore a backup there.');
  // Files updated on disk while the old version keeps running: pages say so and offer a one-click reload.
  const { readFile, writeFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(join(moved, 'manifest.json'), 'utf8'));
  await writeFile(join(moved, 'src/version.js'), 'export const VERSION = "9.9.9";\n');
  const banner = await session.evalPage(movedId, 'src/vault-ui/vault.html', `new Promise(resolve => setTimeout(() => resolve({ banner: !!document.querySelector("#update-banner"), running: chrome.runtime.getManifest().version }), 800))`);
  assert.deepEqual(banner, { banner: true, running: manifest.version });
  console.log('PASS: when KeyBit\'s files are newer than the running extension, pages show the Reload KeyBit banner.');
} finally {
  await session?.quit();
  await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
}
