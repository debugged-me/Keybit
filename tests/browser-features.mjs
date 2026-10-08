// Browser checks for KeyBit 1.3: welcome, import, notes/favorites/projects, generator presets, theme, Touch ID,
// master password change, automatic folder backup, merge restore, script and two-step logins, 2FA codes,
// dropdown filtering, last-used order, and popup keyboard use. Runs in an isolated temporary profile.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, fixtureServer, root, delay } from './cdp.mjs';
import { totpCode } from '../src/vault/totp.js';

const scratch = await mkdtemp(join(tmpdir(), 'keybit-features-'));
const { server, url } = await fixtureServer();
const browser = await launch();
const { send, evaluate, waitFor, page, navigate, frameTarget, absent, trustedClick, key, typeText, errors } = browser;
const shot = (session, name) => browser.shot(session, join(scratch, `${name}.png`));
const password = 'a unique feature test passphrase';
const PANEL = '/src/inline/panel.html#';
const SAVE = '/src/inline/save.html#';
const rpc = (session, type, args = {}) => evaluate(session, `chrome.runtime.sendMessage(${JSON.stringify({ type, ...args })})`);
const state = async session => (await rpc(session, 'STATUS')).data;
const set = (session, selector, text) => evaluate(session, `{ const node = document.querySelector(${JSON.stringify(selector)}); node.value = ${JSON.stringify(text)}; node.dispatchEvent(new Event("input", {bubbles: true})); }`);
const click = (session, selector) => evaluate(session, `document.querySelector(${JSON.stringify(selector)}).click()`);
console.log('Test artifacts:', scratch);
try {
  await browser.developerMode();
  const { id } = await browser.loadExtension(root);
  const origin = `chrome-extension://${id}`;

  // Welcome: installing opens KeyBit with first steps.
  let welcome;
  for (let i = 0; i < 50 && !welcome; i++) { welcome = (await send('Target.getTargets')).targetInfos.find(t => t.url.endsWith('/src/vault-ui/vault.html#welcome')); await delay(100); }
  assert.ok(welcome, 'Install opens the welcome page');
  const app = { targetId: welcome.targetId, session: await browser.attach(welcome.targetId) };
  await waitFor(app.session, '!document.querySelector("#welcome").hidden && !!document.querySelector("#confirm-password")');
  await shot(app.session, 'welcome');
  await set(app.session, '#master-password', password); await set(app.session, '#confirm-password', password);
  await evaluate(app.session, 'document.querySelector("#auth form").requestSubmit()');
  await waitFor(app.session, '!document.querySelector("#app").hidden && !!document.querySelector(".getting-started")');
  console.log('PASS: install opens a welcome page; an empty vault shows getting-started steps.');

  // Import a CSV export from another password manager, twice: the second time everything is a duplicate.
  const csv = join(scratch, 'export.csv');
  await writeFile(csv, `name,url,username,password,note,totp\nFixture main,${url},test-user@example.test,fixture-secret-1,,JBSWY3DPEHPK3PXP\nFixture second,${url},second@example.test,fixture-secret-2,,\nWifi,,,,home wifi password: abc,\n`);
  const chooseFile = async (selector, file) => {
    const { root: doc } = await send('DOM.getDocument', {}, app.session);
    const { nodeId } = await send('DOM.querySelector', { nodeId: doc.nodeId, selector }, app.session);
    await send('DOM.setFileInputFiles', { nodeId, files: [file] }, app.session);
  };
  await click(app.session, '[data-view="import"]');
  await chooseFile('#import-file', csv);
  await waitFor(app.session, '!document.querySelector("#import-preview").hidden');
  assert.match(await evaluate(app.session, 'document.querySelector("#import-summary").textContent'), /2 logins and 1 secure note/);
  await shot(app.session, 'import-preview');
  await click(app.session, '#import-confirm');
  await waitFor(app.session, 'document.querySelector("#count-logins").textContent === "2" && document.querySelector("#count-notes").textContent === "1"');
  await click(app.session, '[data-view="import"]');
  await chooseFile('#import-file', csv);
  await waitFor(app.session, '!document.querySelector("#import-preview").hidden');
  assert.match(await evaluate(app.session, 'document.querySelector("#import-summary").textContent'), /3 already in KeyBit/);
  await click(app.session, '#import-cancel');
  console.log('PASS: CSV import adds logins and keeps a no-website entry as a secure note; re-importing skips duplicates.');

  // Secure note, favorite, and project (developer view grouped by environment).
  await click(app.session, '[data-view="notes"]');
  await click(app.session, '#add-login');
  await waitFor(app.session, 'document.querySelector("#login-dialog").open && document.querySelector("#editor-title").textContent === "Add secure note"');
  await set(app.session, '#name', 'Server keys'); await set(app.session, '#notes', 'ssh root@srms'); await set(app.session, '#project', 'SRMS');
  await evaluate(app.session, 'document.querySelector("#login-form").requestSubmit()');
  await waitFor(app.session, 'document.querySelector("#count-notes").textContent === "2" && document.querySelector("#detail").open');
  await click(app.session, '.detail-header .star');
  await waitFor(app.session, 'document.querySelector("#count-favorites").textContent === "1" && document.querySelector(".detail-header .star").classList.contains("on")');
  let s = await state(app.session);
  const main = (await rpc(app.session, 'LIST', { session: s.session, query: 'Fixture main' })).data[0];
  const item = (await rpc(app.session, 'ITEM', { session: s.session, id: main.id })).data.item;
  await rpc(app.session, 'SAVE', { session: s.session, revision: s.revision, item: { ...item, project: 'SRMS', environment: 'production' } });
  await waitFor(app.session, '!document.querySelector("#projects-nav").hidden && !!document.querySelector(\'[data-view="project:SRMS"]\')');
  await evaluate(app.session, 'document.querySelector("#detail").close()');
  await click(app.session, '[data-view="project:SRMS"]');
  await waitFor(app.session, 'document.querySelector("#list-title").textContent === "SRMS" && [...document.querySelectorAll(".group-heading")].map(h => h.textContent).join() === "Production,Other"');
  await click(app.session, '#items .login-item');
  try {
    await waitFor(app.session, '/^\\d{3} \\d{3}$/.test(document.querySelector(".totp-code")?.textContent ?? "")');
  } catch (error) {
    console.log('DIAG:', await evaluate(app.session, 'JSON.stringify({open: document.querySelector("#detail").open, fields: document.querySelector("#detail-view").children.length, msg: document.querySelector("#message").textContent, selected: document.querySelector(".item-row[aria-current=\'true\']")?.textContent})').catch(String));
    throw error;
  }
  await shot(app.session, 'project-view');
  // The detail dialog makes the page inert; close it before driving the sidebar again.
  await evaluate(app.session, 'document.querySelector("#detail").close()');
  console.log('PASS: secure notes, favorites, and a project view grouped by environment; the detail shows a live 2FA code.');

  // Generator: Memorable, remembered for every generator.
  await click(app.session, '[data-view="generator"]');
  await click(app.session, '[data-mode="memorable"]');
  await waitFor(app.session, '/^([A-Z][a-z]+-){4}[A-Z][a-z]+\\d$/.test(document.querySelector("#gen-output").textContent)');
  assert.equal((await evaluate(app.session, 'chrome.storage.local.get("generator")')).generator.mode, 'memorable');
  await shot(app.session, 'generator-memorable');
  await click(app.session, '[data-mode="random"]');
  console.log('PASS: memorable passphrases, and the generator choice is remembered.');

  // Settings: theme, lock on screen lock, Touch ID (virtual authenticator), change master password.
  await click(app.session, '[data-view="settings"]');
  await click(app.session, '[data-theme-choice="dark"]');
  await waitFor(app.session, 'document.documentElement.dataset.theme === "dark"');
  assert.equal((await evaluate(app.session, 'chrome.storage.local.get("theme")')).theme, 'dark');
  await shot(app.session, 'settings-dark');
  await click(app.session, '[data-theme-choice="system"]');
  await waitFor(app.session, '!document.documentElement.dataset.theme');
  await click(app.session, '#lock-on-sleep');
  await waitFor(app.session, 'document.querySelector("#message").textContent.includes("stays unlocked")');
  assert.equal((await state(app.session)).settings.lockOnScreenLock, false);
  await click(app.session, '#lock-on-sleep');
  await waitFor(app.session, 'document.querySelector("#message").textContent.includes("locks when your computer")');
  assert.equal((await state(app.session)).settings.lockOnScreenLock, true);
  await send('WebAuthn.enable', { enableUI: false }, app.session);
  await send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } }, app.session);
  await click(app.session, '[data-view="logins"]'); await click(app.session, '[data-view="settings"]');
  await waitFor(app.session, '!document.querySelector("#biometric-row").hidden');
  await click(app.session, '#biometric');
  await waitFor(app.session, 'document.querySelector("#password-dialog").open');
  await set(app.session, '#current-password', password);
  await evaluate(app.session, 'document.querySelector("#password-form").requestSubmit()');
  await waitFor(app.session, 'document.querySelector("#biometric").checked && document.querySelector("#message").textContent.includes("unlock is on")');
  const sealed = JSON.stringify(await evaluate(app.session, 'chrome.storage.local.get(null)'));
  assert.equal(sealed.includes(password), false, 'The master password is never stored');
  await click(app.session, '#lock');
  await waitFor(app.session, '!!document.querySelector("#biometric-unlock")');
  await shot(app.session, 'unlock-touch-id');
  await click(app.session, '#biometric-unlock');
  await waitFor(app.session, '!document.querySelector("#app").hidden');
  console.log('PASS: Touch ID unlock (virtual authenticator) seals the key without storing the master password; theme and screen-lock settings persist.');
  await click(app.session, '[data-view="settings"]');
  await click(app.session, '#change-password');
  await waitFor(app.session, 'document.querySelector("#password-dialog").open && !document.querySelector("#next-fields").hidden');
  const newPassword = 'a brand new master passphrase';
  await set(app.session, '#current-password', password); await set(app.session, '#next-password', newPassword); await set(app.session, '#next-confirm', newPassword);
  await evaluate(app.session, 'document.querySelector("#password-form").requestSubmit()');
  await waitFor(app.session, 'document.querySelector("#message").textContent.includes("Master password changed")');
  assert.equal((await state(app.session)).biometric, false, 'Touch ID must be set up again after a password change');
  await click(app.session, '#lock');
  await waitFor(app.session, '!!document.querySelector("#master-password")');
  assert.equal((await rpc(app.session, 'UNLOCK', { password })).ok, false);
  await set(app.session, '#master-password', newPassword);
  await evaluate(app.session, 'document.querySelector("#auth form").requestSubmit()');
  await waitFor(app.session, '!document.querySelector("#app").hidden');
  s = await state(app.session);
  await rpc(app.session, 'CHANGE_PASSWORD', { session: s.session, current: newPassword, next: password });
  console.log('PASS: changing the master password re-encrypts the vault; the old password stops working.');

  // Automatic backup: a folder handle (here the browser's private file system) gets a fresh copy after each change.
  await evaluate(app.session, `(async () => { const { setFolder } = await import(${JSON.stringify(`${origin}/src/background/auto-backup.js`)}); const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("keybit-sync", { create: true }); await setFolder(dir); })()`);
  s = await state(app.session);
  await rpc(app.session, 'SETTINGS', { session: s.session, settings: { autoLockMinutes: 0 } });
  await waitFor(app.session, 'chrome.storage.local.get("autoBackup").then(value => value.autoBackup?.status === "saved")');
  const backupText = await evaluate(app.session, 'navigator.storage.getDirectory().then(root => root.getDirectoryHandle("keybit-sync")).then(dir => dir.getFileHandle("KeyBit Backup.kvault")).then(file => file.getFile()).then(file => file.text())');
  assert.equal(JSON.parse(backupText).formatVersion, 1);
  assert.equal(backupText.includes('fixture-secret-1'), false);
  await click(app.session, '[data-view="backup"]');
  await waitFor(app.session, 'document.querySelector("#auto-backup-status").textContent.startsWith("On: “keybit-sync”")');
  await shot(app.session, 'backup-auto');
  console.log('PASS: automatic backup writes an encrypted copy to the chosen folder from the background after vault changes.');

  // Merge restore: merging the same vault's backup changes nothing and deletes nothing.
  const backupFile = join(scratch, 'merge.kvault');
  await writeFile(backupFile, backupText);
  await chooseFile('#backup-file', backupFile);
  await set(app.session, '#backup-password', password);
  await click(app.session, '#merge-backup');
  await waitFor(app.session, 'document.querySelector("#message").textContent.startsWith("Nothing to merge")');
  console.log('PASS: merge restore from a backup file keeps the vault intact.');

  // Recently deleted: deleting keeps the item for 30 days; Restore brings it back, Delete forever removes it.
  s = await state(app.session);
  await rpc(app.session, 'SAVE', { session: s.session, revision: s.revision, item: { name: 'Trash test', urls: ['https://trash.example.test'], username: 'trash-user', password: 'trash-secret', notes: '', environment: 'other' } });
  await evaluate(app.session, 'window.confirm = () => true');
  await click(app.session, '[data-view="logins"]');
  await set(app.session, '#search', 'Trash test');
  await waitFor(app.session, 'document.querySelectorAll("#items .login-item").length === 1');
  await click(app.session, '#items .login-item');
  await waitFor(app.session, '!!document.querySelector(".detail-actions .danger")');
  await click(app.session, '.detail-actions .danger');
  await waitFor(app.session, 'document.querySelector("#count-trash").textContent === "1"');
  await set(app.session, '#search', '');
  await click(app.session, '[data-view="trash"]');
  await waitFor(app.session, 'document.querySelector("#list-title").textContent === "Recently deleted" && document.querySelectorAll("#items .login-item").length === 1');
  assert.match(await evaluate(app.session, 'document.querySelector("#items .login-item .secondary").textContent'), /Deleted /);
  await click(app.session, '#items .login-item');
  await waitFor(app.session, '!!document.querySelector("#restore-item")');
  await shot(app.session, 'recently-deleted');
  await click(app.session, '#restore-item');
  await waitFor(app.session, 'document.querySelector("#message").textContent.includes("Restored")');
  // It returns to its normal section; deleting it again then removing it forever is final.
  await waitFor(app.session, 'document.querySelector("#list-title").textContent === "All logins"');
  await evaluate(app.session, 'document.querySelector("#detail").close()');
  await set(app.session, '#search', 'Trash test');
  await waitFor(app.session, 'document.querySelectorAll("#items .login-item").length === 1');
  await click(app.session, '#items .login-item');
  await waitFor(app.session, '!!document.querySelector(".detail-actions .danger")');
  await click(app.session, '.detail-actions .danger');
  await waitFor(app.session, 'document.querySelector("#count-trash").textContent === "1"');
  await set(app.session, '#search', '');
  await click(app.session, '[data-view="trash"]');
  await click(app.session, '#items .login-item');
  await waitFor(app.session, '!!document.querySelector("#restore-item")');
  await click(app.session, '.detail-actions .danger');
  await waitFor(app.session, 'document.querySelector("#count-trash").textContent === ""');
  s = await state(app.session);
  assert.equal((await rpc(app.session, 'TRASH_LIST', { session: s.session })).data.length, 0);
  console.log('PASS: Recently deleted keeps deleted items for recovery, restores them, and removes them forever.');

  // ⌘K/Ctrl+K and "/" jump to search in the app window.
  await evaluate(app.session, 'document.activeElement.blur(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }))');
  await waitFor(app.session, 'document.activeElement.id === "search"');
  await evaluate(app.session, 'document.activeElement.blur(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }))');
  await waitFor(app.session, 'document.activeElement.id === "search"');
  console.log('PASS: Ctrl+K/⌘K and / jump to search in the app window.');

  // The sidebar health card summarizes weak/reused counts and opens the health view.
  await waitFor(app.session, 'document.querySelector("#sidebar-health").hidden === false && /^\\d+%$/.test(document.querySelector("#health-score").textContent)');
  await click(app.session, '#sidebar-health');
  await waitFor(app.session, '!document.querySelector("#view-health").hidden');
  console.log('PASS: sidebar vault-health summary opens the Weak & reused view.');

  // A login made by a script button (no form submit) offers to save; so does pressing Enter.
  const site = await page(`${url}/spa-login.html`);
  await send('Target.activateTarget', { targetId: site.targetId });
  await set(site.session, '#user', 'spa-user@example.test'); await set(site.session, '#pass', 'spa-secret-1');
  await trustedClick(site.session, '#go');
  let card = await frameTarget(SAVE);
  await waitFor(card, 'document.querySelector("#heading").textContent === "Save this password?" && !document.querySelector("#save").disabled');
  await click(card, '#save');
  await absent(SAVE);
  s = await state(app.session);
  assert.equal((await rpc(app.session, 'LIST', { session: s.session, query: 'spa-user' })).data.length, 1);
  await navigate(site.session, `${url}/spa-login.html`);
  await set(site.session, '#user', 'enter-user@example.test'); await set(site.session, '#pass', 'enter-secret-1');
  await evaluate(site.session, 'document.querySelector("#pass").focus()');
  await key(site.session, 'Enter', 13, '\r');
  card = await frameTarget(SAVE);
  await waitFor(card, 'document.querySelector("#heading").textContent === "Save this password?"');
  await click(card, '#dismiss');
  await absent(SAVE);
  console.log('PASS: script-button and Enter-key sign-ins (no form submit) offer to save.');

  // Two-step sign-in: choose the account on the username page, then it is offered first on the password page.
  await navigate(site.session, `${url}/twostep-user.html`);
  await evaluate(site.session, 'document.querySelector("#identifier").focus()');
  let panel = await frameTarget(PANEL);
  await waitFor(panel, 'document.querySelectorAll(".account").length === 3');
  await evaluate(panel, '[...document.querySelectorAll(".account")].find(b => b.textContent.includes("second@")).click()');
  await waitFor(site.session, 'document.querySelector("#identifier").value === "second@example.test"');
  await absent(PANEL);
  await click(site.session, 'button');
  await waitFor(site.session, 'location.pathname.endsWith("twostep-password.html") && document.readyState === "complete"');
  await evaluate(site.session, 'document.querySelector("#pass").focus()');
  panel = await frameTarget(PANEL);
  await waitFor(panel, 'document.querySelector(".account .badge.continue") && document.querySelector(".account").textContent.includes("second@")');
  await shot(site.session, 'two-step-continue');
  await click(panel, '.account');
  await waitFor(site.session, 'document.querySelector("#pass").value === "fixture-secret-2"');
  await set(site.session, '#pass', 'second-secret-new');
  await click(site.session, 'button');
  card = await frameTarget(SAVE);
  await waitFor(card, 'document.querySelector("#heading").textContent === "Update this password?" && document.querySelector("#username").textContent === "second@example.test"');
  await click(card, '#dismiss');
  console.log('PASS: two-step sign-in fills the username step, offers the same account first on the password step, and knows the username when saving.');

  // 2FA codes: one field, and six one-digit boxes.
  const secret = 'JBSWY3DPEHPK3PXP';
  for (const [fixture, read] of [['otp.html', 'document.querySelector("#code").value'], ['otp-boxes.html', '[...document.querySelectorAll(".boxes input")].map(i => i.value).join("")']]) {
    await navigate(site.session, `${url}/${fixture}`);
    await evaluate(site.session, 'document.querySelector("input").focus()');
    panel = await frameTarget(PANEL);
    await waitFor(panel, '/^\\d{3} \\d{3}$/.test(document.querySelector(".code strong")?.textContent ?? "")');
    if (fixture === 'otp.html') await shot(site.session, 'otp-dropdown');
    await click(panel, '.account');
    await waitFor(site.session, `/^\\d{6}$/.test(${read})`);
    const filled = await evaluate(site.session, read);
    // The code may have rolled over between filling and checking.
    const now = Date.now();
    const codes = [(await totpCode(secret, now)).code, (await totpCode(secret, now - 30000)).code];
    assert.ok(codes.includes(filled), `2FA code ${filled} should be one of ${codes}`);
    await absent(PANEL);
  }
  console.log('PASS: 2FA codes appear in the dropdown and fill a code field or six digit boxes.');

  // Dropdown filtering as you type, and most-recently-used first.
  await navigate(site.session, `${url}/basic-login.html`);
  await evaluate(site.session, 'document.querySelector("#user").focus()');
  panel = await frameTarget(PANEL);
  await waitFor(panel, 'document.querySelectorAll(".account").length >= 2');
  assert.match(await evaluate(panel, 'document.querySelector(".account").textContent'), /second@/, 'The account used last comes first');
  await typeText(site.session, 'spa');
  await waitFor(panel, 'document.querySelectorAll(".account").length === 1 && document.querySelector(".account").textContent.includes("spa-user")');
  await shot(site.session, 'dropdown-filter');
  await evaluate(site.session, 'document.querySelector("#user").value = ""; document.querySelector("#user").dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}))');
  s = await state(app.session);
  const used = (await rpc(app.session, 'LIST', { session: s.session, query: 'second@' })).data[0];
  assert.ok(used.lastUsedAt > 0);
  console.log('PASS: typing narrows the dropdown; the most recently used account is listed first.');

  // Popup keyboard: "/" searches, ↓ moves to a login, Enter fills it.
  await send('Target.activateTarget', { targetId: site.targetId });
  const tab = (await send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] })).targetInfos.find(t => t.url.startsWith(`${url}/basic-login.html`));
  await send('Extensions.triggerAction', { id, targetId: tab.targetId });
  const popup = await frameTarget('/src/popup/popup.html');
  await waitFor(popup, 'document.querySelectorAll("#matches .login-item").length >= 2');
  await key(popup, '/', 191, '/');
  await waitFor(popup, 'document.activeElement.id === "search"');
  await key(popup, 'ArrowDown', 40);
  await waitFor(popup, 'document.activeElement.classList.contains("login-item")');
  await key(popup, 'Enter', 13, '\r');
  await waitFor(site.session, '["fixture-secret-1", "fixture-secret-2", "spa-secret-1"].includes(document.querySelector("#pass").value)');
  await shot(popup, 'popup-keyboard');
  console.log('PASS: the popup works from the keyboard.');

  // Clipboard clearing runs in a background offscreen document so it fires even after the copying
  // page closed. (Headless cannot grant clipboardRead — permissions.request never resolves there —
  // so this verifies the arm → document → timer → close lifecycle; the guarded read/write inside is
  // the same comparison the unit tests cover.)
  const armed = await evaluate(app.session, 'chrome.runtime.sendMessage({ type: "CLIPBOARD_ARM", value: "keybit-probe-a", ms: 500 })');
  assert.equal(armed?.data, true, 'The worker armed the clipboard clear');
  let docSeen = false, docGone = false;
  for (let i = 0; i < 60 && !docGone; i++) {
    const open = (await send('Target.getTargets')).targetInfos.some(t => t.url.includes('/src/offscreen/clipboard.html'));
    if (open) docSeen = true;
    if (docSeen && !open) docGone = true;
    await delay(100);
  }
  assert.ok(docSeen && docGone, 'The offscreen document appeared, ran its timer, and closed');
  console.log('PASS: clipboard clearing runs in a background offscreen document.');

  const unexpected = errors.filter(event => !JSON.stringify(event).includes('favicon.ico'));
  assert.deepEqual(unexpected, []);
  console.log('PASS: no captured extension JavaScript/CSP errors.');
} finally {
  await browser.close(); server.close();
  if (!process.env.KEEP_ARTIFACTS) await rm(join(scratch, 'export.csv'), { force: true });
}
