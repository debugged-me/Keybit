import { parseWebsite } from "../matching/url-matcher.js";

// Submitted credentials are short-lived worker memory, never browser storage.
export class SavePrompts {
  pending = new Map();
  timer = null;
  constructor(vault, suggestions, now = Date.now) { this.vault = vault; this.suggestions = suggestions; this.now = now; }
  clear() { this.pending.clear(); clearTimeout(this.timer); this.timer = null; }
  forgetTab(tabId) { for (const [token, entry] of this.pending) if (entry.tabId === tabId) this.pending.delete(token); this.schedule(); }
  schedule() {
    clearTimeout(this.timer);
    if (!this.pending.size) { this.timer = null; return; }
    const expires = Math.min(...[...this.pending.values()].map(entry => entry.expires));
    this.timer = setTimeout(() => {
      for (const [token, entry] of this.pending) if (entry.expires <= this.now()) this.pending.delete(token);
      this.schedule();
    }, Math.max(0, expires - this.now()));
    this.timer.unref?.();
  }
  async allowed(sender) {
    if (sender.frameId !== 0 || !sender.documentId || !Number.isInteger(sender.tab?.id)) throw new Error("Unsupported frame.");
    const origin = parseWebsite(sender.url).origin;
    if (!(await this.suggestions.allows(origin))) return null;
    const tab = await chrome.tabs.get(sender.tab.id);
    return parseWebsite(tab.url).origin === origin ? origin : null;
  }
  async capture(message, sender) {
    const origin = await this.allowed(sender);
    if (!origin) return { available: false };
    this.forgetTab(sender.tab.id);
    if (typeof message.username !== "string" || message.username.length > 1024 ||
        typeof message.password !== "string" || message.password.length > 4096 || !message.password.trim()) return { available: false };
    const state = await this.vault.status();
    if (!state.unlocked) return { available: false };
    const matches = this.vault.list(state.session, "", origin).filter(item => item.username === message.username);
    if (matches.some(item => this.vault.item(state.session, item.id).password === message.password)) return { available: false };
    // Never guess which duplicate account to overwrite.
    if (matches.length > 1) return { available: false };
    if (this.pending.size >= 20) this.clear();
    const token = crypto.randomUUID();
    this.pending.set(token, { tabId: sender.tab.id, origin, session: state.session, revision: state.revision,
      id: matches[0]?.id, username: message.username, password: message.password, expires: this.now() + 120000 });
    this.schedule();
    return { available: true };
  }
  async open(sender) {
    const origin = await this.allowed(sender);
    if (!origin) return { available: false };
    const state = await this.vault.status();
    for (const [token, entry] of this.pending) {
      if (entry.expires <= this.now() || entry.session !== state.session) { this.pending.delete(token); continue; }
      if (entry.tabId !== sender.tab.id || entry.origin !== origin) continue;
      // Rebind after a same-origin login redirect. Old frames become unusable.
      if (entry.documentId !== sender.documentId) { entry.documentId = sender.documentId; entry.panelId = null; }
      return { enabled: true, available: true, token };
    }
    return { enabled: true, available: false };
  }
  async panel(message, sender) {
    const entry = this.pending.get(message.token);
    const expired = () => new Error("This save prompt expired. Sign in again with KeyBit unlocked.");
    if (!entry || entry.expires <= this.now()) { this.pending.delete(message.token); throw expired(); }
    if (sender.tab?.id !== entry.tabId || sender.frameId <= 0 || !sender.documentId || !entry.documentId ||
        !(await this.suggestions.allows(entry.origin))) throw expired();
    if (entry.panelId && entry.panelId !== sender.documentId) throw expired();
    entry.panelId = sender.documentId;
    this.vault.require(entry.session);
    let result;
    try { result = await chrome.scripting.executeScript({ target: { tabId: entry.tabId, documentIds: [entry.documentId] }, func: () => location.origin }); }
    catch { throw expired(); }
    this.vault.require(entry.session);
    if (result[0]?.result !== entry.origin) throw expired();
    if (message.type === "SAVE_PROMPT_STATE") return { origin: entry.origin, username: entry.username, update: !!entry.id };
    if (message.type === "SAVE_PROMPT_DISMISS") { this.pending.delete(message.token); this.schedule(); return null; }
    if (message.type !== "SAVE_PROMPT_CONFIRM") throw new Error("Unsupported save action.");
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active?.id !== entry.tabId) throw new Error("Return to the login tab to save this password.");
    const previous = entry.id ? this.vault.item(entry.session, entry.id) : null;
    const input = previous ? { ...previous, password: entry.password } : {
      name: new URL(entry.origin).host, urls: [entry.origin], username: entry.username,
      password: entry.password, notes: "", environment: "other"
    };
    // A revision check prevents a delayed prompt from overwriting newer edits.
    await this.vault.saveItem(entry.session, entry.revision, input);
    this.pending.delete(message.token); this.schedule();
    return { saved: true };
  }
}
