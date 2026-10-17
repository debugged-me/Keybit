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
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: scratch });
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
  await waitFor(app.session, 'document.querySelector("#count-notes").textContent === "2" && !document.querySelector("#detail").hidden');
  await click(app.session, '.detail-header .star');
  await waitFor(app.session, 'document.querySelector("#count-favorites").textContent === "1" && document.querySelector(".detail-header .star").classList.contains("on")');
  let s = await state(app.session);
  const main = (await rpc(app.session, 'LIST', { session: s.session, query: 'Fixture main' })).data[0];
  const item = (await rpc(app.session, 'ITEM', { session: s.session, id: main.id })).data.item;
  await rpc(app.session, 'SAVE', { session: s.session, revision: s.revision, item: { ...item, project: 'SRMS', environment: 'production' } });
  await waitFor(app.session, '!document.querySelector("#projects-nav").hidden && !!document.querySelector(\'[data-view="project:SRMS"]\')');
  await evaluate(app.session, 'document.querySelector("#detail .back-button")?.click()');
  await click(app.session, '[data-view="project:SRMS"]');
  await waitFor(app.session, 'document.querySelector("#list-title").textContent === "SRMS" && [...document.querySelectorAll(".group-heading")].map(h => h.textContent).join() === "Production,Other"');
  await click(app.session, '#items .login-item');
  try {
    await waitFor(app.session, '/^\\d{3} \\d{3}$/.test(document.querySelector(".totp-code")?.textContent ?? "")');
  } catch (error) {
    console.log('DIAG:', await evaluate(app.session, 'JSON.stringify({open: !document.querySelector("#detail").hidden, fields: document.querySelector("#detail-view").children.length, msg: document.querySelector("#message").textContent, selected: document.querySelector(".item-row[aria-current=\'true\']")?.textContent})').catch(String));
    throw error;
  }
  await shot(app.session, 'project-view');
  // Close the detail pane before driving the sidebar again.
  await evaluate(app.session, 'document.querySelector("#detail .back-button")?.click()');
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
  // The screen-lock switch defaults off now — the first click turns it on, the second back off.
  // Clear any toast still queued so the setting's own notice shows inside the wait window.
  for (let i = 0; i < 10 && !(await evaluate(app.session, 'document.querySelector("#message").hidden')); i++) {
    await evaluate(app.session, 'document.querySelector("#message")?.click()');
    await delay(200);
  }
  await click(app.session, '#lock-on-sleep');
  await waitFor(app.session, 'document.querySelector("#message").textContent.includes("locks when your computer")');
  assert.equal((await state(app.session)).settings.lockOnScreenLock, true);
  await click(app.session, '#lock-on-sleep');
  await waitFor(app.session, 'document.querySelector("#message").textContent.includes("stays unlocked")');
  assert.equal((await state(app.session)).settings.lockOnScreenLock, false);
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
  await click(app.session, '[data-view="logins"]');
  await set(app.session, '#search', 'Trash test');
  await waitFor(app.session, 'document.querySelectorAll("#items .login-item").length === 1');
  await click(app.session, '#items .login-item');
  await waitFor(app.session, '!!document.querySelector(".detail-actions .danger")');
  await click(app.session, '.detail-actions .danger');
  await waitFor(app.session, 'document.querySelector("#confirm-dialog").open');
  await click(app.session, '#confirm-ok');
  await waitFor(app.session, 'document.querySelector("#count-trash").textContent === "1"');
  await set(app.session, '#search', '');
  await click(app.session, '[data-view="trash"]');
  await waitFor(app.session, 'document.querySelector("#list-title").textContent === "Recently deleted" && document.querySelectorAll("#items .login-item").length === 1');
  assert.match(await evaluate(app.session, 'document.querySelector("#items .login-item .secondary").textContent'), /Deleted /);
  await click(app.session, '#items .login-item');
  await waitFor(app.session, '!!document.querySelector("#restore-item")');
  await shot(app.session, 'recently-deleted');
  // Toasts queue and background throttling can stretch the 4s fade — clear any showing first.
  for (let i = 0; i < 10 && !(await evaluate(app.session, 'document.querySelector("#message").hidden')); i++) {
    await evaluate(app.session, 'document.querySelector("#message")?.click()');
    await delay(200);
  }
  await click(app.session, '#restore-item');
  try {
    await waitFor(app.session, 'document.querySelector("#message").textContent.includes("Restored")');
  } catch (error) {
    console.log('DIAG:', await evaluate(app.session, 'JSON.stringify({msg: document.querySelector("#message")?.textContent, hidden: document.querySelector("#message")?.hidden})').catch(String));
    throw error;
  }
  // It returns to its normal section; deleting it again then removing it forever is final.
  await waitFor(app.session, 'document.querySelector("#list-title").textContent === "All logins"');
  await evaluate(app.session, 'document.querySelector("#detail .back-button")?.click()');
  await set(app.session, '#search', 'Trash test');
  await waitFor(app.session, 'document.querySelectorAll("#items .login-item").length === 1');
  await click(app.session, '#items .login-item');
  await waitFor(app.session, '!!document.querySelector(".detail-actions .danger")');
  await click(app.session, '.detail-actions .danger');
  await waitFor(app.session, 'document.querySelector("#confirm-dialog").open');
  await click(app.session, '#confirm-ok');
  await waitFor(app.session, 'document.querySelector("#count-trash").textContent === "1"');
  await set(app.session, '#search', '');
  await click(app.session, '[data-view="trash"]');
  await click(app.session, '#items .login-item');
  await waitFor(app.session, '!!document.querySelector("#restore-item")');
  await click(app.session, '.detail-actions .danger');
  await waitFor(app.session, 'document.querySelector("#confirm-dialog").open');
  await click(app.session, '#confirm-ok');
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
  // Choosing the account fills and submits the username step on its own — the site advances itself.
  await evaluate(panel, '[...document.querySelectorAll(".account")].find(b => b.textContent.includes("second@")).click()');
  await absent(PANEL);
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

  // Passkeys: the fixture page calls navigator.credentials directly, like any WebAuthn site.
  // KeyBit's MAIN-world interceptor offers its card; the page's promise resolves with a real credential.
  const pk = await page(`${url}/webauthn.html`);
  await send('Target.activateTarget', { targetId: pk.targetId });
  await click(pk.session, '#create');
  let passkeyCard = await frameTarget('/src/inline/passkey.html#');
  await waitFor(passkeyCard, 'document.querySelector("#heading").textContent === "Save a passkey?" && !document.querySelector("#save").disabled');
  await shot(pk.session, 'passkey-create');
  await click(passkeyCard, '#save');
  await waitFor(pk.session, 'document.querySelector("#out").textContent.startsWith("created ")');
  const created = await evaluate(pk.session, 'document.querySelector("#out").textContent');
  assert.match(created, / public-key attestation:[1-9]\d* json:true/, 'The page received an attestation object');
  s = await state(app.session);
  const keyItem = (await rpc(app.session, 'LIST', { session: s.session, query: '' })).data.find(item => item.type === 'passkey');
  assert.ok(keyItem, 'The passkey is saved in the vault');
  assert.equal(keyItem.rpId, '127.0.0.1');
  await waitFor(app.session, '!document.querySelector("#nav-passkeys").hidden');
  await click(app.session, '#nav-passkeys');
  await waitFor(app.session, 'document.querySelectorAll("#items .item-row").length === 1');
  await click(app.session, '#items .item-row');
  await waitFor(app.session, '!document.querySelector("#detail").hidden');
  assert.match(await evaluate(app.session, 'document.querySelector("#detail-view").textContent'), /alice@fixture\.test/);
  await shot(app.session, 'passkey-detail');
  await click(app.session, '#detail .back-button');
  await absent('/src/inline/passkey.html#');

  // Cards and identities: saved through the real dialog, then filled on checkout/address forms.
  s = await state(app.session);
  await rpc(app.session, 'SAVE', { session: s.session, revision: s.revision, item: { type: 'card', name: 'Test Visa', cardholder: 'Ada Lovelace', number: '4242424242424242', expiryMonth: '4', expiryYear: '2029', cvv: '123' } });
  s = await state(app.session);
  await rpc(app.session, 'SAVE', { session: s.session, revision: s.revision, item: { type: 'identity', name: 'Ada Home', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test', address: '12 Analytical Way', city: 'London', region: 'CA', postal: '90210', country: 'United States' } });
  await click(app.session, '[data-view="cards"]');
  await waitFor(app.session, 'document.querySelectorAll("#items .item-row").length === 2 && document.querySelector("#count-cards").textContent === "2"');
  assert.match(await evaluate(app.session, 'document.querySelector("#items").textContent'), /Visa ···· 4242/, 'Card rows show brand + last4, never the full number');
  assert.doesNotMatch(await evaluate(app.session, 'document.querySelector("#items").textContent'), /4242424242424242/);
  await evaluate(app.session, '[...document.querySelectorAll("#items .item-row")].find(r => r.textContent.includes("Test Visa")).click()');
  await waitFor(app.session, '!document.querySelector("#detail").hidden && document.querySelector("#detail-view").textContent.includes("04/2029")');
  await shot(app.session, 'card-detail');
  await click(app.session, '#detail .back-button');

  // Checkout form: focus the card field, pick the card, every field fills (selects included).
  // (Focus events are deferred on a backgrounded tab — bring it forward first, then
  // re-focus until the just-injected content script has its listener up.)
  const openPanel = async selector => {
    for (let i = 0; i < 20; i++) {
      if ((await send('Target.getTargets')).targetInfos.some(t => t.url.includes(PANEL))) return;
      await evaluate(site.session, `document.activeElement?.blur?.(); document.querySelector(${JSON.stringify(selector)}).focus()`);
      await delay(300);
    }
  };
  await send('Target.activateTarget', { targetId: site.targetId });
  await navigate(site.session, `${url}/checkout.html`);
  await openPanel('#cc-number');
  panel = await frameTarget(PANEL);
  await waitFor(panel, 'document.querySelectorAll(".account").length === 1 && document.querySelector(".account").textContent.includes("Test Visa")');
  await shot(site.session, 'card-dropdown');
  await click(panel, '.account');
  await waitFor(site.session, 'document.querySelector("#cc-number").value === "4242424242424242"');
  assert.equal(await evaluate(site.session, '[["#cc-name","Ada Lovelace"],["#cc-csc","123"],["#cc-exp-month","4"],["#cc-exp-year","2029"]].every(([sel, v]) => document.querySelector(sel).value === v)'), true, 'Every card field filled');
  console.log('PASS: a saved card fills number, name, expiry selects, and CVV on a checkout form.');

  // Address form: the same for an identity (focusing a street field — email stays a login field).
  await navigate(site.session, `${url}/identity.html`);
  await openPanel('#street');
  panel = await frameTarget(PANEL);
  await waitFor(panel, 'document.querySelectorAll(".account").length === 1 && document.querySelector(".account").textContent.includes("Ada Home")');
  await click(panel, '.account');
  await waitFor(site.session, 'document.querySelector("#street").value === "12 Analytical Way"');
  assert.equal(await evaluate(site.session, '[["#fname","Ada"],["#lname","Lovelace"],["#email","ada@example.test"],["#city","London"],["#region","CA"],["#zip","90210"],["#country","United States"]].every(([sel, v]) => document.querySelector(sel).value === v)'), true, 'Every identity field filled');
  console.log('PASS: a saved identity fills name, email, address, and selects on an address form.');

  // Signing in returns a real assertion and bumps the authenticator counter.
  await send('Target.activateTarget', { targetId: pk.targetId });
  await click(pk.session, '#signin');
  passkeyCard = await frameTarget('/src/inline/passkey.html#');
  await waitFor(passkeyCard, 'document.querySelector("#heading").textContent === "Sign in with a passkey?"');
  await click(passkeyCard, '#save');
  await waitFor(pk.session, 'document.querySelector("#out").textContent.startsWith("signed ")');
  assert.match(await evaluate(pk.session, 'document.querySelector("#out").textContent'), /sig:(6[4-9]|7[0-9]) handle:true/, 'The assertion has a signature and user handle');
  assert.equal((await rpc(app.session, 'ITEM', { session: s.session, id: keyItem.id })).data.item.signCount, 1, 'The sign-in bumped the signature counter');

  // A ceremony for a credential KeyBit does not hold passes through natively — headless errors out.
  await click(pk.session, '#signin-unknown');
  await waitFor(pk.session, 'document.querySelector("#out").textContent.startsWith("error ")', 60);
  await absent('/src/inline/passkey.html#');
  console.log('PASS: passkeys create, sign in with a real assertion, and delegate unknown credentials natively.');

  // Recovery kit: split the vault's recovery into shares, lock, and rebuild with any two.
  await click(app.session, '[data-view="settings"]');
  await click(app.session, '#create-kit');
  await waitFor(app.session, 'document.querySelector("#kit-dialog").open');
  await evaluate(app.session, 'document.querySelector("#kit-threshold").value = "2"; document.querySelector("#kit-count").value = "3"');
  // Capture the downloaded bundle: hook createObjectURL before the download click.
  await evaluate(app.session, 'window.__kitFile = null; const orig = URL.createObjectURL.bind(URL); URL.createObjectURL = blob => { blob.text().then(text => { window.__kitFile = text; }); return orig(blob); }');
  await click(app.session, '#kit-create');
  await waitFor(app.session, '!document.querySelector("#kit-result").hidden && document.querySelectorAll("#kit-shares code").length === 3');
  const shares = await evaluate(app.session, '[...document.querySelectorAll("#kit-shares code")].map(node => node.textContent)');
  await click(app.session, '#kit-download');
  await waitFor(app.session, 'typeof window.__kitFile === "string" && window.__kitFile.length > 200');
  const kitFile = join(scratch, 'recovery.kvault');
  await writeFile(kitFile, await evaluate(app.session, 'window.__kitFile'));
  await shot(app.session, 'kit-result');
  await click(app.session, '#kit-cancel');
  console.log('PASS: recovery kit dialog splits the vault secret into shares and downloads the encrypted bundle.');

  // Lock, then recover with two shares: the vault is replaced and the new master takes over.
  await rpc(app.session, 'LOCK', {});
  await waitFor(app.session, '!document.querySelector("#locked").hidden');
  await click(app.session, '#recover-instead');
  await waitFor(app.session, 'document.querySelector("#recover-dialog").open');
  await chooseFile('#recover-file', kitFile);
  await set(app.session, '#recover-shares', shares.slice(0, 2).join('\n'));
  await set(app.session, '#recover-password', 'a fresh master password');
  await set(app.session, '#recover-confirm', 'a fresh master password');
  await click(app.session, '#recover-go');
  await waitFor(app.session, 'document.querySelector("#message").textContent.startsWith("Vault recovered")', 90);
  await click(app.session, '[data-view="logins"]');
  await waitFor(app.session, 'document.querySelectorAll("#items .login-item").length > 0');
  await shot(app.session, 'recovered');
  console.log('PASS: two shares plus the recovery file restore the vault with a new master password.');

  // The old master password is dead; too few shares are rejected before any change.
  await rpc(app.session, 'LOCK', {});
  await waitFor(app.session, '!document.querySelector("#locked").hidden');
  for (let i = 0; i < 10 && !(await evaluate(app.session, 'document.querySelector("#message").hidden')); i++) {
    await evaluate(app.session, 'document.querySelector("#message")?.click()');
    await delay(200);
  }
  await set(app.session, '#master-password', password);
  await evaluate(app.session, 'document.querySelector("#auth form").requestSubmit()');
  await waitFor(app.session, 'document.querySelector("#message").textContent.includes("Incorrect master password")');
  await click(app.session, '#recover-instead');
  await chooseFile('#recover-file', kitFile);
  await set(app.session, '#recover-shares', shares[0]);
  await set(app.session, '#recover-password', 'a fresh master password');
  await set(app.session, '#recover-confirm', 'a fresh master password');
  await click(app.session, '#recover-go');
  await waitFor(app.session, '!document.querySelector("#recover-error").hidden && document.querySelector("#recover-error").textContent.includes("needs 2 shares")');
  await click(app.session, '#recover-cancel');
  await set(app.session, '#master-password', 'a fresh master password');
  await evaluate(app.session, 'document.querySelector("#auth form").requestSubmit()');
  await waitFor(app.session, '!document.querySelector("#app").hidden');
  console.log('PASS: the old master password stops working and a single share cannot recover.');

  const unexpected = errors.filter(event => !JSON.stringify(event).includes('favicon.ico'));
  assert.deepEqual(unexpected, []);
  console.log('PASS: no captured extension JavaScript/CSP errors.');
} finally {
  await browser.close(); server.close();
  if (!process.env.KEEP_ARTIFACTS) await rm(join(scratch, 'export.csv'), { force: true });
}
