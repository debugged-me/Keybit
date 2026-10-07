import { announce } from "./common.js";

export class VaultClient {
  state = { exists: false, unlocked: false, session: null, ready: false };
  revoked = new Set();
  locking = false;
  constructor(onChange) {
    this.onChange = onChange;
    this.listener = message => { if (message?.event === "vault-state") this.update(message.state); };
    chrome.runtime.onMessage.addListener(this.listener);
    this.poll = setInterval(() => { if (!document.hidden) void this.refresh(); }, 5000);
    document.addEventListener("visibilitychange", async () => {
      if (document.hidden) document.body.classList.add("suspended");
      else { await this.refresh(); document.body.classList.remove("suspended"); }
    });
    let lastTouch = 0;
    const activity = event => {
      if (!event.isTrusted || !this.state.unlocked || document.hidden || Date.now() - lastTouch < 5000) return;
      lastTouch = Date.now();
      void this.request("TOUCH").then(state => this.update(state)).catch(() => this.refresh());
    };
    document.addEventListener("pointerdown", activity, { passive: true });
    document.addEventListener("keydown", activity);
    window.addEventListener("pagehide", () => {
      clearInterval(this.poll); clearTimeout(this.expiry);
      chrome.runtime.onMessage.removeListener(this.listener);
      this.onChange({ ...this.state, unlocked: false, session: null }, this.state);
    });
  }
  is(session) { return this.state.unlocked && session === this.state.session; }
  async request(type, args = {}) {
    const response = await chrome.runtime.sendMessage({ type, session: this.state.session, ...args });
    if (!response?.ok) throw new Error(response?.error ?? "The extension restarted. Please reopen it.");
    return response.data;
  }
  update(state) {
    if (state.unlocked && (this.locking || this.revoked.has(state.session))) return;
    const previous = this.state;
    // A delayed broadcast must not roll the view back to an older revision of the same session.
    if (state.unlocked && state.session === previous.session && state.revision < previous.revision) return;
    if (previous.session && previous.session !== state.session) this.revoked.add(previous.session);
    this.state = { ...state, ready: true };
    clearTimeout(this.expiry);
    if (state.unlocked && state.deadline) this.expiry = setTimeout(() => { void this.lock(); }, Math.max(0, state.deadline - Date.now()));
    if (!previous.ready || previous.session !== state.session || previous.exists !== state.exists || previous.revision !== state.revision) this.onChange(this.state, previous);
  }
  async refresh() {
    try { this.update(await this.request("STATUS")); }
    catch {
      this.update({ exists: true, unlocked: false, session: null });
      announce("Unable to reach the vault. Reopen the extension.", true);
    }
  }
  async lock() {
    this.locking = true;
    this.update({ ...this.state, unlocked: false, session: null, deadline: null, revision: undefined });
    try { await this.request("LOCK"); await this.refresh(); }
    catch { announce("The vault view has been cleared. Reopen the extension.", true); }
    finally { this.locking = false; }
  }
}
