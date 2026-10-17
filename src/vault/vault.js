import { createEncryptedVaultWithRaw, decryptVault, decryptVaultWithRaw, decryptWithKey, encryptVault, parseBackup, validateEnvelope, newKdf } from "../crypto/crypto.js";
import { splitSecret, encodeShare, recoveryPassphrase } from "./shamir.js";
import { deriveKey, deriveKeyAndRaw, deriveRawKey, importRawKey } from "../crypto/kdf.js";
import { emptyVault, createItem, validateSettings, validateProjects, duplicateKey, HISTORY_LIMIT, ENVIRONMENTS } from "./schema.js";
import { matcherFor, scopeLabel, specificity, parseWebsite } from "../matching/url-matcher.js";
import { securityReport, vaultHealth } from "./health.js";
import { toCsv } from "./csv.js";

const MAX_IMPORT = 100000;
export const TRASH_DAYS = 30;
export class Vault {
  #key = null; #data = null; #envelope = null; #epoch = 0; #session = null; #lastActivity = 0; #pendingImport = null; #exists; #sessionKey = null;
  constructor(storage, now = Date.now, onLock = () => {}) { this.storage = storage; this.now = now; this.onLock = onLock; }

  lock() { this.#epoch++; this.#key = null; this.#data = null; this.#envelope = null; this.#session = null; this.#lastActivity = 0; this.#pendingImport = null; this.#sessionKey?.fill(0); this.#sessionKey = null; this.onLock(); }
  get unlocked() { return !!this.#key; }
  get currentSettings() { return this.#data ? { ...this.#data.settings } : null; }
  get kdfSalt() { return this.#envelope?.kdf.salt ?? null; }
  get deadline() { return this.#data?.settings.autoLockMinutes ? this.#lastActivity + this.#data.settings.autoLockMinutes * 60000 : null; }
  expire() { if (this.deadline && this.now() >= this.deadline) this.lock(); }
  // Whether a vault exists is read from storage once, then tracked; status is polled often and vaults can be megabytes.
  async #hasVault() { if (this.#exists === undefined) this.#exists = !!(await this.storage.read()); return this.#exists; }
  async #write(envelope) { await this.storage.write(envelope); this.#exists = true; }
  async status() {
    this.expire();
    return { exists: await this.#hasVault(), unlocked: !!this.#key, session: this.#session, deadline: this.deadline,
      revision: this.#data?.revision, settings: this.#data ? { ...this.#data.settings } : null };
  }
  require(session) {
    this.expire();
    if (!this.#key || session !== this.#session) throw new Error("Vault locked. Enter your master password again.");
  }
  touch(session) { this.require(session); this.#lastActivity = this.now(); }
  #checkEpoch(epoch) { if (epoch !== this.#epoch) throw new Error("Operation cancelled because the vault was locked."); }
  #activate(key, payload, envelope, raw = null) {
    this.#key = key; this.#data = payload; this.#envelope = envelope;
    this.#sessionKey?.fill(0); this.#sessionKey = raw;
    this.#session = crypto.randomUUID(); this.#lastActivity = this.now();
  }
  async create(password) {
    const epoch = this.#epoch;
    if (await this.storage.read()) throw new Error("A vault already exists. Unlock it or import a backup.");
    this.#checkEpoch(epoch);
    const payload = emptyVault();
    const { key, envelope, raw } = await createEncryptedVaultWithRaw(payload, password);
    try {
      this.#checkEpoch(epoch);
      await this.#write(envelope);
      this.#checkEpoch(epoch);
      this.#activate(key, payload, envelope, raw);
    } catch (error) { raw.fill(0); throw error; }
    return this.status();
  }
  async unlock(password) {
    this.lock();
    const epoch = this.#epoch;
    const stored = await this.storage.read();
    if (!stored) throw new Error("Create a vault or import an encrypted backup first.");
    const { key, payload, envelope, raw } = await decryptVaultWithRaw(stored, password);
    try {
      this.#checkEpoch(epoch);
      this.#activate(key, payload, envelope, raw);
    } catch (error) { raw.fill(0); throw error; }
    await this.#purgeExpiredTrash();
    return this.status();
  }
  // The open vault's raw key bytes — lets the worker keep the session across restarts. Returns a
  // copy the caller must zero; null when there is nothing to keep.
  rawSessionKey(session) {
    this.require(session);
    return this.#sessionKey ? this.#sessionKey.slice() : null;
  }
  // Touch ID: unlock with key bytes released by the device authenticator.
  async unlockWithRawKey(raw) {
    this.lock();
    const epoch = this.#epoch;
    const stored = await this.storage.read();
    if (!stored) throw new Error("Create a vault or import an encrypted backup first.");
    let opened;
    try { opened = await decryptWithKey(stored, await importRawKey(raw)); }
    catch { throw new Error("Touch ID unlock is out of date. Unlock with your master password, then turn Touch ID on again."); }
    this.#checkEpoch(epoch);
    this.#activate(opened.key, opened.payload, opened.envelope, raw.slice());
    await this.#purgeExpiredTrash();
    return this.status();
  }
  // Trash older than 30 days is removed for good, checked when the vault opens. A failure to
  // save the cleanup must not block unlocking.
  async #purgeExpiredTrash() {
    try {
      const cutoff = this.now() - TRASH_DAYS * 86400000;
      const items = this.#data.items.filter(item => !item.deletedAt || Date.parse(item.deletedAt) > cutoff);
      if (items.length === this.#data.items.length) return;
      const next = { ...this.#data, revision: this.#data.revision + 1, items };
      const encrypted = await encryptVault(next, this.#key, this.#envelope.kdf);
      await this.#write(encrypted);
      this.#data = next; this.#envelope = encrypted;
    } catch { /* Expired items will be removed on a later unlock instead. */ }
  }
  // Proves the master password for the open vault and returns its raw key bytes (caller zeroes them).
  async rawKeyFor(session, password) {
    this.require(session);
    const raw = await deriveRawKey(password, this.#envelope.kdf);
    try { await decryptWithKey(this.#envelope, await importRawKey(raw)); }
    catch { raw.fill(0); throw new Error("Incorrect master password."); }
    return raw;
  }
  // Every distinct site hostname in the vault — used to spot lookalike pages before filling.
  hosts(session) {
    const hosts = new Set();
    for (const item of this.list(session)) for (const url of item.urls ?? []) {
      try { hosts.add(new URL(url).hostname); } catch { /* A saved address that no longer parses is ignored. */ }
    }
    return [...hosts];
  }
  list(session, query = "", url = null) {
    this.require(session);
    if (typeof query !== "string" || query.length > 200) throw new Error("Search is too long.");
    const needle = query.toLocaleLowerCase();
    const fits = url ? matcherFor(url) : null;
    const items = this.#data.items.filter(item => !item.deletedAt && (!fits || fits(item)) &&
      (!needle || [item.name, item.username, item.project, item.rpId ?? "", item.cardholder ?? "", item.firstName ?? "", item.lastName ?? "", item.email ?? "", item.number?.slice(-4) ?? "", ...item.urls].some(value => value.toLocaleLowerCase().includes(needle))));
    // On a page, a project-folder login is a better match than a whole-site one.
    if (url) items.sort((a, b) => specificity(b) - specificity(a));
    return items.map(({ id, type, name, urls, username, environment, project, favorite, totp, updatedAt, rpId, credentialId, userName, lastUsedAt, cardholder, brand, number, firstName, lastName, email, city, country }) => ({ id, type, name, urls: [...urls],
      scope: urls.length ? scopeLabel(urls[0]) : "", username, environment, project, favorite, hasTotp: !!totp, updatedAt,
      ...(type === "passkey" ? { rpId, credentialId, userName, lastUsedAt } : {}),
      // Only display-safe card/identity fields join the list; the PAN, CVV, and street stay in the encrypted item.
      ...(type === "card" ? { cardholder, brand, last4: number.slice(-4), lastUsedAt } : {}),
      ...(type === "identity" ? { fullName: [firstName, lastName].filter(Boolean).join(" "), email, city, country, lastUsedAt } : {}) }));
  }
  projects(session) {
    this.require(session);
    const named = this.#data.items.filter(item => !item.deletedAt).map(item => item.project);
    return [...new Set([...named, ...Object.keys(this.#data.projects ?? {})].filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }
  // Every project's environment → URL map. `merged` is what switching resolves against: the
  // configured map (vault.projects, returned as `configured`) wins; a login's own environment +
  // first URL fills gaps so switching works before anything is configured.
  environments(session) {
    this.require(session);
    const merged = {}, configured = {};
    for (const [name, entry] of Object.entries(this.#data.projects ?? {})) {
      configured[name] = { ...entry.environments };
      merged[name] = { ...entry.environments };
    }
    for (const item of this.#data.items) {
      if (item.deletedAt || !item.project || !item.urls?.length) continue;
      merged[item.project] ??= {};
      merged[item.project][item.environment] ??= item.urls[0];
    }
    return { merged, configured };
  }
  // Where an environment switch lands: the environment's URL plus the login (same project first)
  // that would fill there — or no item, which the caller turns into a safe empty state. When the
  // current page sits under one of this project's environment addresses, the part after that base —
  // path, query, hash — is carried onto the target base, so /app/login.php maps across unchanged.
  environmentTarget(session, project, environment, pageUrl = null) {
    this.require(session);
    const envs = this.environments(session).merged[project] ?? {};
    const base = envs[environment];
    if (!base) return { url: null };
    let url = base;
    try {
      const page = parseWebsite(pageUrl);
      const strip = value => { const u = parseWebsite(value); return { origin: u.origin, path: u.pathname.replace(/\/+$/, "") }; };
      const current = Object.values(envs).map(strip)
        .filter(b => b.origin === page.origin && (page.pathname === b.path || page.pathname.startsWith(`${b.path}/`)))
        .sort((a, b) => b.path.length - a.path.length)[0];
      if (current) {
        const relative = page.href.slice(`${current.origin}${current.path}`.length);
        const target = strip(base);
        url = new URL(`${target.origin}${target.path}${relative}`).href;
      }
    } catch { /* No usable page URL — the environment's base address stands alone. */ }
    const fits = matcherFor(url);
    const logins = this.#data.items.filter(item => item.type === "login" && !item.deletedAt && fits(item));
    const item = logins.find(login => login.project === project) ?? logins[0];
    return { url, itemId: item?.id ?? null };
  }
  async setProjectEnvironments(session, revision, name, environments) {
    this.require(session);
    const project = String(name ?? "").slice(0, 100).trim();
    let clean;
    try { clean = validateProjects({ [project]: { environments } })[project]; }
    catch { throw new Error("Use environment names like staging, and full http(s) URLs."); }
    if (!clean) throw new Error("Use environment names like staging, and full http(s) URLs.");
    const projects = { ...this.#data.projects };
    if (Object.keys(clean.environments).length) projects[project] = clean; else delete projects[project];
    return this.#save({ ...this.#data, projects }, session, revision);
  }
  health(session) {
    this.require(session);
    const live = this.#data.items.filter(item => !item.deletedAt);
    const logins = live.filter(item => item.type === "login");
    return { flags: vaultHealth(logins), report: securityReport(live) };
  }
  // Recently deleted: same summaries as list(), newest deletion first, with the deletion date.
  listDeleted(session) {
    this.require(session);
    return this.#data.items.filter(item => item.deletedAt)
      .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
      .map(({ id, type, name, urls, username, environment, project, favorite, totp, updatedAt, deletedAt, rpId, credentialId, userName, lastUsedAt, cardholder, brand, number, firstName, lastName, email, city, country }) => ({ id, type, name, urls: [...urls],
        scope: urls.length ? scopeLabel(urls[0]) : "", username, environment, project, favorite, hasTotp: !!totp, updatedAt, deletedAt,
        ...(type === "passkey" ? { rpId, credentialId, userName, lastUsedAt } : {}),
        ...(type === "card" ? { cardholder, brand, last4: number.slice(-4) } : {}),
        ...(type === "identity" ? { fullName: [firstName, lastName].filter(Boolean).join(" "), email, city, country } : {}) }));
  }
  // WebAuthn lookup for a sign-in ceremony: credentials at this relying party, narrowed by the
  // page's allowCredentials list when it gave one (an empty list means any passkey here may serve).
  passkeyCandidates(session, rpId, allowedIds) {
    this.require(session);
    const allowed = Array.isArray(allowedIds) && allowedIds.length ? new Set(allowedIds.slice(0, 64)) : null;
    return this.#data.items.filter(item => item.type === "passkey" && !item.deletedAt && item.rpId === rpId &&
      (!allowed || allowed.has(item.credentialId)))
      .map(item => ({ id: item.id, name: item.name, credentialId: item.credentialId, userName: item.userName, lastUsedAt: item.lastUsedAt }));
  }
  // A real authenticator bumps its signature counter on every assertion; so does KeyBit.
  async touchPasskey(session, id, signCount) {
    this.require(session);
    const item = this.item(session, id);
    if (item.type !== "passkey" || item.deletedAt) throw new Error("This passkey no longer exists.");
    const lastUsedAt = new Date(this.now()).toISOString();
    const items = this.#data.items.map(entry => entry.id === id ? { ...entry, signCount, lastUsedAt, updatedAt: lastUsedAt } : entry);
    return this.#save({ ...this.#data, items }, session, this.#data.revision);
  }
  item(session, id) {
    this.require(session);
    const item = this.#data.items.find(item => item.id === id);
    if (!item) throw new Error("This item no longer exists. Refresh the vault.");
    return structuredClone(item);
  }
  async #save(data, session, revision) {
    this.require(session);
    if (revision !== this.#data.revision) throw new Error("The vault changed in another window. Reopen this login before saving.");
    const epoch = this.#epoch;
    const next = { ...data, revision: revision + 1 };
    const encrypted = await encryptVault(next, this.#key, this.#envelope.kdf);
    this.#checkEpoch(epoch); this.require(session);
    await this.#write(encrypted);
    this.#checkEpoch(epoch);
    this.#data = next; this.#envelope = encrypted; this.touch(session);
    return this.status();
  }
  #replacedHistory(previous, password) {
    // History is derived here, never taken from the caller. Restoring an old password removes its duplicate.
    return previous && previous.type === "login" && previous.password !== password
      ? [{ password: previous.password, changedAt: new Date(this.now()).toISOString() }, ...previous.history]
        .filter(entry => entry.password !== password).slice(0, HISTORY_LIMIT)
      : previous?.history ?? [];
  }
  async saveItem(session, revision, input) {
    this.require(session);
    const previous = input?.id ? this.item(session, input.id) : null;
    const item = createItem({ ...input, history: this.#replacedHistory(previous, input?.password) }, previous);
    const items = previous ? this.#data.items.map(entry => entry.id === item.id ? item : entry) : [...this.#data.items, item];
    return this.#save({ ...this.#data, items }, session, revision);
  }
  // Deleting moves an item to Recently deleted; purgeItem and the 30-day sweep remove it for good.
  async deleteItem(session, revision, id) {
    this.item(session, id);
    const deletedAt = new Date(this.now()).toISOString();
    const items = this.#data.items.map(item => item.id === id ? { ...item, deletedAt } : item);
    return this.#save({ ...this.#data, items }, session, revision);
  }
  async restoreItem(session, revision, id) {
    const item = this.item(session, id);
    if (!item.deletedAt) throw new Error("This item is not in Recently deleted.");
    const items = this.#data.items.map(entry => entry.id === id ? { ...entry, deletedAt: null } : entry);
    return this.#save({ ...this.#data, items }, session, revision);
  }
  async purgeItem(session, revision, id) {
    this.item(session, id);
    return this.#save({ ...this.#data, items: this.#data.items.filter(item => item.id !== id) }, session, revision);
  }
  async emptyTrash(session, revision) {
    this.require(session);
    const items = this.#data.items.filter(item => !item.deletedAt);
    return items.length === this.#data.items.length ? this.status() : this.#save({ ...this.#data, items }, session, revision);
  }
  async settings(session, settings) {
    this.require(session);
    // Settings never touch logins, so a newer item revision should not reject the user's choice.
    return this.#save({ ...this.#data, settings: validateSettings({ ...this.#data.settings, ...settings }) }, session, this.#data.revision);
  }
  async changePassword(session, current, next) {
    this.require(session);
    if (typeof next !== "string" || [...next].length < 12) throw new Error("Use a new master password of at least 12 characters.");
    if (next === current) throw new Error("Choose a master password different from the current one.");
    const epoch = this.#epoch;
    // Prove the current password against the stored vault before replacing the key.
    try { await decryptVault(this.#envelope, current); } catch { throw new Error("The current master password is incorrect."); }
    this.#checkEpoch(epoch); this.require(session);
    const kdf = newKdf();
    const { key, raw } = await deriveKeyAndRaw(next, kdf);
    let owned = false;
    try {
      const payload = { ...this.#data, revision: this.#data.revision + 1 };
      const encrypted = await encryptVault(payload, key, kdf);
      this.#checkEpoch(epoch); this.require(session);
      await this.#write(encrypted);
      this.#checkEpoch(epoch);
      this.#key = key; this.#data = payload; this.#envelope = encrypted;
      this.#sessionKey?.fill(0); this.#sessionKey = raw; owned = true;
      this.touch(session);
    } finally { if (!owned) raw.fill(0); }
    return this.status();
  }
  // Import from another password manager: new items only; exact duplicates and invalid rows are skipped.
  #importable(inputs) {
    if (!Array.isArray(inputs) || inputs.length > MAX_IMPORT) throw new Error("This file has too many entries to import.");
    // Trashed items do not block re-adding the same login: Recently deleted is as good as gone for matching.
    const seen = new Set(this.#data.items.filter(item => !item.deletedAt).map(item => duplicateKey(item, scopeLabel)));
    const items = [];
    let duplicates = 0, invalid = 0;
    for (const input of inputs) {
      const clean = { type: input?.type === "note" ? "note" : "login", name: String(input?.name ?? "").slice(0, 200).trim(), urls: Array.isArray(input?.urls) ? input.urls.slice(0, 10) : [],
        username: String(input?.username ?? "").slice(0, 1024), password: String(input?.password ?? ""), notes: String(input?.notes ?? "").slice(0, 20000),
        environment: ENVIRONMENTS.includes(input?.environment) ? input.environment : "other", project: String(input?.project ?? "").slice(0, 100),
        favorite: input?.favorite === true, totp: String(input?.totp ?? "") };
      let item;
      try { item = createItem(clean, null); }
      catch {
        // A malformed 2FA secret should not lose the login itself.
        try { item = createItem({ ...clean, totp: "" }, null); } catch { invalid++; continue; }
      }
      const key = duplicateKey(item, scopeLabel);
      if (seen.has(key)) { duplicates++; continue; }
      seen.add(key); items.push(item);
    }
    return { items, duplicates, invalid };
  }
  previewImport(session, inputs) {
    this.require(session);
    const { items, duplicates, invalid } = this.#importable(inputs);
    return { logins: items.filter(item => item.type === "login").length, notes: items.filter(item => item.type === "note").length, duplicates, invalid };
  }
  async importItems(session, revision, inputs) {
    this.require(session);
    const { items, duplicates, invalid } = this.#importable(inputs);
    const state = items.length ? await this.#save({ ...this.#data, items: [...this.#data.items, ...items] }, session, revision) : await this.status();
    return { state, added: items.length, duplicates, invalid };
  }
  // Merge a KeyBit backup into the open vault: new items are added, newer copies of the same item win,
  // and nothing is deleted. A replaced password is kept in history.
  async mergeBackup(session, revision, text, password) {
    this.require(session);
    const epoch = this.#epoch;
    const { payload } = await decryptVault(parseBackup(text), password);
    this.#checkEpoch(epoch); this.require(session);
    const items = [...this.#data.items];
    const index = new Map(items.map((item, position) => [item.id, position]));
    const seen = new Set(items.filter(item => !item.deletedAt).map(item => duplicateKey(item, scopeLabel)));
    let added = 0, updated = 0, unchanged = 0;
    for (const incoming of payload.items) {
      const position = index.get(incoming.id);
      if (position !== undefined) {
        const existing = items[position];
        if (incoming.updatedAt > existing.updatedAt && JSON.stringify(incoming) !== JSON.stringify(existing)) {
          items[position] = incoming.type === "login" ? { ...incoming, history: this.#replacedHistory(existing, incoming.password)
            .concat(incoming.history).filter((entry, i, all) => entry.password !== incoming.password && all.findIndex(other => other.password === entry.password) === i).slice(0, HISTORY_LIMIT) } : incoming;
          updated++;
        } else unchanged++;
      } else if (seen.has(duplicateKey(incoming, scopeLabel))) unchanged++;
      else { items.push(incoming); seen.add(duplicateKey(incoming, scopeLabel)); added++; }
    }
    // Environment maps ride along in backups too: merge per key, keeping local entries on conflict.
    const projects = { ...this.#data.projects };
    for (const [name, entry] of Object.entries(payload.projects ?? {})) {
      if (!projects[name]) { projects[name] = entry; continue; }
      for (const [env, url] of Object.entries(entry.environments))
        if (!(env in projects[name].environments)) projects[name] = { environments: { ...projects[name].environments, [env]: url } };
    }
    const changed = added || updated || JSON.stringify(projects) !== JSON.stringify(this.#data.projects);
    const state = changed ? await this.#save({ ...this.#data, items, projects }, session, revision) : await this.status();
    return { state, added, updated, unchanged };
  }
  async export() {
    const stored = await this.storage.read();
    if (!stored) throw new Error("There is no vault to export.");
    return validateEnvelope(stored);
  }
  // Plain-text CSV for moving to another manager. Recently deleted items are not exported;
  // passkeys are never exported: a private key in a spreadsheet is a leak, not a migration.
  exportCsv(session) {
    this.require(session);
    return toCsv(this.#data.items.filter(item => !item.deletedAt && (item.type === "login" || item.type === "note")));
  }
  // One item encrypted with a share passphrase, as a .kvault the recipient merges like a backup.
  async shareItem(session, id, passphrase) {
    const item = this.item(session, id);
    if (item.type === "passkey") throw new Error("Passkeys are bound to this device and can't be shared.");
    if (typeof passphrase !== "string" || [...passphrase].length < 8) throw new Error("Choose a share passphrase of at least 8 characters.");
    const copy = { ...item, id: crypto.randomUUID(), deletedAt: null, history: [], favorite: false };
    const payload = { version: 1, revision: 0, items: [copy], settings: { autoLockMinutes: 0, lockOnScreenLock: false, stayUnlocked: false } };
    const kdf = newKdf();
    const key = await deriveKey(passphrase, kdf);
    return encryptVault(payload, key, kdf);
  }
  // A recovery kit: the vault snapshot encrypted under a random secret that is then split
  // M-of-N — any `threshold` shares rebuild the passphrase that opens this bundle. Shares go
  // to people you trust; the bundle is safe to store anywhere, even next to the shares list
  // you did not keep.
  async recoveryKit(session, threshold, count) {
    this.require(session);
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const { kit, shares } = splitSecret(secret, threshold, count);
    const kdf = newKdf();
    const bundle = await encryptVault(this.#data, await deriveKey(recoveryPassphrase(secret), kdf), kdf);
    secret.fill(0);
    return { bundle, threshold, count, shares: shares.map(share => encodeShare(kit, threshold, share.index, share.bytes)) };
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
    await this.#write(pending.envelope);
    this.lock();
    return this.status();
  }
}
