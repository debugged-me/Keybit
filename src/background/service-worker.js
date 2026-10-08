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
// Classic script, imported for its side effect: registers Peek's pure helpers on
// globalThis.__keybitPeek.utils. Peek is a separate domain — it shares no vault objects.
import "../peek/peek-utils.js";

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
// ---- Peek ----
// Peek is a separate domain: it shares no vault objects, never sees credentials, and its messages
// never enter the vault queue. Its settings are plain preferences in chrome.storage.local.
const peekUtils = () => globalThis.__keybitPeek.utils;
// Install/update re-injection mirrors the manifest: shared helpers + the frame agent in every
// frame first, then the host scripts in the top frame.
const PEEK_FRAME_SCRIPTS = ["src/peek/peek-utils.js", "src/peek/peek-frame-events.js"];
const PEEK_SCRIPTS = ["src/peek/peek-settings.js", "src/peek/peek-overlay.js", "src/peek/peek-link-handler.js", "src/peek/peek-controller.js"];
const PEEK_PAGE = chrome.runtime.getURL("src/peek/peek.html");
const PEEK_SESSION_MS = 60000;
const PEEK_RULE_IDS = [4401, 4402];
// Who may send each Peek message: "top"/"sub" is a content script in the top frame/a sub-frame of
// an http(s) page, "page" the Peek page framed in a tab, "trusted" KeyBit's own pages. Anything
// else gets no answer — including PEEK_AGENT and PEEK_HOST_CMD, which are page↔page traffic.
const PEEK_SENDERS = {
  PEEK_GET_SETTINGS: ["trusted", "top", "sub", "page"],
  PEEK_SAVE_SETTINGS: ["trusted"],
  PEEK_OPEN: ["top"],
  PEEK_SESSION: ["page"],
  PEEK_FRAME_OPEN: ["sub"],
  PEEK_OPEN_TAB: ["top", "page"],
  PEEK_UNBLOCK: ["page"],
  PEEK_END: ["top", "page"]
};
const peekSessions = new Map(); // token → one open request, claimed once by the Peek page it framed
let peekRuleQueue = Promise.resolve();
// Chromium 128+ can match a rule on response headers; before that, previews drop CSP outright.
let peekCspCondition = true;

function peekSender(sender) {
  if (trusted(sender)) return "trusted";
  if (!Number.isInteger(sender.tab?.id) || !Number.isInteger(sender.frameId)) return null;
  // peek.html is web-accessible, so any site may frame it: it counts only inside a tab, never as
  // a top-level page, and still needs a one-time session token for anything that matters.
  if (sender.url?.split(/[?#]/)[0] === PEEK_PAGE) return sender.frameId > 0 ? "page" : null;
  if (!/^https?:\/\//i.test(sender.url ?? "")) return null;
  return sender.frameId === 0 ? "top" : "sub";
}
async function peekGetSettings() {
  const { peek } = await chrome.storage.local.get("peek");
  return peekUtils().sanitizeSettings(peek);
}
// Per-site rule: the top-level page decides, so every frame of a tab (and the Peek page in it)
// agrees. Site rules load with the worker; wait for them rather than answering with defaults.
async function peekSiteAllowed(sender) {
  await ready.catch(() => {});
  for (const page of [sender.tab?.url, sender.url]) {
    let origin;
    try { origin = new URL(page).origin; } catch { continue; }
    if (/^https?:/.test(origin)) return suggestions.offered(origin, "peek");
  }
  return true;
}
async function peekSaveSettings(raw) {
  const settings = peekUtils().sanitizeSettings(raw);
  await chrome.storage.local.set({ peek: settings });
  // Turning Peek, or showing sites that block previews, off ends every header relaxation now.
  if (!settings.peekEnabled || !settings.peekUnblock) await peekRulesUpdate(tabs => { tabs.clear(); }).catch(() => {});
  // Content scripts keep a settings cache so clicks are decided synchronously; push the change.
  for (const tab of await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }).catch(() => []))
    chrome.tabs.sendMessage(tab.id, { event: "keybit-peek-settings", settings }).catch(() => {});
  return settings;
}
// Lets sites that send X-Frame-Options or CSP frame-ancestors load in a preview — only for
// sub-frames KeyBit's own Peek page navigates, and only in tabs with an open Peek. The host page's
// own frames keep their protection: their initiator is the page, not the extension.
/** @returns {chrome.declarativeNetRequest.Rule[]} */
function peekRules(tabIds) {
  /** @type {chrome.declarativeNetRequest.RuleCondition} */
  const condition = { tabIds, resourceTypes: ["sub_frame"], initiatorDomains: [chrome.runtime.id] };
  if (!peekCspCondition) {
    return [{ id: 4401, priority: 1, condition, action: { type: "modifyHeaders",
      responseHeaders: [{ header: "x-frame-options", operation: "remove" }, { header: "content-security-policy", operation: "remove" }] } }];
  }
  return [
    { id: 4401, priority: 1, condition, action: { type: "modifyHeaders", responseHeaders: [{ header: "x-frame-options", operation: "remove" }] } },
    // Only a policy that restricts framing is dropped; any other CSP stays in force.
    { id: 4402, priority: 1, condition: { ...condition, responseHeaders: [{ header: "content-security-policy", values: ["*frame-ancestors*"] }] },
      action: { type: "modifyHeaders", responseHeaders: [{ header: "content-security-policy", operation: "remove" }] } }
  ];
}
// The tab list lives in the session rules themselves, so it survives worker restarts. Updates run
// one at a time: concurrent opens and closes would otherwise overwrite each other's read.
/** @param {(tabs: Set<number>) => (void | Promise<void>)} change */
function peekRulesUpdate(change) {
  const run = peekRuleQueue.then(async () => {
    const rules = await chrome.declarativeNetRequest.getSessionRules({ ruleIds: PEEK_RULE_IDS });
    const current = new Set(rules.flatMap(rule => rule.condition.tabIds ?? []));
    const next = new Set(current);
    await change(next);
    const ids = [...next].sort((a, b) => a - b);
    const want = ids.length ? peekRules(ids) : [];
    if (ids.length === current.size && ids.every(id => current.has(id)) && rules.length === want.length) return;
    try {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: PEEK_RULE_IDS, addRules: want });
    } catch (error) {
      if (!want.length || !peekCspCondition) throw error;
      // The browser rejected the response-header condition: fall back to one unconditional rule.
      peekCspCondition = false;
      try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: PEEK_RULE_IDS, addRules: peekRules(ids) }); }
      catch (retry) { peekCspCondition = true; throw retry; }
    }
    // Session rules reach the network stack a moment after updateSessionRules resolves: a preview
    // navigation fired immediately (open, or "Show it anyway") can still see the site's headers.
    await new Promise(resolve => setTimeout(resolve, 500));
  });
  peekRuleQueue = run.catch(() => {});
  return run;
}
function peekPrune() {
  const now = Date.now();
  for (const [token, session] of peekSessions) if (!session.claimed && now - session.created > PEEK_SESSION_MS) peekSessions.delete(token);
}
const peekDocument = sender => sender.documentId ?? `frame:${sender.frameId}`;
// The link's on-screen rect for the grow-from-link animation: plain finite numbers only.
function peekSource(raw) {
  if (!raw || typeof raw !== "object") return null;
  const entries = Object.entries(raw).filter(([key, value]) => /^[A-Za-z]{1,16}$/.test(key) && Number.isFinite(value)).slice(0, 8);
  return entries.length ? Object.fromEntries(entries) : null;
}
async function peekOpen(message, sender) {
  const utils = peekUtils();
  const token = typeof message.token === "string" && /^[0-9a-f]{32}$/.test(message.token) ? message.token : null;
  const raw = utils.peekUrl(message.url);
  if (!token) throw new Error("Peek couldn't start. Click the link again.");
  if (!raw) throw new Error("That link can't be previewed.");
  const settings = await peekGetSettings();
  if (!settings.peekEnabled) throw new Error("Peek is turned off.");
  if (!(await peekSiteAllowed(sender))) throw new Error("Peek is off for this site.");
  peekPrune();
  if (peekSessions.has(token)) throw new Error("Peek couldn't start. Click the link again.");
  const url = utils.destinationUrl(raw);
  const tab = sender.tab;
  const session = { token, tabId: tab.id, windowId: tab.windowId, index: tab.index, url: url.href, frameUrl: utils.frameUrl(url).href,
    source: peekSource(message.source), created: Date.now(), claimed: false, claimedBy: null, unblock: false };
  // Registered before the rules update, so a PEEK_END from a Peek that is still closing keeps them.
  peekSessions.set(token, session);
  // The relaxation is in place before the Peek page can start loading the preview.
  if (settings.peekUnblock) session.unblock = await peekRulesUpdate(tabs => { tabs.add(tab.id); }).then(() => true, () => false);
  return { token };
}
async function peekClaim(message, sender) {
  peekPrune();
  const session = typeof message.token === "string" ? peekSessions.get(message.token) : undefined;
  // One claim per token, by a Peek page inside the tab that asked for it.
  if (!session || session.claimed || session.tabId !== sender.tab.id) throw new Error("This preview expired. Click the link again.");
  session.claimed = true;
  session.claimedBy = peekDocument(sender);
  const { url, frameUrl, source, unblock, tabId } = session;
  return { url, frameUrl, source, settings: await peekGetSettings(), unblock, tabId };
}
// A link clicked inside an embedded frame previews in the top page, which owns Peek.
async function peekFrameOpen(message, sender) {
  const raw = peekUtils().peekUrl(message.url);
  if (!raw) throw new Error("That link can't be previewed.");
  if (!/^https?:\/\//i.test(sender.tab.url ?? "")) throw new Error("Peek works on http and https pages.");
  const settings = await peekGetSettings();
  if (!settings.peekEnabled) throw new Error("Peek is turned off.");
  if (!(await peekSiteAllowed(sender))) throw new Error("Peek is off for this site.");
  const url = peekUtils().destinationUrl(raw).href;
  chrome.tabs.sendMessage(sender.tab.id, { event: "keybit-peek-open", url }, { frameId: 0 }).catch(() => {});
  return { forwarded: true };
}
// URLs from content scripts and the Peek page are validated again before any tab is opened.
async function peekOpenTab(message, sender) {
  const url = peekUtils().peekUrl(message.url);
  if (!url) throw new Error("That link can't be opened.");
  const tab = sender.tab;
  let created;
  try {
    // Right after the tab it came from, like a link opened in a new tab.
    created = await chrome.tabs.create({ url: url.href, active: true, windowId: tab.windowId, index: tab.index + 1, openerTabId: tab.id });
  } catch (error) {
    // Popup and app windows can't take more tabs; a private window's link never moves to a normal one.
    if (tab.incognito) throw error;
    created = await chrome.tabs.create({ url: url.href, active: true });
  }
  return { opened: true, tabId: created?.id };
}
// "Show it anyway" on a blocked preview.
async function peekUnblock(sender) {
  const settings = await peekGetSettings();
  if (!settings.peekEnabled) throw new Error("Peek is turned off.");
  if (!(await peekSiteAllowed(sender))) throw new Error("Peek is off for this site.");
  await peekRulesUpdate(tabs => { tabs.add(sender.tab.id); });
  return { unblock: true };
}
async function peekEnd(message, sender, kind) {
  const tabId = sender.tab.id;
  const self = peekDocument(sender);
  peekPrune();
  // A delayed host teardown names its token, so it cannot end a newly opened preview. A Peek
  // page owns every session it claimed (including earlier URLs switched in that same frame).
  for (const [token, session] of peekSessions) if (session.tabId === tabId &&
    (kind === "top" ? (!message.token || token === message.token) : session.claimedBy === self)) peekSessions.delete(token);
  // A newer preview in this tab (opened while this one was closing) keeps the relaxation.
  if (![...peekSessions.values()].some(session => session.tabId === tabId)) await peekRulesUpdate(tabs => { tabs.delete(tabId); });
  return { ended: true };
}
function peekForgetTab(tabId) {
  for (const [token, session] of peekSessions) if (session.tabId === tabId) peekSessions.delete(token);
  void peekRulesUpdate(tabs => { tabs.delete(tabId); }).catch(() => {});
}
async function peekHandle(message, sender, kind) {
  switch (message.type) {
    case "PEEK_GET_SETTINGS": return { ...(await peekGetSettings()), siteAllowed: await peekSiteAllowed(sender) };
    case "PEEK_SAVE_SETTINGS": return peekSaveSettings(message.settings);
    case "PEEK_OPEN": return peekOpen(message, sender);
    case "PEEK_SESSION": return peekClaim(message, sender);
    case "PEEK_FRAME_OPEN": return peekFrameOpen(message, sender);
    case "PEEK_OPEN_TAB": return peekOpenTab(message, sender);
    case "PEEK_UNBLOCK": return peekUnblock(sender);
    case "PEEK_END": return peekEnd(message, sender, kind);
    default: throw new Error("Unsupported Peek action.");
  }
}
// A closed (or replaced) tab takes its previews and its header relaxation with it.
chrome.tabs.onRemoved.addListener(tabId => peekForgetTab(tabId));
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => peekForgetTab(removedTabId));
// Session rules outlive this worker (not the browser): drop tabs that closed while it slept.
void peekRulesUpdate(async tabs => {
  if (!tabs.size) return;
  const open = new Set((await chrome.tabs.query({})).map(tab => tab.id));
  for (const id of tabs) if (!open.has(id)) tabs.delete(id);
}).catch(() => {});

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
    case "peek":
      // The content script hands off to the Peek controller, which enforces its own eligibility.
      chrome.tabs.sendMessage(context.tabId, { event: "keybit-peek-preview" }, { frameId: 0 }).catch(() => {});
      return { close: true };
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
  if (message.type.startsWith("PEEK_")) {
    // Peek answers on its own path: never queued behind vault work, never touching vault state.
    const kind = peekSender(sender);
    if (!PEEK_SENDERS[message.type]?.includes(kind)) return false;
    void Promise.resolve()
      .then(() => peekHandle(message, sender, kind))
      .then(data => reply({ ok: true, data }))
      .catch(error => reply({ ok: false, error: error?.name === "Error" ? error.message : "The operation could not be completed. Please try again." }));
    return true;
  }
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
    chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, world: "MAIN", files: ["src/peek/peek-frame-main.js"] }).catch(() => {});
    // Peek's shared helpers must be in the top frame before its host scripts run there.
    chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: PEEK_FRAME_SCRIPTS }).catch(() => {})
      .then(() => chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ["src/content/save.js", "src/content/passkey.js", ...PEEK_SCRIPTS, "src/command/palette.js"] }))
      .catch(() => {});
  }
  if (details.reason === "install") void chrome.tabs.create({ url: chrome.runtime.getURL("src/vault-ui/vault.html#welcome") });
});
chrome.tabs.onRemoved.addListener(tabId => { savePrompts.forgetTab(tabId); passkeyPrompts.forgetTab(tabId); steps.forget(tabId); });
// The right-click menu (1.4): Peek on links, fill/generate/inspect on editable fields, and
// "save as note" on selections. Registrered items survive worker restarts; removeAll+create is
// idempotent, so rebuilding them on every wake keeps the menu consistent.
chrome.contextMenus?.removeAll(() => {
  chrome.contextMenus.create({ id: "keybit", title: "KeyBit", contexts: ["link", "editable", "selection"] });
  chrome.contextMenus.create({ id: "keybit-peek", parentId: "keybit", title: "Preview with KeyBit", contexts: ["link"] });
  chrome.contextMenus.create({ id: "keybit-fill", parentId: "keybit", title: "Fill with KeyBit", contexts: ["editable"] });
  chrome.contextMenus.create({ id: "keybit-generate", parentId: "keybit", title: "Generate password", contexts: ["editable"] });
  chrome.contextMenus.create({ id: "keybit-inspect", parentId: "keybit", title: "Inspect login form", contexts: ["editable", "page"] });
  chrome.contextMenus.create({ id: "keybit-note", parentId: "keybit", title: "Save as secure note", contexts: ["selection"] });
});
chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  // Fill/generate must reach the exact frame that was right-clicked; Peek only runs top-frame.
  const frame = { frameId: Number.isInteger(info.frameId) ? info.frameId : 0 };
  /** @param {chrome.tabs.MessageSendOptions} [options] */
  const send = (message, options) => chrome.tabs.sendMessage(tab.id, message, options ?? frame).catch(() => {});
  switch (info.menuItemId) {
    case "keybit-peek": if (info.linkUrl) send({ event: "keybit-context-peek", url: info.linkUrl }, {}); break;
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
