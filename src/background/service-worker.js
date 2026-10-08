import { Vault } from "../vault/vault.js";
import { chromeVaultStorage } from "../vault/storage.js";
import { matchesCredential, parseWebsite } from "../matching/url-matcher.js";
import { totpCode } from "../vault/totp.js";
import { fromBase64 } from "../crypto/encoding.js";
import { sealRawKey, openRawKey } from "../crypto/biometric.js";
import { Suggestions, SITE_SCRIPTS } from "./suggestions.js";
import { SavePrompts } from "./save-prompts.js";
import { PasskeyPrompts } from "./passkeys.js";
import { Usage, Steps } from "./usage.js";
import { writeBackup } from "./auto-backup.js";
// Classic script, imported for its side effect: registers Peek's pure helpers on
// globalThis.__keybitPeek.utils. Peek is a separate domain — it shares no vault objects.
import "../peek/peek-utils.js";

let savePrompts;
let passkeyPrompts;
const steps = new Steps();
const usage = new Usage();
const vault = new Vault(chromeVaultStorage(), Date.now, () => { savePrompts?.clear(); passkeyPrompts?.clear(); steps.clear(); keepAlive(); });
const trustedPages = ["src/popup/popup.html", "src/vault-ui/vault.html"].map(path => chrome.runtime.getURL(path));
const suggestions = new Suggestions(vault, fill, { usage, steps });
savePrompts = new SavePrompts(vault, suggestions, Date.now, steps);
passkeyPrompts = new PasskeyPrompts(vault, suggestions);
const ready = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).then(() => Promise.all([suggestions.refresh(), usage.load()]));
let queue = Promise.resolve();
let lockTimer;
let keepAliveTimer;
let commandEpoch = 0;
// Messages that change the encrypted vault: open pages refresh, and the backup folder gets a fresh copy.
const WRITES = ["CREATE", "SAVE", "DELETE", "RESTORE", "PURGE", "EMPTY_TRASH", "SETTINGS", "COMMIT_IMPORT", "SAVE_PROMPT_CONFIRM", "IMPORT_COMMIT", "MERGE_BACKUP", "CHANGE_PASSWORD", "PASSKEY_CONFIRM"];
// Peek messages a page's content script may send. PEEK_SAVE_SETTINGS stays trusted-pages only.
const PEEK_CONTENT_MESSAGES = ["PEEK_GET_SETTINGS", "PEEK_OPEN_TAB"];
const PEEK_SCRIPTS = ["src/peek/peek-utils.js", "src/peek/peek-settings.js", "src/peek/peek-frame.js",
  "src/peek/peek-overlay.js", "src/peek/peek-link-handler.js", "src/peek/peek-controller.js"];
const peekUtils = () => globalThis.__keybitPeek.utils;
// Peek settings are plain preferences: chrome.storage.local, outside the vault, never queued
// behind vault work and never near decrypted data.
async function peekGetSettings() {
  const { peek } = await chrome.storage.local.get("peek");
  return peekUtils().sanitizeSettings(peek);
}
async function peekSaveSettings(raw) {
  const settings = peekUtils().sanitizeSettings(raw);
  await chrome.storage.local.set({ peek: settings });
  // Content scripts keep a settings cache so clicks are decided synchronously; push the change.
  for (const tab of await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }).catch(() => []))
    chrome.tabs.sendMessage(tab.id, { event: "keybit-peek-settings", settings }, { frameId: 0 }).catch(() => {});
  return settings;
}
// Content-script URLs are validated again here before any tab is opened.
async function peekOpenTab(message, sender) {
  const url = peekUtils().peekUrl(message.url);
  if (!url) throw new Error("That link can't be opened.");
  await chrome.tabs.create({ url: url.href, ...(Number.isInteger(sender.tab?.windowId) ? { windowId: sender.tab.windowId } : {}) });
  return { opened: true };
}
function peekHandle(message, sender) {
  switch (message.type) {
    case "PEEK_GET_SETTINGS": return peekGetSettings();
    case "PEEK_SAVE_SETTINGS": return peekSaveSettings(message.settings);
    case "PEEK_OPEN_TAB": return peekOpenTab(message, sender);
    default: throw new Error("Unsupported Peek action.");
  }
}

function trusted(sender) {
  return sender.id === chrome.runtime.id && trustedPages.includes(sender.url?.split(/[?#]/)[0]) && (!Number.isInteger(sender.frameId) || sender.frameId === 0);
}
async function status() {
  const state = await vault.status();
  const { biometric } = await chrome.storage.local.get("biometric");
  return { ...state, biometric: !!biometric };
}
async function publish() {
  // Having no open extension UI is normal; this event contains no credential data.
  await chrome.runtime.sendMessage({ event: "vault-state", state: await status() }).catch(() => {});
}
function scheduleLock() {
  clearTimeout(lockTimer);
  if (vault.deadline) lockTimer = setTimeout(() => { vault.expire(); keepAlive(); void publish(); }, Math.max(0, vault.deadline - Date.now()));
  keepAlive();
}
// Extension API calls reset Chromium's 30-second worker idle timer. While unlocked, this keeps the
// in-memory key until auto-lock, manual lock, screen lock, browser exit, or extension reload instead of worker suspension.
function keepAlive() {
  if (vault.unlocked && !keepAliveTimer) keepAliveTimer = setInterval(() => { if (vault.unlocked) void chrome.runtime.getPlatformInfo(); else keepAlive(); }, 20000);
  else if (!vault.unlocked && keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = undefined; }
}
async function autoBackup() {
  try {
    const result = await writeBackup(await vault.export());
    if (result.status !== "off") await chrome.storage.local.set({ autoBackup: result });
  } catch { await chrome.storage.local.set({ autoBackup: { status: "error" } }).catch(() => {}); }
}
// Clipboard clearing lives in an offscreen document: unlike a page's timer, it fires even if the
// popup or window that copied is already closed, and it does not keep this worker awake.
async function armClipboard(value, ms) {
  if (typeof value !== "string" || !value || typeof chrome.offscreen?.createDocument !== "function") return false;
  try {
    await chrome.offscreen.createDocument({ url: chrome.runtime.getURL("src/offscreen/clipboard.html"),
      reasons: ["CLIPBOARD"], justification: "Clear copied passwords and codes from the clipboard after 30 seconds." });
  } catch (error) {
    if (!/single offscreen/i.test(error?.message ?? "")) return false;
  }
  await chrome.runtime.sendMessage({ type: "CLIPBOARD_ARM", value, ms }).catch(() => {});
  return true;
}
async function detect(tabId) {
  if (!Number.isInteger(tabId)) throw new Error("Open a website and reopen the extension.");
  try {
    const tab = await chrome.tabs.get(tabId);
    const origin = parseWebsite(tab.url).origin;
    const results = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: "ISOLATED",
      files: ["src/content/form-detector.js", "src/content/autofill.js", "src/content/content.js"] });
    const main = results.find(result => result.frameId === 0);
    if (!main?.documentId || main.result?.origin !== origin) throw new Error("Page changed");
    return { ...main.result, documentId: main.documentId };
  } catch { throw new Error("Cannot inspect this page. Open a regular HTTP or HTTPS website and reopen the extension."); }
}
// Fills the page's login form, the username step of a two-step sign-in, a card or identity
// form, or (otp) its 2FA code field. Cards and IDs fill anywhere — they are not site-bound.
async function fill(message) {
  const item = vault.item(message.session, message.id);
  if (item.type === "login" && !matchesCredential(item, message.url)) throw new Error("This login does not match the current website.");
  if (!["login", "card", "identity"].includes(item.type)) throw new Error("This item can't be filled.");
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id !== message.tabId) throw new Error("The active tab changed. Reopen the extension.");
  const page = await detect(message.tabId);
  vault.require(message.session);
  if (page.origin !== parseWebsite(message.url).origin || (item.type === "login" && !matchesCredential(item, page.url))) throw new Error("The page changed. Reopen the extension.");
  if (message.expectedDocumentId && page.documentId !== message.expectedDocumentId) throw new Error("The page changed. Focus the field again.");
  let call;
  if (item.type === "card") call = ["fillCard", { number: item.number, cardholder: item.cardholder, expiryMonth: item.expiryMonth, expiryYear: item.expiryYear, cvv: item.cvv }];
  else if (item.type === "identity") call = ["fillIdentity", { firstName: item.firstName, lastName: item.lastName, email: item.email, phone: item.phone, address: item.address, address2: "", city: item.city, region: item.region, postal: item.postal, country: item.country, company: item.company }];
  else if (message.otp) {
    if (!item.totp) throw new Error("This login has no 2FA code.");
    if (page.otpForms !== 1) throw new Error("There must be one visible 2FA code field to fill.");
    call = ["fillOtp", (await totpCode(item.totp)).code];
  } else if (page.forms === 1) call = ["fill", item.username, item.password];
  else if (!page.forms && page.usernameForms === 1) call = ["fillUsername", item.username];
  else throw new Error("There must be one visible, supported login form to fill.");
  let results;
  try {
    results = await chrome.scripting.executeScript({ target: { tabId: message.tabId, documentIds: [page.documentId] }, world: "ISOLATED",
      func: (origin, method, ...args) => ["fill", "fillUsername", "fillOtp", "fillCard", "fillIdentity"].includes(method) ? globalThis.__keybit[method](origin, ...args) : null,
      args: [page.origin, ...call] });
  } catch { throw new Error("The page changed before filling. Reopen the extension and try again."); }
  const result = results[0]?.result;
  if (!result?.ok) throw new Error(result?.error ?? "Could not fill this form.");
  usage.touch(item.id);
  // A username-only step: offer this account first on the password page that follows.
  if (call[0] === "fillUsername") steps.remember(message.tabId, page.origin, { id: item.id, username: item.username });
  return { filled: true };
}
async function biometricUnlock(prf) {
  const { biometric } = /** @type {any} */ (await chrome.storage.local.get("biometric"));
  if (!biometric) throw new Error("Touch ID unlock is off. Unlock with your master password.");
  const raw = await openRawKey(biometric.sealed, fromBase64(prf, 32), biometric.credentialId);
  try { return await vault.unlockWithRawKey(raw); } finally { raw.fill(0); }
}
async function biometricEnable(message) {
  const raw = await vault.rawKeyFor(message.session, message.password);
  try {
    if (typeof message.credentialId !== "string" || typeof message.salt !== "string") throw new Error("Touch ID setup failed. Try again.");
    const sealed = await sealRawKey(raw, fromBase64(message.prf, 32), message.credentialId);
    await chrome.storage.local.set({ biometric: { credentialId: message.credentialId, salt: message.salt, sealed } });
  } finally { raw.fill(0); }
  return status();
}
async function handle(message, sender) {
  if (message.type === "INLINE_OPEN") return suggestions.open(sender, message.mode);
  if (message.type === "CAPTURE_LOGIN") return savePrompts.capture(message, sender);
  if (message.type === "CAPTURE_USERNAME") return savePrompts.captureUsername(message, sender);
  if (message.type === "SAVE_PROMPT_OPEN") return savePrompts.open(sender);
  if (message.type === "PASSKEY_CREATE") return passkeyPrompts.request("create", message, sender);
  if (message.type === "PASSKEY_GET") return passkeyPrompts.request("get", message, sender);
  if (message.type.startsWith("SAVE_PROMPT_")) return savePrompts.panel(message, sender);
  if (message.type.startsWith("PASSKEY_")) return passkeyPrompts.panel(message, sender);
  if (message.type.startsWith("PANEL_")) return suggestions.panel(message, sender);
  switch (message.type) {
    case "STATUS": return status();
    case "CREATE": return vault.create(message.password);
    case "UNLOCK": return vault.unlock(message.password);
    case "TOUCH": vault.touch(message.session); return status();
    case "LIST": return usage.annotate(vault.list(message.session, message.query, message.url));
    case "PROJECTS": return vault.projects(message.session);
    case "HEALTH": return vault.health(message.session);
    case "ITEM": vault.touch(message.session); return { item: vault.item(message.session, message.id), state: await vault.status() };
    case "COPY": {
      vault.touch(message.session);
      if (!["username", "password"].includes(message.field)) throw new Error("Unsupported copy action.");
      return vault.item(message.session, message.id)[message.field];
    }
    case "TOTP": {
      vault.touch(message.session);
      const { totp } = vault.item(message.session, message.id);
      if (!totp) throw new Error("This login has no 2FA code.");
      return totpCode(totp);
    }
    case "SAVE": return vault.saveItem(message.session, message.revision, message.item);
    case "DELETE": {
      const state = await vault.deleteItem(message.session, message.revision, message.id);
      usage.prune(vault.list(state.session).map(item => item.id));
      return state;
    }
    case "TRASH_LIST": return vault.listDeleted(message.session);
    case "RESTORE": return vault.restoreItem(message.session, message.revision, message.id);
    case "PURGE": {
      const state = await vault.purgeItem(message.session, message.revision, message.id);
      usage.prune(vault.list(state.session).map(item => item.id));
      return state;
    }
    case "EMPTY_TRASH": {
      const state = await vault.emptyTrash(message.session, message.revision);
      usage.prune(vault.list(state.session).map(item => item.id));
      return state;
    }
    case "SETTINGS": return vault.settings(message.session, message.settings);
    case "CHANGE_PASSWORD": {
      const state = await vault.changePassword(message.session, message.current, message.next);
      // Touch ID sealed the old key; it must be set up again with the new password.
      await chrome.storage.local.remove("biometric");
      return state;
    }
    case "BIOMETRIC_INFO": {
      const { biometric } = /** @type {any} */ (await chrome.storage.local.get("biometric"));
      return biometric ? { credentialId: biometric.credentialId, salt: biometric.salt } : null;
    }
    case "BIOMETRIC_ENABLE": return biometricEnable(message);
    case "BIOMETRIC_DISABLE": await chrome.storage.local.remove("biometric"); return status();
    case "BIOMETRIC_UNLOCK": return biometricUnlock(message.prf);
    case "IMPORT_PREVIEW": return vault.previewImport(message.session, message.items);
    case "IMPORT_COMMIT": return vault.importItems(message.session, message.revision, message.items);
    case "MERGE_BACKUP": return vault.mergeBackup(message.session, message.revision, message.text, message.password);
    case "BACKUP_NOW": await autoBackup(); return (await chrome.storage.local.get("autoBackup")).autoBackup ?? null;
    case "DETECT": return detect(message.tabId);
    case "DISABLED_SITES": return suggestions.disabled;
    case "SET_SITE_ENABLED":
      if (!message.enabled) savePrompts.clear();
      return suggestions.setEnabled(message.origin, message.enabled === true);
    case "FILL": vault.touch(message.session); return fill(message);
    case "EXPORT": return vault.export();
    case "EXPORT_CSV": vault.touch(message.session); return vault.exportCsv(message.session);
    case "CLIPBOARD_ARM": return armClipboard(message.value, message.ms);
    case "SHARE_ITEM": vault.touch(message.session); return vault.shareItem(message.session, message.id, message.password);
    case "RECOVERY_KIT": vault.touch(message.session); return vault.recoveryKit(message.session, message.threshold, message.count);
    case "PREPARE_IMPORT": return vault.prepareImport(message.text, message.password);
    case "COMMIT_IMPORT": {
      const state = await vault.commitImport(message.token, message.confirmed);
      // A replaced vault has a different key; Touch ID must be set up again.
      await chrome.storage.local.remove("biometric");
      return state;
    }
    default: throw new Error("Unsupported vault action.");
  }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message || typeof message.type !== "string" || sender.id !== chrome.runtime.id) return false;
  const fromContent = ["INLINE_OPEN", "CAPTURE_LOGIN", "CAPTURE_USERNAME", "SAVE_PROMPT_OPEN", "PASSKEY_CREATE", "PASSKEY_GET"].includes(message.type) && sender.frameId === 0 && Number.isInteger(sender.tab?.id);
  const fromPanel = ["PANEL_STATE", "PANEL_FILL", "PANEL_FILL_NEW", "PANEL_OPEN"].includes(message.type) && sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL("src/inline/panel.html") && sender.frameId > 0;
  const fromSavePanel = ["SAVE_PROMPT_STATE", "SAVE_PROMPT_CONFIRM", "SAVE_PROMPT_DISMISS"].includes(message.type) && sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL("src/inline/save.html") && sender.frameId > 0;
  const fromPasskeyPanel = ["PASSKEY_STATE", "PASSKEY_CONFIRM", "PASSKEY_DISMISS"].includes(message.type) && sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL("src/inline/passkey.html") && sender.frameId > 0;
  const fromPeek = PEEK_CONTENT_MESSAGES.includes(message.type) && sender.frameId === 0 && Number.isInteger(sender.tab?.id);
  if (!trusted(sender) && !fromContent && !fromPanel && !fromSavePanel && !fromPasskeyPanel && !fromPeek) return false;
  if (message.type.startsWith("PEEK_")) {
    // Peek answers on its own path: never queued behind vault work, never touching vault state.
    void Promise.resolve()
      .then(() => peekHandle(message, sender))
      .then(data => reply({ ok: true, data }))
      .catch(error => reply({ ok: false, error: error?.name === "Error" ? error.message : "The operation could not be completed. Please try again." }));
    return true;
  }
  if (message.type === "LOCK") {
    // Lock immediately, even if an encryption operation is pending in the queue.
    commandEpoch++; vault.lock(); scheduleLock();
    void publish();
    reply({ ok: true });
    return false;
  }
  const epoch = commandEpoch;
  queue = queue.then(async () => {
    try {
      await ready;
      if (epoch !== commandEpoch) throw new Error("Operation cancelled because the vault was locked.");
      let data = await handle(message, sender);
      // Every vault state the worker returns carries the Touch ID flag, so pages compare like with like.
      if (data && typeof data === "object" && "unlocked" in data && "exists" in data && !("biometric" in data)) data = { ...data, biometric: !!(await chrome.storage.local.get("biometric")).biometric };
      reply({ ok: true, data });
      if ([...WRITES, "UNLOCK", "PREPARE_IMPORT", "BIOMETRIC_UNLOCK", "BIOMETRIC_ENABLE", "BIOMETRIC_DISABLE"].includes(message.type)) await publish();
      if (WRITES.includes(message.type)) void autoBackup();
    } catch (error) {
      reply({ ok: false, error: error?.name === "Error" ? error.message : "The operation could not be completed. Please try again." });
    } finally { scheduleLock(); }
  });
  return true;
});
// Lock when the computer's screen locks or it goes to sleep (on by default; Settings can turn it off).
chrome.idle.onStateChanged.addListener(state => {
  if (state !== "locked" || !vault.unlocked || vault.currentSettings?.lockOnScreenLock === false) return;
  commandEpoch++; vault.lock(); scheduleLock();
  void publish();
});
chrome.permissions.onRemoved.addListener(() => savePrompts.clear());
chrome.runtime.onInstalled.addListener(async details => {
  // Manifest content scripts only reach pages loaded after install or update.
  for (const tab of await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }).catch(() => [])) {
    chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: [...SITE_SCRIPTS, ...PEEK_SCRIPTS] }).catch(() => {});
  }
  if (details.reason === "install") void chrome.tabs.create({ url: chrome.runtime.getURL("src/vault-ui/vault.html#welcome") });
});
chrome.tabs.onRemoved.addListener(tabId => { savePrompts.forgetTab(tabId); passkeyPrompts.forgetTab(tabId); steps.forget(tabId); });
chrome.commands.onCommand.addListener(async (command, tab) => {
  // The keyboard shortcut asks the page's KeyBit script to open the dropdown on the focused login field.
  if (command !== "show-suggestions") return;
  const target = tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (Number.isInteger(target?.id)) chrome.tabs.sendMessage(target.id, { event: "keybit-show" }, { frameId: 0 }).catch(() => {});
});
// No session key or plaintext is restored when this worker starts. A restart or reload locks the vault.
