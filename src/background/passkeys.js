import { parseWebsite } from "../matching/url-matcher.js";
import { fromBase64 } from "../crypto/encoding.js";
import { newPasskeyMaterial, attestationObject, clientDataJSON, signAssertion, base64url } from "../vault/passkey.js";

const PROMPT_MS = 120000;
const delegate = { action: "delegate" };
const expired = () => new Error("This passkey prompt expired. Call the site again.");

// WebAuthn ceremonies arrive from the page-facing relay as short-lived prompt tokens. The page's
// promise stays open while the card is up; every exit pushes a result message back to the tab.
export class PasskeyPrompts {
  pending = new Map(); // token → { tabId, documentId, panelId, session, kind, rpId, origin, challenge, user?, candidates?, expires }
  timer = null;
  constructor(vault, suggestions, now = Date.now) { this.vault = vault; this.suggestions = suggestions; this.now = now; }

  // The vault locked or the tab closed: the page must not wait on us, so tell it to run the
  // ceremony natively (its own passkeys or a hardware key still work).
  clear() { for (const token of [...this.pending.keys()]) this.#finish(token, delegate); }
  forgetTab(tabId) { for (const [token, entry] of this.pending) if (entry.tabId === tabId) this.pending.delete(token); this.schedule(); }
  schedule() {
    clearTimeout(this.timer);
    if (!this.pending.size) { this.timer = null; return; }
    const soonest = Math.min(...[...this.pending.values()].map(entry => entry.expires));
    this.timer = setTimeout(() => {
      for (const [token, entry] of this.pending) if (entry.expires <= this.now()) this.#finish(token, delegate);
      this.schedule();
    }, Math.max(0, soonest - this.now()));
    this.timer.unref?.();
  }
  #finish(token, result) {
    const entry = this.pending.get(token);
    this.pending.delete(token);
    this.schedule();
    if (entry) chrome.tabs.sendMessage(entry.tabId, { event: "keybit-passkey-result", token, result }, { frameId: 0 }).catch(() => {});
    return result;
  }

  async request(kind, message, sender) {
    try {
      if (sender.frameId !== 0 || !sender.documentId || !Number.isInteger(sender.tab?.id)) return delegate;
      const page = parseWebsite(sender.url);
      if (!(await this.suggestions.allows(page.origin))) return delegate;
      const state = await this.vault.status();
      if (!state.unlocked) return delegate;
      const options = message.options;
      const rpId = typeof options?.rpId === "string" && options.rpId ? options.rpId : page.hostname;
      // The browser enforces this for native ceremonies; KeyBit checks it when it answers instead.
      if (rpId !== page.hostname && !page.hostname.endsWith(`.${rpId}`)) return delegate;
      if (typeof options?.challenge !== "string" || !options.challenge.length || options.challenge.length > 2048 ||
          !/^[A-Za-z0-9_-]+$/.test(options.challenge)) return delegate;
      if (kind === "get") {
        const candidates = this.vault.passkeyCandidates(state.session, rpId, this.#ids(options.allowIds));
        if (!candidates.length) return delegate;
        const token = this.#register(sender, state, { kind, rpId, origin: page.origin, challenge: options.challenge, candidates });
        return { token };
      }
      // Create: the RP asks for a new credential. If it already knows one of ours (excludeCredentials),
      // the honest answer is the same refusal a hardware key gives.
      const user = options?.user;
      if (typeof user?.id !== "string" || !user.id.length || user.id.length > 256 || typeof user?.name !== "string" || !user.name || user.name.length > 1024 ||
          typeof user?.displayName !== "string" || user.displayName.length > 1024) return delegate;
      const excluded = this.#ids(options.excludeIds);
      if (this.vault.passkeyCandidates(state.session, rpId).some(item => excluded.has(item.credentialId))) return { action: "cancel" };
      const token = this.#register(sender, state, { kind, rpId, origin: page.origin, challenge: options.challenge,
        user: { id: user.id, name: user.name, displayName: user.displayName || user.name } });
      return { token };
    } catch { return delegate; }
  }
  #ids(list) {
    if (!Array.isArray(list)) return new Set();
    const ids = new Set();
    for (const id of list.slice(0, 64)) if (typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id) && id.length <= 1023) ids.add(id);
    return ids;
  }
  #register(sender, state, fields) {
    if (this.pending.size >= 20) this.clear();
    const token = crypto.randomUUID();
    this.pending.set(token, { tabId: sender.tab.id, documentId: sender.documentId, panelId: null, session: state.session,
      expires: this.now() + PROMPT_MS, ...fields });
    this.schedule();
    return token;
  }

  describe(entry) {
    return { kind: entry.kind, site: entry.rpId, user: entry.user ?? null,
      candidates: (entry.candidates ?? []).map(item => ({ credentialId: item.credentialId, userName: item.userName, lastUsedAt: item.lastUsedAt })) };
  }
  async panel(message, sender) {
    const entry = this.pending.get(message.token);
    if (!entry || entry.expires <= this.now()) { this.pending.delete(message.token); this.schedule(); throw expired(); }
    if (sender.tab?.id !== entry.tabId || sender.frameId <= 0 || !sender.documentId ||
        (entry.panelId && entry.panelId !== sender.documentId)) throw expired();
    entry.panelId = sender.documentId;
    this.vault.require(entry.session);
    if (message.type === "PASSKEY_STATE") return this.describe(entry);
    if (message.type === "PASSKEY_DISMISS") { this.#finish(message.token, delegate); return null; }
    if (message.type !== "PASSKEY_CONFIRM") throw new Error("Unsupported passkey action.");
    if (message.action === "device") { this.#finish(message.token, delegate); return null; }
    if (message.action !== "keybit") throw new Error("Unsupported passkey action.");
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active?.id !== entry.tabId) throw new Error("Return to the site's tab to finish the passkey.");
    const credential = entry.kind === "create" ? await this.#create(entry) : await this.#assert(entry, message.credentialId);
    this.#finish(message.token, { action: "keybit", credential });
    return { done: true };
  }
  async #create(entry) {
    const material = await newPasskeyMaterial();
    const clientData = clientDataJSON("webauthn.create", entry.challenge, entry.origin);
    const { attestation, authData } = await attestationObject(entry.rpId, material.credentialId, material.coseKey);
    const credentialId = base64url(material.credentialId);
    // The vault may have changed while the card was up; take the current revision for this write.
    const state = await this.vault.status();
    this.vault.require(entry.session);
    const name = entry.user.name.slice(0, 200);
    await this.vault.saveItem(entry.session, state.revision, { type: "passkey", name, urls: [], username: "", password: "", notes: "",
      rpId: entry.rpId, credentialId, userName: entry.user.name, userHandle: entry.user.id,
      privateKey: material.privateKey, signCount: 0 });
    return { id: credentialId, rawId: credentialId,
      clientDataJSON: base64url(clientData), attestationObject: base64url(attestation),
      authenticatorData: base64url(authData), publicKey: base64url(fromBase64(material.publicKey)) };
  }
  async #assert(entry, credentialId) {
    const candidates = entry.candidates ?? [];
    const picked = credentialId ? candidates.find(item => item.credentialId === credentialId) : candidates[0];
    if (!picked) throw new Error("This passkey is no longer available.");
    const item = this.vault.item(entry.session, picked.id);
    const clientData = clientDataJSON("webauthn.get", entry.challenge, entry.origin);
    const signCount = item.signCount + 1;
    const { authData, signature } = await signAssertion(item.privateKey, entry.rpId, clientData, signCount);
    await this.vault.touchPasskey(entry.session, item.id, signCount);
    return { id: item.credentialId, rawId: item.credentialId,
      clientDataJSON: base64url(clientData), authenticatorData: base64url(authData),
      signature: base64url(signature), userHandle: item.userHandle || null };
  }
}
