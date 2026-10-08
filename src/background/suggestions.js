import { parseWebsite, scopeLabel, specificity } from "../matching/url-matcher.js";
import { lookalikeOf } from "../matching/lookalike.js";
import { totpCode } from "../vault/totp.js";
import { MODE_FLAG, normalizeRules, ruleFor, sanitizeRule, isCustomized } from "../rules/site-rules.js";

// Detection/autofill/dropdown run in every frame; save prompts stay top-frame only on purpose —
// a cross-origin iframe must not be able to inject captured credentials.
export const FRAME_SCRIPTS = ["src/content/form-detector.js", "src/content/autofill.js", "src/content/inline.js"];
export const SITE_SCRIPTS = [...FRAME_SCRIPTS, "src/content/save.js"];
export const sitePattern = origin => {
  const url = parseWebsite(origin);
  return `${url.protocol}//${url.hostname}/*`;
};
const MAX_DISABLED = 1000;
const MODES = ["login", "username", "new", "otp", "card", "identity"];
// KeyBit runs on every HTTP/HTTPS site unless the user turns it off for that exact origin.
export class Suggestions {
  disabled = [];
  rules = {};
  panels = new Map();
  constructor(vault, fill, { usage = null, steps = null } = {}) { this.vault = vault; this.fill = fill; this.usage = usage; this.steps = steps; }
  // Matching logins for a page: the account chosen on a previous sign-in step first, then project-folder logins,
  // then the most recently used.
  ranked(session, url, tabId, origin) {
    const items = this.usage ? this.usage.annotate(this.vault.list(session, "", url)) : this.vault.list(session, "", url);
    const step = this.steps?.recall(tabId, origin);
    const next = items.filter(item => item.type === "login").map(item => ({ ...item, continue: !!step && (item.id === step.id || (!step.id && item.username === step.username)) }));
    return next.sort((a, b) => (b.continue - a.continue) || (specificity(b) - specificity(a)) || ((b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)));
  }
  async refresh() {
    const saved = await chrome.storage.local.get(["siteRules", "disabledOrigins", "suggestionOrigins"]);
    this.rules = normalizeRules(saved.siteRules);
    // Migration: the 1.3 "disabledOrigins" list becomes enabled:false rules; nothing else changes.
    if (Array.isArray(saved.disabledOrigins)) {
      for (const value of saved.disabledOrigins.slice(0, MAX_DISABLED)) {
        try {
          const origin = parseWebsite(value).origin;
          if (!this.rules[origin]) this.rules[origin] = sanitizeRule({ enabled: false });
        } catch { /* Ignore obsolete/invalid non-secret site preferences. */ }
      }
      await chrome.storage.local.set({ siteRules: this.rules }).then(() => chrome.storage.local.remove("disabledOrigins")).catch(() => { /* Retried next start. */ });
    }
    this.disabled = Object.keys(this.rules).filter(origin => this.rules[origin].enabled === false);
    // Version 1.0 opted in per site with dynamic scripts; the manifest now covers every site.
    // Cleanup is best effort so a failure here cannot block unlocking.
    try {
      const legacy = (await chrome.scripting.getRegisteredContentScripts()).filter(script => script.id.startsWith("keybit-")).map(script => script.id);
      if (legacy.length) await chrome.scripting.unregisterContentScripts({ ids: legacy });
      if ("suggestionOrigins" in saved) await chrome.storage.local.remove("suggestionOrigins");
    } catch { /* Retried on the next worker start. */ }
  }
  async allows(origin) {
    return this.ruleFor(origin).enabled && chrome.permissions.contains({ origins: [sitePattern(origin)] });
  }
  // One rule flag (logins, save, totp, cards, generate, peek) on top of the master switch.
  // `peek` stands alone: Peek predates site rules and stays a separate feature switch.
  offered(origin, flag) {
    const rule = this.ruleFor(origin);
    return flag === "peek" ? rule.peek : rule.enabled && rule[flag] !== false;
  }
  ruleFor(origin) { return ruleFor(this.rules, origin); }
  siteRules() { return structuredClone(this.rules); }
  async setEnabled(origin, enabled) { await this.setRule(origin, { enabled }); return this.disabled; }
  // Updates one rule for an exact origin — the persisted key never carries ports/paths from callers,
  // and a rule back at defaults is dropped entirely.
  async setRule(origin, patch) {
    const site = parseWebsite(origin);
    origin = site.origin;
    const next = sanitizeRule({ ...this.ruleFor(origin), ...(patch ?? {}) });
    if (next.enabled && !(await chrome.permissions.contains({ origins: [sitePattern(origin)] }))) throw new Error("Allow site access in the browser prompt first.");
    if (isCustomized(next) && !this.rules[origin] && Object.keys(this.rules).length >= MAX_DISABLED) throw new Error("Reset rules for an unused site first.");
    if (isCustomized(next)) this.rules[origin] = next; else delete this.rules[origin];
    this.disabled = Object.keys(this.rules).filter(value => this.rules[value].enabled === false);
    await chrome.storage.local.set({ siteRules: this.rules });
    // Live update for open tabs: pages under this rule's scope (exact, plus opted-in subdomains)
    // get the off/on push and Peek re-reads its per-site allowance.
    const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }).catch(() => []);
    for (const tab of tabs) {
      try {
        const tabSite = parseWebsite(tab.url);
        const covered = tabSite.origin === origin || (next.subdomains && tabSite.protocol === site.protocol && tabSite.port === site.port &&
          (tabSite.hostname === site.hostname || tabSite.hostname.endsWith(`.${site.hostname}`)));
        if (!covered) continue;
        if (!next.enabled) await chrome.tabs.sendMessage(tab.id, { event: "keybit-site-disabled", origin: tabSite.origin });
        else if (patch?.enabled === true) {
          await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: FRAME_SCRIPTS });
          await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ["src/content/save.js"] });
        }
        await chrome.tabs.sendMessage(tab.id, { event: "keybit-peek-site" });
      } catch { /* Navigation may race injection; the manifest covers the next page load. */ }
    }
    // Close open panels whose offer is no longer allowed on this origin.
    for (const [token, context] of this.panels) {
      const rule = this.ruleFor(context.origin);
      if (!rule.enabled || (context.origin === origin && rule[MODE_FLAG[context.mode]] === false) ||
          (context.origin !== origin && !this.offered(context.origin, MODE_FLAG[context.mode]))) this.panels.delete(token);
    }
    return this.ruleFor(origin);
  }
  async open(sender, mode) {
    // Any frame may open a panel — sender.url is that frame's own URL, so the panel is bound to the
    // iframe's real origin, never the parent's. Top-frame senders are double-checked against the tab.
    if (!Number.isInteger(sender.frameId) || !sender.documentId || !Number.isInteger(sender.tab?.id)) throw new Error("Unsupported frame.");
    const url = parseWebsite(sender.url).href;
    const origin = parseWebsite(url).origin;
    if (!(await this.allows(origin))) return { enabled: false };
    const tab = await chrome.tabs.get(sender.tab.id);
    if (sender.frameId === 0 && parseWebsite(tab.url).origin !== origin) return { enabled: false };
    mode = MODES.includes(mode) ? mode : "login";
    // Per-site rules: the offer's flag (logins, save→n/a here, generated passwords, 2FA, cards) decides.
    if (!this.offered(origin, MODE_FLAG[mode])) return { enabled: false };
    // Username-only steps and 2FA fields also appear on pages that are not sign-ins; offer KeyBit there only
    // when it has something to fill. Card and identity dropdowns likewise only open with matching items.
    if (mode === "username" || mode === "otp") {
      const state = await this.vault.status();
      if (!state.unlocked || !this.ranked(state.session, url, tab.id, origin).some(item => mode !== "otp" || item.hasTotp)) return { enabled: false };
    }
    if (mode === "card" || mode === "identity") {
      const state = await this.vault.status();
      if (!state.unlocked || !this.vault.list(state.session).some(item => item.type === mode)) return { enabled: false };
    }
    for (const [key, value] of this.panels) if (value.expires < Date.now() || (value.tabId === tab.id && value.frameId === sender.frameId)) this.panels.delete(key);
    if (this.panels.size > 100) this.panels.clear();
    const token = crypto.randomUUID();
    // "new" panels offer a generated password for sign-up and change-password fields.
    this.panels.set(token, { origin, url, mode, tabId: tab.id, frameId: sender.frameId, documentId: sender.documentId, expires: Date.now() + 120000 });
    return { enabled: true, token };
  }
  async panel(message, sender) {
    const context = this.panels.get(message.token);
    if (!context || sender.tab?.id !== context.tabId || sender.frameId === 0 || context.expires < Date.now() || !this.offered(context.origin, MODE_FLAG[context.mode])) throw new Error("Suggestions expired. Click the login field again.");
    if (context.panelId && context.panelId !== sender.documentId) throw new Error("Invalid suggestion panel.");
    context.panelId = sender.documentId;
    // A token is bound to the original top-level document, including across same-origin navigation.
    let result;
    try { result = await chrome.scripting.executeScript({ target: { tabId: context.tabId, documentIds: [context.documentId] }, func: () => location.origin }); }
    catch { throw new Error("The page changed. Click the login field again."); }
    if (result[0]?.result !== context.origin) throw new Error("The page changed. Click the login field again.");
    context.expires = Date.now() + 120000;
    switch (message.type) {
      case "PANEL_STATE": {
        const state = await this.vault.status();
        let items = state.unlocked && context.mode !== "new" ? this.ranked(state.session, context.url, context.tabId, context.origin) : [];
        // Card and identity fields aren't site-bound: any saved card or ID is offered, most recently used first.
        if (context.mode === "card" || context.mode === "identity") {
          items = state.unlocked ? (this.usage ? this.usage.annotate(this.vault.list(state.session)) : this.vault.list(state.session))
            .filter(item => item.type === context.mode).sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)) : [];
        }
        if (context.mode === "otp") {
          // Codes are short-lived; secrets never leave the worker.
          items = await Promise.all(items.filter(item => item.hasTotp).map(async item => ({ ...item, ...(await totpCode(this.vault.item(state.session, item.id).totp)) })));
        }
        // Phishing guard: the page's domain is compared to every saved domain — folded for
        // confusable glyphs and punycode — so a lookalike site gets a warning banner even
        // when it correctly matches no login.
        const lookalike = state.unlocked ? lookalikeOf(parseWebsite(context.origin).hostname, this.vault.hosts(state.session)) : null;
        const warning = lookalike ? `This isn't ${lookalike} — the address only looks similar. Check the URL before filling anything.` : null;
        return { state, origin: context.origin, site: scopeLabel(context.url), mode: context.mode, items, warning };
      }
      case "PANEL_FILL": {
        if (context.mode === "new") throw new Error("Unsupported suggestion action.");
        this.vault.touch(message.session);
        return this.fill({ session: message.session, id: message.id, url: context.url, tabId: context.tabId,
          expectedDocumentId: context.documentId, expectedFrameId: context.frameId, otp: context.mode === "otp" });
      }
      case "PANEL_FILL_NEW": {
        // The password was generated in the extension frame; the page receives it only on this explicit choice.
        if (context.mode !== "new" || typeof message.password !== "string" || message.password.length < 8 || message.password.length > 128) throw new Error("Unsupported suggestion action.");
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (active?.id !== context.tabId) throw new Error("Return to the sign-up tab first.");
        let results;
        try {
          const target = { tabId: context.tabId, documentIds: [context.documentId] };
          await chrome.scripting.executeScript({ target, files: ["src/content/form-detector.js", "src/content/autofill.js"] });
          results = await chrome.scripting.executeScript({ target, func: (origin, password) => globalThis.__keybit.fillNew(origin, password), args: [context.origin, message.password] });
        } catch { throw new Error("The page changed. Click the password field again."); }
        if (!results[0]?.result?.ok) throw new Error(results[0]?.result?.error ?? "Could not fill this form.");
        return { filled: true };
      }
      case "PANEL_OPEN": {
        const tab = await chrome.tabs.get(context.tabId);
        try { await chrome.action.openPopup({ windowId: tab.windowId }); }
        catch { await chrome.tabs.create({ url: chrome.runtime.getURL("src/vault-ui/vault.html") }); }
        return null;
      }
      default: throw new Error("Unsupported suggestion action.");
    }
  }
}
