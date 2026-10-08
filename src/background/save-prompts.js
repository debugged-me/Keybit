import { parseWebsite, loginScope, scopeLabel, scopeUrl, isLocalHost } from "../matching/url-matcher.js";

const KINDS = ["login", "signup", "change"];
// Submitted credentials are short-lived worker memory, never browser storage.
export class SavePrompts {
  pending = new Map();
  timer = null;
  #watching = false;
  constructor(vault, suggestions, now = Date.now, steps = null) { this.vault = vault; this.suggestions = suggestions; this.now = now; this.steps = steps; }
  clear() { this.pending.clear(); clearTimeout(this.timer); this.timer = null; this.#watch(); }
  // Pages never ask on load whether a prompt is waiting (that would wake KeyBit on every page). Instead, while a
  // prompt is pending, KeyBit watches for its tab to finish loading and tells that page to show the card.
  #onUpdated = (tabId, change) => {
    if (change.status === "complete" && [...this.pending.values()].some(entry => entry.tabId === tabId)) {
      chrome.tabs.sendMessage(tabId, { event: "keybit-save-prompt" }, { frameId: 0 }).catch(() => {});
    }
  };
  #watch() {
    const events = globalThis.chrome?.tabs?.onUpdated;
    if (!events) return;
    if (this.pending.size && !this.#watching) { events.addListener(this.#onUpdated); this.#watching = true; }
    else if (!this.pending.size && this.#watching) { events.removeListener(this.#onUpdated); this.#watching = false; }
  }
  forgetTab(tabId) { for (const [token, entry] of this.pending) if (entry.tabId === tabId) this.pending.delete(token); this.schedule(); }
  schedule() {
    clearTimeout(this.timer);
    this.#watch();
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
    const url = parseWebsite(sender.url);
    if (!(await this.suggestions.allows(url.origin))) return null;
    const tab = await chrome.tabs.get(sender.tab.id);
    return parseWebsite(tab.url).origin === url.origin ? url : null;
  }
  async capture(message, sender) {
    const page = await this.allowed(sender);
    if (!page) return { available: false };
    this.forgetTab(sender.tab.id);
    const kind = KINDS.includes(message.kind) ? message.kind : "login";
    // The password page of a two-step sign-in has no username field; use the one from the step before.
    if (kind === "login" && message.username === "") message = { ...message, username: this.steps?.recall(sender.tab.id, page.origin)?.username ?? "" };
    if (typeof message.username !== "string" || message.username.length > 1024 ||
        typeof message.password !== "string" || message.password.length > 4096 || !message.password.trim()) return { available: false };
    const state = await this.vault.status();
    if (!state.unlocked) return { available: false };
    const scope = loginScope(page);
    const sameScope = item => loginScope(item.urls[0]) === scope;
    const onPage = this.vault.list(state.session, "", page.href);
    // A change-password form often has no username field. It may only update a login of this exact site or project.
    const related = kind === "change"
      ? onPage.filter(item => sameScope(item) && (!message.username || item.username === message.username))
      : onPage.filter(item => item.username === message.username);
    if (related.some(item => this.vault.item(state.session, item.id).password === message.password)) return { available: false };
    if (kind === "change" && !related.length) return { available: false };
    // Only a login for this exact site or project folder is offered as the default update.
    // A whole-site login on a project-folder page (another app on the same server) defaults to "Save as new".
    const exact = related.filter(sameScope);
    const candidates = (exact.length ? exact : related).slice(0, 8);
    if (this.pending.size >= 20) this.clear();
    const token = crypto.randomUUID();
    this.pending.set(token, { tabId: sender.tab.id, origin: page.origin, url: scopeUrl(page), kind, session: state.session, revision: state.revision,
      candidates: candidates.map(item => item.id), preferNew: !exact.length && kind !== "change",
      username: message.username || (candidates.length === 1 ? candidates[0].username : ""), password: message.password, expires: this.now() + 120000 });
    this.schedule();
    return { available: true };
  }
  // First step of a two-step sign-in: remember the username for the password page.
  async captureUsername(message, sender) {
    const page = await this.allowed(sender);
    if (!page || typeof message.username !== "string" || !message.username.trim() || message.username.length > 1024) return { remembered: false };
    this.steps?.remember(sender.tab.id, page.origin, { username: message.username.trim(), id: null });
    return { remembered: true };
  }
  async open(sender) {
    const page = await this.allowed(sender);
    if (!page) return { available: false };
    const state = await this.vault.status();
    for (const [token, entry] of this.pending) {
      if (entry.expires <= this.now() || entry.session !== state.session) { this.pending.delete(token); continue; }
      if (entry.tabId !== sender.tab.id || entry.origin !== page.origin) continue;
      // Rebind after a same-origin login redirect. Old frames become unusable.
      if (entry.documentId !== sender.documentId) { entry.documentId = sender.documentId; entry.panelId = null; }
      return { enabled: true, available: true, token };
    }
    return { enabled: true, available: false };
  }
  describe(entry) {
    const candidates = entry.candidates.flatMap(id => {
      try {
        const { name, urls, environment, updatedAt } = this.vault.item(entry.session, id);
        return [{ id, name, scope: scopeLabel(urls[0]), url: urls[0], environment, updatedAt }];
      } catch { return []; }
    });
    return { origin: entry.origin, site: scopeLabel(entry.url), username: entry.username, kind: entry.kind,
      update: candidates.length > 0, preferNew: entry.preferNew || !candidates.length, candidates };
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
    if (message.type === "SAVE_PROMPT_STATE") return this.describe(entry);
    if (message.type === "SAVE_PROMPT_DISMISS") { this.pending.delete(message.token); this.schedule(); return null; }
    if (message.type !== "SAVE_PROMPT_CONFIRM") throw new Error("Unsupported save action.");
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active?.id !== entry.tabId) throw new Error("Return to the login tab to save this password.");
    let input;
    if (message.action === "update") {
      // Never guess: the user picked this login from the candidates shown in the prompt.
      if (!entry.candidates.includes(message.id)) throw new Error("Choose which saved login to update.");
      input = { ...this.vault.item(entry.session, message.id), password: entry.password };
    } else if (message.action === "new") {
      const url = parseWebsite(entry.url);
      input = { name: scopeLabel(url), urls: [entry.url], username: entry.username, password: entry.password, notes: "",
        environment: isLocalHost(url) ? "local" : "other" };
    } else throw new Error("Unsupported save action.");
    // A revision check prevents a delayed prompt from overwriting newer edits.
    await this.vault.saveItem(entry.session, entry.revision, input);
    this.pending.delete(message.token); this.schedule();
    return { saved: true };
  }
}
