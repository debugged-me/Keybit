import { Vault } from "../vault/vault.js";
import { chromeVaultStorage } from "../vault/storage.js";
import { matchesCredential, parseWebsite } from "../matching/url-matcher.js";
import { Suggestions, SITE_SCRIPTS } from "./suggestions.js";
import { SavePrompts } from "./save-prompts.js";

let savePrompts;
const vault = new Vault(chromeVaultStorage(), Date.now, () => { savePrompts?.clear(); keepAlive(); });
const trustedPages = ["src/popup/popup.html", "src/vault-ui/vault.html", "src/settings/settings.html"].map(path => chrome.runtime.getURL(path));
const suggestions = new Suggestions(vault, fill);
savePrompts = new SavePrompts(vault, suggestions);
const ready = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).then(() => suggestions.refresh());
let queue = Promise.resolve();
let lockTimer;
let keepAliveTimer;
let commandEpoch = 0;

function trusted(sender) {
  return sender.id === chrome.runtime.id && trustedPages.includes(sender.url?.split(/[?#]/)[0]) && (!Number.isInteger(sender.frameId) || sender.frameId === 0);
}
async function publish() {
  const state = await vault.status();
  // Having no open extension UI is normal; this event contains no credential data.
  await chrome.runtime.sendMessage({ event: "vault-state", state }).catch(() => {});
}
function scheduleLock() {
  clearTimeout(lockTimer);
  if (vault.deadline) lockTimer = setTimeout(() => { vault.expire(); keepAlive(); void publish(); }, Math.max(0, vault.deadline - Date.now()));
  keepAlive();
}
// Extension API calls reset Chromium's 30-second worker idle timer. While unlocked, this keeps the
// in-memory key until auto-lock, manual lock, browser exit, or extension reload instead of worker suspension.
function keepAlive() {
  if (vault.unlocked && !keepAliveTimer) keepAliveTimer = setInterval(() => { if (vault.unlocked) void chrome.runtime.getPlatformInfo(); else keepAlive(); }, 20000);
  else if (!vault.unlocked && keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = undefined; }
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
async function fill(message) {
  const item = vault.item(message.session, message.id);
  if (!matchesCredential(item, message.origin)) throw new Error("This login does not match the current website.");
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id !== message.tabId) throw new Error("The active tab changed. Reopen the extension.");
  const page = await detect(message.tabId);
  vault.require(message.session);
  if (page.origin !== message.origin || !matchesCredential(item, page.origin)) throw new Error("The page changed. Reopen the extension.");
  if (message.expectedDocumentId && page.documentId !== message.expectedDocumentId) throw new Error("The page changed. Focus the login field again.");
  if (page.forms !== 1) throw new Error("There must be one visible, supported login form to fill.");
  let results;
  try {
    results = await chrome.scripting.executeScript({ target: { tabId: message.tabId, documentIds: [page.documentId] }, world: "ISOLATED",
      func: (origin, username, password) => globalThis.__keybit.fill(origin, username, password),
      args: [page.origin, item.username, item.password] });
  } catch { throw new Error("The page changed before filling. Reopen the extension and try again."); }
  const result = results[0]?.result;
  if (!result?.ok) throw new Error(result?.error ?? "Could not fill this form.");
  return { filled: true };
}
async function handle(message, sender) {
  if (message.type === "INLINE_OPEN") return suggestions.open(sender);
  if (message.type === "CAPTURE_LOGIN") return savePrompts.capture(message, sender);
  if (message.type === "SAVE_PROMPT_OPEN") return savePrompts.open(sender);
  if (message.type.startsWith("SAVE_PROMPT_")) return savePrompts.panel(message, sender);
  if (message.type.startsWith("PANEL_")) return suggestions.panel(message, sender);
  switch (message.type) {
    case "STATUS": return vault.status();
    case "CREATE": return vault.create(message.password);
    case "UNLOCK": return vault.unlock(message.password);
    case "TOUCH": vault.touch(message.session); return vault.status();
    case "LIST": return vault.list(message.session, message.query, message.url);
    case "ITEM": vault.touch(message.session); return { item: vault.item(message.session, message.id), state: await vault.status() };
    case "COPY": {
      vault.touch(message.session);
      if (!["username", "password"].includes(message.field)) throw new Error("Unsupported copy action.");
      return vault.item(message.session, message.id)[message.field];
    }
    case "SAVE": return vault.saveItem(message.session, message.revision, message.item);
    case "DELETE": return vault.deleteItem(message.session, message.revision, message.id);
    case "SETTINGS": return vault.settings(message.session, message.settings);
    case "DETECT": return detect(message.tabId);
    case "SITE_STATUS": return suggestions.site(message.origin);
    case "DISABLED_SITES": return suggestions.disabled;
    case "SET_SITE_ENABLED":
      if (!message.enabled) savePrompts.clear();
      return suggestions.setEnabled(message.origin, message.enabled === true);
    case "FILL": vault.touch(message.session); return fill(message);
    case "EXPORT": return vault.export();
    case "PREPARE_IMPORT": return vault.prepareImport(message.text, message.password);
    case "COMMIT_IMPORT": return vault.commitImport(message.token, message.confirmed);
    default: throw new Error("Unsupported vault action.");
  }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message || typeof message.type !== "string" || sender.id !== chrome.runtime.id) return false;
  const fromContent = ["INLINE_OPEN", "CAPTURE_LOGIN", "SAVE_PROMPT_OPEN"].includes(message.type) && sender.frameId === 0 && Number.isInteger(sender.tab?.id);
  const fromPanel = ["PANEL_STATE", "PANEL_FILL", "PANEL_OPEN"].includes(message.type) && sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL("src/inline/panel.html") && sender.frameId > 0;
  const fromSavePanel = ["SAVE_PROMPT_STATE", "SAVE_PROMPT_CONFIRM", "SAVE_PROMPT_DISMISS"].includes(message.type) && sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL("src/inline/save.html") && sender.frameId > 0;
  if (!trusted(sender) && !fromContent && !fromPanel && !fromSavePanel) return false;
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
      const data = await handle(message, sender);
      reply({ ok: true, data });
      if (["CREATE", "UNLOCK", "SAVE", "DELETE", "SETTINGS", "PREPARE_IMPORT", "COMMIT_IMPORT", "SAVE_PROMPT_CONFIRM"].includes(message.type)) await publish();
    } catch (error) {
      reply({ ok: false, error: error?.name === "Error" ? error.message : "The operation could not be completed. Please try again." });
    } finally { scheduleLock(); }
  });
  return true;
});
chrome.permissions.onRemoved.addListener(() => savePrompts.clear());
chrome.runtime.onInstalled.addListener(async () => {
  // Manifest content scripts only reach pages loaded after install or update.
  for (const tab of await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }).catch(() => [])) {
    chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: SITE_SCRIPTS }).catch(() => {});
  }
});
chrome.tabs.onRemoved.addListener(tabId => savePrompts.forgetTab(tabId));
// No session key or plaintext is restored when this worker starts. A restart or reload locks the vault.
