import { createEncryptedVault, decryptVault, encryptVault, parseBackup, validateEnvelope } from "../crypto/crypto.js";
import { emptyVault, createItem, validateSettings } from "./schema.js";
import { matchesCredential } from "../matching/url-matcher.js";

export class Vault {
  #key = null; #data = null; #envelope = null; #epoch = 0; #session = null; #lastActivity = 0; #pendingImport = null;
  constructor(storage, now = Date.now, onLock = () => {}) { this.storage = storage; this.now = now; this.onLock = onLock; }

  lock() { this.#epoch++; this.#key = null; this.#data = null; this.#envelope = null; this.#session = null; this.#lastActivity = 0; this.#pendingImport = null; this.onLock(); }
  get unlocked() { return !!this.#key; }
  get deadline() { return this.#data?.settings.autoLockMinutes ? this.#lastActivity + this.#data.settings.autoLockMinutes * 60000 : null; }
  expire() { if (this.deadline && this.now() >= this.deadline) this.lock(); }
  async status() {
    this.expire();
    return { exists: !!(await this.storage.read()), unlocked: !!this.#key, session: this.#session, deadline: this.deadline,
      revision: this.#data?.revision, settings: this.#data ? { ...this.#data.settings } : null };
  }
  require(session) {
    this.expire();
    if (!this.#key || session !== this.#session) throw new Error("Vault locked. Enter your master password again.");
  }
  touch(session) { this.require(session); this.#lastActivity = this.now(); }
  #checkEpoch(epoch) { if (epoch !== this.#epoch) throw new Error("Operation cancelled because the vault was locked."); }
  #activate(key, payload, envelope) {
    this.#key = key; this.#data = payload; this.#envelope = envelope;
    this.#session = crypto.randomUUID(); this.#lastActivity = this.now();
  }
  async create(password) {
    const epoch = this.#epoch;
    if (await this.storage.read()) throw new Error("A vault already exists. Unlock it or import a backup.");
    this.#checkEpoch(epoch);
    const payload = emptyVault();
    const { key, envelope } = await createEncryptedVault(payload, password);
    this.#checkEpoch(epoch);
    await this.storage.write(envelope);
    this.#checkEpoch(epoch);
    this.#activate(key, payload, envelope);
    return this.status();
  }
  async unlock(password) {
    this.lock();
    const epoch = this.#epoch;
    const stored = await this.storage.read();
    if (!stored) throw new Error("Create a vault or import an encrypted backup first.");
    const { key, payload, envelope } = await decryptVault(stored, password);
    this.#checkEpoch(epoch);
    this.#activate(key, payload, envelope);
    return this.status();
  }
  list(session, query = "", url = null) {
    this.require(session);
    if (typeof query !== "string" || query.length > 200) throw new Error("Search is too long.");
    const needle = query.toLocaleLowerCase();
    return this.#data.items.filter(item => (!url || matchesCredential(item, url)) &&
      [item.name, item.username, ...item.urls].some(value => value.toLocaleLowerCase().includes(needle)))
      .map(({ id, name, urls, username, environment }) => ({ id, name, urls: [...urls], username, environment }));
  }
  item(session, id) {
    this.require(session);
    const item = this.#data.items.find(item => item.id === id);
    if (!item) throw new Error("This login no longer exists. Refresh the vault.");
    return structuredClone(item);
  }
  async #save(data, session, revision) {
    this.require(session);
    if (revision !== this.#data.revision) throw new Error("The vault changed in another window. Reopen this login before saving.");
    const epoch = this.#epoch;
    const next = { ...data, revision: revision + 1 };
    const encrypted = await encryptVault(next, this.#key, this.#envelope.kdf);
    this.#checkEpoch(epoch); this.require(session);
    await this.storage.write(encrypted);
    this.#checkEpoch(epoch);
    this.#data = next; this.#envelope = encrypted; this.touch(session);
    return this.status();
  }
  async saveItem(session, revision, input) {
    this.require(session);
    const previous = input?.id ? this.item(session, input.id) : null;
    const item = createItem(input, previous);
    const items = previous ? this.#data.items.map(entry => entry.id === item.id ? item : entry) : [...this.#data.items, item];
    return this.#save({ ...this.#data, items }, session, revision);
  }
  async deleteItem(session, revision, id) {
    this.item(session, id);
    return this.#save({ ...this.#data, items: this.#data.items.filter(item => item.id !== id) }, session, revision);
  }
  async settings(session, settings) {
    this.require(session);
    // Settings never touch logins, so a newer item revision should not reject the user's choice.
    return this.#save({ ...this.#data, settings: validateSettings(settings) }, session, this.#data.revision);
  }
  async export() {
    const stored = await this.storage.read();
    if (!stored) throw new Error("There is no vault to export.");
    return validateEnvelope(stored);
  }
  async prepareImport(text, password) {
    this.lock();
    const epoch = this.#epoch;
    const envelope = parseBackup(text);
    const { payload } = await decryptVault(envelope, password);
    const current = await this.storage.read();
    this.#checkEpoch(epoch);
    const token = crypto.randomUUID();
    // Keep only the authenticated encrypted file while the user confirms replacement.
    this.#pendingImport = { token, envelope, previous: JSON.stringify(current), expires: this.now() + 300000 };
    return { token, count: payload.items.length, replaces: !!current };
  }
  async commitImport(token, confirmed) {
    const epoch = this.#epoch;
    const pending = this.#pendingImport;
    if (!pending || token !== pending.token || this.now() >= pending.expires) throw new Error("Import expired. Select the backup again.");
    if (confirmed !== true) throw new Error("Confirm the replacement before importing.");
    if (JSON.stringify(await this.storage.read()) !== pending.previous) throw new Error("The vault changed. Validate the backup again before replacing it.");
    this.#checkEpoch(epoch);
    await this.storage.write(pending.envelope);
    this.lock();
    return this.status();
  }
}
