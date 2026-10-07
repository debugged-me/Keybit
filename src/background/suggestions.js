import { parseWebsite } from "../matching/url-matcher.js";

export const SITE_SCRIPTS = ["src/content/form-detector.js", "src/content/autofill.js", "src/content/inline.js", "src/content/save.js"];
export const sitePattern = origin => {
  const url = parseWebsite(origin);
  return `${url.protocol}//${url.hostname}/*`;
};
const MAX_DISABLED = 1000;
// KeyBit runs on every HTTP/HTTPS site unless the user turns it off for that exact origin.
export class Suggestions {
  disabled = [];
  panels = new Map();
  constructor(vault, fill) { this.vault = vault; this.fill = fill; }
  async refresh() {
    const saved = await chrome.storage.local.get(["disabledOrigins", "suggestionOrigins"]);
    this.disabled = [];
    for (const value of Array.isArray(saved.disabledOrigins) ? saved.disabledOrigins.slice(0, MAX_DISABLED) : []) {
      try { this.disabled.push(parseWebsite(value).origin); } catch { /* Ignore obsolete/invalid non-secret site preferences. */ }
    }
    this.disabled = [...new Set(this.disabled)];
    // Version 1.0 opted in per site with dynamic scripts; the manifest now covers every site.
    // Cleanup is best effort so a failure here cannot block unlocking.
    try {
      const legacy = (await chrome.scripting.getRegisteredContentScripts()).filter(script => script.id.startsWith("keybit-")).map(script => script.id);
      if (legacy.length) await chrome.scripting.unregisterContentScripts({ ids: legacy });
      if ("suggestionOrigins" in saved) await chrome.storage.local.remove("suggestionOrigins");
    } catch { /* Retried on the next worker start. */ }
  }
  async allows(origin) {
    return !this.disabled.includes(origin) && chrome.permissions.contains({ origins: [sitePattern(origin)] });
  }
  async site(origin) {
    origin = parseWebsite(origin).origin;
    return { origin, enabled: !this.disabled.includes(origin), access: await chrome.permissions.contains({ origins: [sitePattern(origin)] }) };
  }
  async setEnabled(origin, enabled) {
    origin = parseWebsite(origin).origin;
    if (enabled && !(await chrome.permissions.contains({ origins: [sitePattern(origin)] }))) throw new Error("Allow site access in the browser prompt first.");
    if (!enabled && !this.disabled.includes(origin) && this.disabled.length >= MAX_DISABLED) throw new Error("Turn KeyBit back on for an unused site first.");
    this.disabled = enabled ? this.disabled.filter(value => value !== origin) : [...this.disabled.filter(value => value !== origin), origin];
    await chrome.storage.local.set({ disabledOrigins: this.disabled });
    const tabs = await chrome.tabs.query({ url: [sitePattern(origin)] }).catch(() => []);
    for (const tab of tabs) {
      try {
        if (parseWebsite(tab.url).origin !== origin) continue;
        if (enabled) await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: SITE_SCRIPTS });
        else await chrome.tabs.sendMessage(tab.id, { event: "keybit-site-disabled" }, { frameId: 0 });
      } catch { /* Navigation may race injection; the manifest covers the next page load. */ }
    }
    if (!enabled) for (const [token, context] of this.panels) if (context.origin === origin) this.panels.delete(token);
    return this.disabled;
  }
  async open(sender) {
    if (sender.frameId !== 0 || !sender.documentId || !Number.isInteger(sender.tab?.id)) throw new Error("Unsupported frame.");
    const origin = parseWebsite(sender.url).origin;
    if (!(await this.allows(origin))) return { enabled: false };
    const tab = await chrome.tabs.get(sender.tab.id);
    if (parseWebsite(tab.url).origin !== origin) return { enabled: false };
    for (const [key, value] of this.panels) if (value.expires < Date.now() || value.tabId === tab.id) this.panels.delete(key);
    if (this.panels.size > 100) this.panels.clear();
    const token = crypto.randomUUID();
    this.panels.set(token, { origin, tabId: tab.id, documentId: sender.documentId, expires: Date.now() + 120000 });
    return { enabled: true, token };
  }
  async panel(message, sender) {
    const context = this.panels.get(message.token);
    if (!context || sender.tab?.id !== context.tabId || sender.frameId === 0 || context.expires < Date.now() || this.disabled.includes(context.origin)) throw new Error("Suggestions expired. Click the login field again.");
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
        return { state, origin: context.origin, items: state.unlocked ? this.vault.list(state.session, "", context.origin) : [] };
      }
      case "PANEL_FILL": {
        this.vault.touch(message.session);
        return this.fill({ session: message.session, id: message.id, origin: context.origin, tabId: context.tabId, expectedDocumentId: context.documentId });
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
