import { Vault } from "../vault/vault.js";
import { chromeVaultStorage } from "../vault/storage.js";
import { matchesCredential, parseWebsite } from "../matching/url-matcher.js";
import { totpCode } from "../vault/totp.js";
import { fromBase64 } from "../crypto/encoding.js";
import { sealRawKey, openRawKey } from "../crypto/biometric.js";
import { Suggestions, FRAME_SCRIPTS } from "./suggestions.js";
import { SavePrompts } from "./save-prompts.js";
import { PasskeyPrompts } from "./passkeys.js";
import { Usage, Steps } from "./usage.js";
import { writeBackup } from "./auto-backup.js";
import { buildCommands } from "../command/registry.js";
import { loadPrefs, generate as generateSecret } from "../generator/prefs.js";

let savePrompts;
let passkeyPrompts;
const steps = new Steps();
const usage = new Usage();
const vault = new Vault(chromeVaultStorage(), Date.now, () => { savePrompts?.clear(); passkeyPrompts?.clear(); steps.clear(); keepAlive(); });
const trustedPages = ["src/popup/popup.html", "src/vault-ui/vault.html", "src/developer/inspector.html", "src/command/palette.html"].map(path => chrome.runtime.getURL(path));
const suggestions = new Suggestions(vault, fill, { usage, steps });
savePrompts = new SavePrompts(vault, suggestions, Date.now, steps);
passkeyPrompts = new PasskeyPrompts(vault, suggestions);
const ready = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).then(() => Promise.all([suggestions.refresh(), usage.load()]));
let queue = Promise.resolve();
let lockTimer;
let keepAliveTimer;
let commandEpoch = 0;
// Messages that change the encrypted vault: open pages refresh, and the backup folder gets a fresh copy.
const WRITES = ["CREATE", "SAVE", "DELETE", "RESTORE", "PURGE", "EMPTY_TRASH", "SETTINGS", "SET_PROJECT_ENV", "COMMIT_IMPORT", "SAVE_PROMPT_CONFIRM", "IMPORT_COMMIT", "MERGE_BACKUP", "CHANGE_PASSWORD", "PASSKEY_CONFIRM"];
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
// ---- Command palette ----
// Each open issues a one-time token bound to that tab's URL; the palette iframe authenticates every
// query and run with it, so a page script can never drive commands or reach vault data directly.
const paletteContexts = new Map(); // token → { url, origin, tabId, expires }
function paletteContext(token) {
  const context = typeof token === "string" ? paletteContexts.get(token) : null;
  if (!context || context.expires < Date.now()) {
    if (context) paletteContexts.delete(token);
    throw new Error("The command palette closed. Press the shortcut to reopen it.");
  }
  context.expires = Date.now() + 120000;
  return context;
}
async function paletteOpen(sender) {
  let page;
  try { page = parseWebsite(sender.tab.url); } catch { throw new Error("The command palette works on http and https pages."); }
  for (const [key, context] of paletteContexts) if (context.expires < Date.now()) paletteContexts.delete(key);
  const token = crypto.randomUUID();
  paletteContexts.set(token, { url: page.href, origin: page.origin, tabId: sender.tab.id, expires: Date.now() + 120000 });
  return { token };
}
async function paletteQuery(message) {
  const context = paletteContext(message.token);
  const { session } = await vault.status();
  return buildCommands({ vault, session, ctx: context, query: String(message.query ?? "").slice(0, 200), rule: suggestions.ruleFor(context.origin) });
}
async function paletteRun(message) {
  const context = paletteContext(message.token);
  const command = message.command ?? {};
  const { session, unlocked } = await vault.status();
  const openPage = async path => { await chrome.tabs.create({ url: chrome.runtime.getURL(path) }); return { close: true }; };
  const needsUnlock = () => { if (!unlocked) throw new Error("Unlock KeyBit first."); };
  switch (command.id) {
    case "unlock":
    case "open": return openPage("src/vault-ui/vault.html");
    case "open-item": needsUnlock(); return openPage(`src/vault-ui/vault.html#item?id=${encodeURIComponent(String(command.item ?? ""))}`);
    case "note": needsUnlock(); return openPage("src/vault-ui/vault.html#new-note");
    case "security": needsUnlock(); return openPage("src/vault-ui/vault.html#health");
    case "inspect": return openPage(`src/developer/inspector.html?tab=${context.tabId}`);
    case "generate": {
      const password = await generateSecret(await loadPrefs());
      await armClipboard(password, 30000);
      return { close: true, password, message: "Password copied — clipboard clears in 30 seconds" };
    }
    case "lock": {
      commandEpoch++; vault.lock(); scheduleLock();
      void publish();
      return { close: true, message: "KeyBit locked" };
    }
    case "fill": {
      needsUnlock();
      await fill({ type: "FILL", session, id: String(command.item), url: context.url, tabId: context.tabId });
      return { close: true, message: "Filled" };
    }
    case "switch": {
      needsUnlock();
      const item = vault.list(session).find(entry => entry.type === "login" && entry.project === command.project);
      if (!item) throw new Error("That project has no logins to switch with.");
      if (command.production && vault.currentSettings?.confirmProduction && !message.confirmed) return { close: false, confirm: true };
      await switchEnvironment({ session, id: item.id, environment: command.env, tabId: context.tabId });
      return { close: true };
    }
    default: throw new Error("Unknown command.");
  }
}
async function detect(tabId) {
  if (!Number.isInteger(tabId)) throw new Error("Open a website and reopen the extension.");
  try {
    const tab = await chrome.tabs.get(tabId);
    const origin = parseWebsite(tab.url).origin;
    // Every frame reports its own origin/url and form counts; frames that reject injection
    // (closed roots, PDFs, chrome:// viewers) simply produce no result entry.
    const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: "ISOLATED",
      files: ["src/content/form-detector.js", "src/content/autofill.js", "src/content/content.js"] });
    const frames = (results ?? []).filter(result => result?.documentId && result.result?.origin)
      .map(result => ({ frameId: result.frameId, documentId: result.documentId, ...result.result }));
    const main = frames.find(frame => frame.frameId === 0);
    if (!main || main.origin !== origin) throw new Error("Page changed");
    const totals = { forms: 0, newForms: 0, usernameForms: 0, otpForms: 0, cardForms: 0, identityForms: 0 };
    for (const frame of frames) for (const key of Object.keys(totals)) totals[key] += frame[key] ?? 0;
    return { origin, url: tab.url, documentId: main.documentId, frames, ...totals };
  } catch { throw new Error("Cannot inspect this page. Open a regular HTTP or HTTPS website and reopen the extension."); }
}
// The Developer's form inspector: runs the detector plus structural analysis in every frame of
// the tab. The analysis script reports metadata only — it never reads a field value — and no
// vault data is involved, so this works locked or unlocked.
async function inspect(tabId) {
  if (!Number.isInteger(tabId)) throw new Error("Open a website and try again.");
  try {
    const tab = await chrome.tabs.get(tabId);
    const origin = parseWebsite(tab.url).origin;
    const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: "ISOLATED",
      files: ["src/content/form-detector.js", "src/developer/form-analysis.js"] });
    const frames = (results ?? []).filter(result => result?.result?.origin)
      .map(result => ({ frameId: result.frameId, documentId: result.documentId, top: result.frameId === 0,
        crossOrigin: result.result.origin !== origin, ...result.result }));
    frames.sort((a, b) => a.frameId - b.frameId);
    return { origin, url: tab.url, title: tab.title, frames };
  } catch { throw new Error("Cannot inspect this page. Open a regular HTTP or HTTPS website first."); }
}
// Project Environment Switcher: resolves the login's project + environment to a URL and moves the
// active tab there. Credentials are never auto-filled — after navigation the usual match/dropdown
// flow offers whichever login fits the new address. An environment with no URL resolves to nothing
// rather than guessing, so a switch can never land on (or fill) the wrong site.
async function switchEnvironment(message) {
  const item = vault.item(message.session, message.id);
  if (item.type !== "login" || !item.project) throw new Error("This login is not in a project.");
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id !== message.tabId) throw new Error("The active tab changed. Reopen the extension.");
  const target = vault.environmentTarget(message.session, item.project, message.environment, active.url);
  if (!target.url) return { url: null, project: item.project, environment: String(message.environment ?? "") };
  vault.touch(message.session);
  await chrome.tabs.update(message.tabId, { url: target.url });
  return { url: target.url, matched: !!target.itemId, project: item.project, environment: String(message.environment) };
}
// Fills a login form, the username step of a two-step sign-in, a card or identity form, or (otp) a 2FA
// field — in whichever document holds it. A fill can only land in a frame whose own origin the credential
// matches: a cross-origin iframe is filled with iframe-origin credentials, never the parent page's.
async function fill(message) {
  const item = vault.item(message.session, message.id);
  // A site with KeyBit turned off gets no fills at all — even explicit popup/palette ones.
  try { if (!suggestions.ruleFor(parseWebsite(message.url).origin).enabled) throw new Error("KeyBit is off for this site."); }
  catch (error) { if (error.message.includes("off for this site")) throw error; }
  if (item.type === "login" && !matchesCredential(item, message.url)) throw new Error("This login does not match the current website.");
  if (!["login", "card", "identity"].includes(item.type)) throw new Error("This item can't be filled.");
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id !== message.tabId) throw new Error("The active tab changed. Reopen the extension.");
  const page = await detect(message.tabId);
  vault.require(message.session);
  const wantOrigin = parseWebsite(message.url).origin;
  // Only frames on the requested origin can receive this credential — and for a login, only frames whose
  // own URL the credential actually matches. Panel fills additionally pin the frame and document.
  let frames = page.frames.filter(frame => frame.origin === wantOrigin && (item.type !== "login" || matchesCredential(item, frame.url)));
  if (message.expectedDocumentId) frames = frames.filter(frame => frame.documentId === message.expectedDocumentId);
  if (Number.isInteger(message.expectedFrameId)) frames = frames.filter(frame => frame.frameId === message.expectedFrameId);
  const options = [];
  const otpCode = message.otp ? (item.totp ? (await totpCode(item.totp)).code : null) : null;
  for (const frame of frames) {
    let call = null;
    if (item.type === "card") {
      call = frame.cardForms === 1 ? ["fillCard", { number: item.number, cardholder: item.cardholder, expiryMonth: item.expiryMonth, expiryYear: item.expiryYear, cvv: item.cvv }] : null;
    } else if (item.type === "identity") {
      call = frame.identityForms === 1 ? ["fillIdentity", { firstName: item.firstName, lastName: item.lastName, email: item.email, phone: item.phone,
        address: item.address, address2: "", city: item.city, region: item.region, postal: item.postal, country: item.country, company: item.company }] : null;
    } else if (message.otp) {
      if (item.totp && frame.otpForms === 1) call = ["fillOtp", otpCode];
    } else if (frame.forms === 1) call = ["fill", item.username, item.password];
    else if (!frame.forms && frame.usernameForms === 1) call = ["fillUsername", item.username];
    if (call) options.push({ frame, call });
  }
  // A panel choice names its document; a popup Fill prefers the top page (pre-1.4 behavior), then a
  // single matching subframe. Anything ambiguous refuses rather than guessing where secrets go.
  const chosen = message.expectedDocumentId ? options[0]
    : options.find(option => option.frame.frameId === 0) ?? (options.length === 1 ? options[0] : null);
  if (!chosen) {
    if (message.otp && !item.totp) throw new Error("This login has no 2FA code.");
    throw new Error(message.expectedDocumentId && !page.frames.some(frame => frame.documentId === message.expectedDocumentId)
      ? "The page changed. Focus the field again." : "There must be one visible, supported login form to fill.");
  }
  let results;
  try {
    results = await chrome.scripting.executeScript({ target: { tabId: message.tabId, documentIds: [chosen.frame.documentId] }, world: "ISOLATED",
      func: (origin, method, ...args) => ["fill", "fillUsername", "fillOtp", "fillCard", "fillIdentity"].includes(method) ? globalThis.__keybit[method](origin, ...args) : null,
      args: [chosen.frame.origin, ...chosen.call] });
  } catch { throw new Error("The page changed before filling. Reopen the extension and try again."); }
  const result = results[0]?.result;
  if (!result?.ok) throw new Error(result?.error ?? "Could not fill this form.");
  usage.touch(item.id);
  // A username-only step: offer this account first on the password page that follows.
  if (chosen.call[0] === "fillUsername") steps.remember(message.tabId, chosen.frame.origin, { id: item.id, username: item.username });
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
  // Per-site rules can turn off save prompts without affecting fill.
  if (message.type === "CAPTURE_LOGIN" || message.type === "CAPTURE_USERNAME") {
    try { if (!suggestions.offered(parseWebsite(sender.url).origin, "save")) return { available: false }; } catch { return { available: false }; }
    return message.type === "CAPTURE_LOGIN" ? savePrompts.capture(message, sender) : savePrompts.captureUsername(message, sender);
  }
  // Right-click "Generate password" fills the clicked field — no vault data involved, but it
  // follows the site's rule so a disabled site stays completely KeyBit-free.
  if (message.type === "CONTEXT_GENERATE") {
    let origin; try { origin = parseWebsite(sender.url).origin; } catch { origin = null; }
    if (origin && !suggestions.offered(origin, "logins")) throw new Error("KeyBit is off for this site.");
    return { password: await generateSecret(await loadPrefs()) };
  }
  if (message.type === "PALETTE_OPEN") return paletteOpen(sender);
  if (message.type === "PALETTE_QUERY") return paletteQuery(message);
  if (message.type === "PALETTE_RUN") return paletteRun(message);
  if (message.type === "PALETTE_CLOSE") { paletteContexts.delete(String(message.token ?? "")); return { closed: true }; }
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
    case "INSPECT": return inspect(message.tabId);
    case "ENVIRONMENTS": return vault.environments(message.session);
    case "SET_PROJECT_ENV": return vault.setProjectEnvironments(message.session, message.revision, message.project, message.environments);
    case "SWITCH_ENV": return switchEnvironment(message);
    case "DISABLED_SITES": return suggestions.disabled;
    case "SET_SITE_ENABLED": {
      if (!message.enabled) savePrompts.clear();
      const list = await suggestions.setEnabled(message.origin, message.enabled === true);
      void chrome.runtime.sendMessage({ event: "site-rules" }).catch(() => {});
      return list;
    }
    case "SITE_RULE": return suggestions.ruleFor(message.origin);
    case "SITE_RULES": return suggestions.siteRules();
    case "SET_SITE_RULE": {
      if (message.patch?.enabled === false) savePrompts.clear();
      const rule = await suggestions.setRule(message.origin, message.patch);
      // Open vault pages re-read their rule list; vault state itself is unchanged.
      void chrome.runtime.sendMessage({ event: "site-rules" }).catch(() => {});
      return rule;
    }
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
  // INLINE_OPEN is accepted from any frame — the worker binds the panel to the frame's own
  // documentId and URL origin. Save/passkey prompts stay top-frame only, so a cross-origin
  // iframe can never inject a credential capture or trigger a save/passkey prompt.
  const fromContent = ((["INLINE_OPEN", "CONTEXT_GENERATE"].includes(message.type) ? Number.isInteger(sender.frameId)
    : ["CAPTURE_LOGIN", "CAPTURE_USERNAME", "SAVE_PROMPT_OPEN", "PASSKEY_CREATE", "PASSKEY_GET", "PALETTE_OPEN"].includes(message.type) && sender.frameId === 0))
    && Number.isInteger(sender.tab?.id);
  const fromPanel = ["PANEL_STATE", "PANEL_FILL", "PANEL_FILL_NEW", "PANEL_OPEN"].includes(message.type) && sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL("src/inline/panel.html") && sender.frameId > 0;
  const fromSavePanel = ["SAVE_PROMPT_STATE", "SAVE_PROMPT_CONFIRM", "SAVE_PROMPT_DISMISS"].includes(message.type) && sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL("src/inline/save.html") && sender.frameId > 0;
  const fromPasskeyPanel = ["PASSKEY_STATE", "PASSKEY_CONFIRM", "PASSKEY_DISMISS"].includes(message.type) && sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL("src/inline/passkey.html") && sender.frameId > 0;
  // The palette's in-page iframe sends with frameId > 0; the one-time token — not the frame — is the
  // credential, so message validation happens inside the palette handlers.
  const fromPalette = ["PALETTE_QUERY", "PALETTE_RUN", "PALETTE_CLOSE"].includes(message.type)
    && sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL("src/command/palette.html") && sender.frameId > 0;
  if (!trusted(sender) && !fromContent && !fromPanel && !fromSavePanel && !fromPasskeyPanel && !fromPalette) return false;
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
      // Rule changes aren't vault writes, but open pages still re-read their site lists on publish.
      if ([...WRITES, "UNLOCK", "PREPARE_IMPORT", "BIOMETRIC_UNLOCK", "BIOMETRIC_ENABLE", "BIOMETRIC_DISABLE", "SET_SITE_RULE", "SET_SITE_ENABLED"].includes(message.type)) await publish();
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
    chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: FRAME_SCRIPTS }).catch(() => {});
    chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: "MAIN", files: ["src/content/passkey-page.js"] }).catch(() => {});
    chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ["src/content/save.js", "src/content/passkey.js", "src/command/palette.js"] }).catch(() => {});
  }
  if (details.reason === "install") void chrome.tabs.create({ url: chrome.runtime.getURL("src/vault-ui/vault.html#welcome") });
});
chrome.tabs.onRemoved.addListener(tabId => { savePrompts.forgetTab(tabId); passkeyPrompts.forgetTab(tabId); steps.forget(tabId); });
// The right-click menu (1.4): fill/generate/inspect on editable fields, and
// "save as note" on selections. Registrered items survive worker restarts; removeAll+create is
// idempotent, so rebuilding them on every wake keeps the menu consistent.
chrome.contextMenus?.removeAll(() => {
  chrome.contextMenus.create({ id: "keybit", title: "KeyBit", contexts: ["editable", "selection"] });
  chrome.contextMenus.create({ id: "keybit-fill", parentId: "keybit", title: "Fill with KeyBit", contexts: ["editable"] });
  chrome.contextMenus.create({ id: "keybit-generate", parentId: "keybit", title: "Generate password", contexts: ["editable"] });
  chrome.contextMenus.create({ id: "keybit-inspect", parentId: "keybit", title: "Inspect login form", contexts: ["editable", "page"] });
  chrome.contextMenus.create({ id: "keybit-note", parentId: "keybit", title: "Save as secure note", contexts: ["selection"] });
});
chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  // Fill/generate must reach the exact frame that was right-clicked.
  const frame = { frameId: Number.isInteger(info.frameId) ? info.frameId : 0 };
  /** @param {chrome.tabs.MessageSendOptions} [options] */
  const send = (message, options) => chrome.tabs.sendMessage(tab.id, message, options ?? frame).catch(() => {});
  switch (info.menuItemId) {
    case "keybit-fill": send({ event: "keybit-context-fill" }); break;
    case "keybit-generate": send({ event: "keybit-context-generate" }); break;
    case "keybit-inspect": {
      const pageUrl = info.pageUrl ?? tab.url ?? "";
      void chrome.tabs.create({ url: chrome.runtime.getURL(`src/developer/inspector.html?url=${encodeURIComponent(pageUrl)}`), index: (tab.index ?? 0) + 1 });
      break;
    }
    case "keybit-note":
      if (info.selectionText) void chrome.storage.session.set({ "pending-note": info.selectionText.slice(0, 20000) })
        .then(() => chrome.tabs.create({ url: chrome.runtime.getURL("src/vault-ui/vault.html#new-note") })).catch(() => {});
      break;
  }
});
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === "command-palette") {
    // The keyboard shortcut asks the page's KeyBit script to open the palette overlay.
    const target = tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!Number.isInteger(target?.id)) return;
    if (await chrome.tabs.sendMessage(target.id, { event: "keybit-palette" }, { frameId: 0 }).then(() => true).catch(() => false)) return;
    try {
      // A page loaded before the extension — inject the host script, then signal it.
      await chrome.scripting.executeScript({ target: { tabId: target.id, frameIds: [0] }, files: ["src/command/palette.js"] });
      await chrome.tabs.sendMessage(target.id, { event: "keybit-palette" }, { frameId: 0 });
    } catch {
      // Pages KeyBit can't run on (chrome://, store, PDFs) get the vault page instead.
      await chrome.tabs.create({ url: chrome.runtime.getURL("src/vault-ui/vault.html") }).catch(() => {});
    }
    return;
  }
  // The keyboard shortcut asks the page's KeyBit script to open the dropdown on the focused login field.
  if (command !== "show-suggestions") return;
  const target = tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (Number.isInteger(target?.id)) chrome.tabs.sendMessage(target.id, { event: "keybit-show" }, { frameId: 0 }).catch(() => {});
});
// No session key or plaintext is restored when this worker starts. A restart or reload locks the vault.
