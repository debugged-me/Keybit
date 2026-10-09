import test from "node:test";
import assert from "node:assert/strict";
import { Vault } from "../src/vault/vault.js";
import { createItem } from "../src/vault/schema.js";
import { createEncryptedVault, decryptVault, encryptVault } from "../src/crypto/crypto.js";

const password = "a unique test passphrase";
const login = { name: "Private test name", urls: ["https://secret.example.com"], username: "private-user", password: "private-password", notes: "private-notes", environment: "production" };
function memoryStorage() {
  let data = null;
  return { async read() { return structuredClone(data); }, async write(value) { data = structuredClone(value); } };
}

test("encrypted CRUD, search, revisions, serialization, restart and lock", async () => {
  const storage = memoryStorage();
  const vault = new Vault(storage);
  let state = await vault.create(password);
  state = await vault.saveItem(state.session, state.revision, login);
  const result = vault.list(state.session, "private");
  assert.equal(result.length, 1);
  assert.equal(result[0].password, undefined);
  assert.equal(result[0].notes, undefined);
  const serialized = JSON.stringify(await storage.read());
  for (const secret of [password, login.name, login.username, login.password, login.notes, login.urls[0]]) assert.equal(serialized.includes(secret), false);
  const item = vault.item(state.session, result[0].id);
  state = await vault.saveItem(state.session, state.revision, { ...item, name: "Edited" });
  await assert.rejects(vault.saveItem(state.session, 0, item), /another window/);
  vault.lock();
  assert.equal((await vault.status()).unlocked, false);
  assert.throws(() => vault.item(state.session, item.id), /locked/);
  const restarted = new Vault(storage);
  assert.equal((await restarted.status()).unlocked, false);
  state = await restarted.unlock(password);
  assert.equal(restarted.item(state.session, item.id).name, "Edited");
  state = await restarted.deleteItem(state.session, state.revision, item.id);
  assert.deepEqual(restarted.list(state.session), []);
});

test("deleting keeps items in Recently deleted for 30 days, with restore and permanent removal", async () => {
  let now = Date.now();
  const storage = memoryStorage();
  const vault = new Vault(storage, () => now);
  let state = await vault.create(password);
  state = await vault.saveItem(state.session, state.revision, login);
  const id = vault.list(state.session)[0].id;
  state = await vault.deleteItem(state.session, state.revision, id);
  assert.deepEqual(vault.list(state.session), [], "Trashed items leave the vault lists");
  const trashed = vault.listDeleted(state.session);
  assert.equal(trashed.length, 1);
  assert.equal(trashed[0].id, id);
  assert.ok(trashed[0].deletedAt);
  assert.equal(trashed[0].password, undefined, "Trash summaries never include secrets");
  assert.equal(vault.item(state.session, id).name, login.name, "The trashed item is still readable for its detail view");
  await assert.rejects(vault.restoreItem(state.session, state.revision, "missing"), /no longer exists/);
  state = await vault.restoreItem(state.session, state.revision, id);
  assert.equal(vault.list(state.session).length, 1, "Restore brings the item back");
  assert.equal(vault.item(state.session, id).deletedAt, null);
  await assert.rejects(vault.restoreItem(state.session, state.revision, id), /not in Recently deleted/);
  state = await vault.deleteItem(state.session, state.revision, id);
  state = await vault.purgeItem(state.session, state.revision, id);
  assert.deepEqual(vault.listDeleted(state.session), [], "Purge removes the item forever");
  assert.throws(() => vault.item(state.session, id), /no longer exists/);
  // Emptying the bin removes everything it held.
  state = await vault.saveItem(state.session, state.revision, { ...login, name: "Extra" });
  state = await vault.deleteItem(state.session, state.revision, vault.list(state.session)[0].id);
  assert.equal(vault.listDeleted(state.session).length, 1);
  state = await vault.emptyTrash(state.session, state.revision);
  assert.deepEqual(vault.listDeleted(state.session), []);
  // The 30-day sweep runs on unlock: the item survives a restart inside the window, then expires.
  state = await vault.saveItem(state.session, state.revision, login);
  const keepId = vault.list(state.session)[0].id;
  state = await vault.deleteItem(state.session, state.revision, keepId);
  now += 29 * 86400000;
  const within = new Vault(storage, () => now);
  state = await within.unlock(password);
  assert.equal(within.listDeleted(state.session).length, 1, "Trash survives a restart inside 30 days");
  now += 2 * 86400000;
  const later = new Vault(storage, () => now);
  state = await later.unlock(password);
  assert.deepEqual(later.listDeleted(state.session), [], "Trash older than 30 days is removed on unlock");
});

test("inactivity enforced on access and failed writes preserve prior data", async () => {
  let now = 1000;
  const storage = memoryStorage();
  const vault = new Vault(storage, () => now);
  let state = await vault.create(password);
  assert.equal(state.settings.autoLockMinutes, 0, "New vaults default to Never");
  assert.equal(state.deadline, null);
  state = await vault.settings(state.session, { autoLockMinutes: 10 });
  const write = storage.write;
  storage.write = async () => { throw new Error("Storage failed"); };
  await assert.rejects(vault.saveItem(state.session, state.revision, login), /Storage failed/);
  assert.deepEqual(vault.list(state.session), []);
  storage.write = write;
  now += 600001;
  assert.throws(() => vault.list(state.session), /locked/);
  state = await vault.unlock(password);
  const pending = vault.saveItem(state.session, state.revision, login);
  vault.lock();
  await assert.rejects(pending, /locked/);
  assert.equal((await vault.status()).unlocked, false);
});

test("backup authentication and explicit replacement; import leaves vault locked", async () => {
  const original = new Vault(memoryStorage());
  let state = await original.create(password);
  await original.saveItem(state.session, state.revision, login);
  const backup = JSON.stringify(await original.export());
  const target = new Vault(memoryStorage());
  await target.create("another test passphrase");
  await assert.rejects(target.prepareImport(backup, "incorrect passphrase"), /Incorrect master/);
  await assert.rejects(target.prepareImport("not JSON", password), /invalid/);
  const preview = await target.prepareImport(backup, password);
  assert.equal(preview.count, 1); assert.equal(preview.replaces, true);
  await assert.rejects(target.commitImport(preview.token, false), /Confirm/);
  await target.commitImport(preview.token, true);
  assert.equal((await target.status()).unlocked, false);
  state = await target.unlock(password);
  assert.equal(target.list(state.session).length, 1);
});

test("auto-lock setting saves even after another window changed logins", async () => {
  const vault = new Vault(memoryStorage());
  const opened = await vault.create(password);
  await vault.saveItem(opened.session, opened.revision, login);
  // The settings page still holds the older revision; the choice must stick anyway.
  let state = await vault.settings(opened.session, { autoLockMinutes: 0 });
  assert.equal(state.settings.autoLockMinutes, 0);
  state = await vault.settings(opened.session, { autoLockMinutes: 30 });
  assert.equal(state.settings.autoLockMinutes, 30);
  assert.equal(vault.list(state.session).length, 1);
  await assert.rejects(vault.settings(opened.session, { autoLockMinutes: 7 }), /invalid/);
});

test("password history keeps the last five, is never caller-supplied, and restore removes its duplicate", async () => {
  const vault = new Vault(memoryStorage());
  let state = await vault.create(password);
  state = await vault.saveItem(state.session, state.revision, { ...login, history: [{ password: "injected", changedAt: new Date().toISOString() }] });
  const id = vault.list(state.session)[0].id;
  assert.deepEqual(vault.item(state.session, id).history, [], "History cannot be injected through save");
  for (let i = 1; i <= 7; i++) state = await vault.saveItem(state.session, state.revision, { ...vault.item(state.session, id), password: `password-${i}` });
  let item = vault.item(state.session, id);
  assert.deepEqual(item.history.map(entry => entry.password), ["password-6", "password-5", "password-4", "password-3", "password-2"]);
  // Editing other fields does not add history.
  state = await vault.saveItem(state.session, state.revision, { ...item, notes: "edited" });
  assert.equal(vault.item(state.session, id).history.length, 5);
  // Restore an older password: the current one moves into history and the restored one leaves it.
  state = await vault.saveItem(state.session, state.revision, { ...vault.item(state.session, id), password: "password-4" });
  item = vault.item(state.session, id);
  assert.equal(item.password, "password-4");
  assert.deepEqual(item.history.map(entry => entry.password), ["password-7", "password-6", "password-5", "password-3", "password-2"]);
  assert.equal(vault.list(state.session)[0].history, undefined, "Lists never include passwords or history");
  assert.equal(JSON.stringify(await vault.export()).includes("password-6"), false);
});

test("health flags reused and weak passwords without exposing them", async () => {
  const vault = new Vault(memoryStorage());
  let state = await vault.create(password);
  for (const [name, secret] of [["A", "Shared-Secret-2026!"], ["B", "Shared-Secret-2026!"], ["C", "admin123"], ["D", "k7#Qm2!vLp9@xR4z"]]) {
    state = await vault.saveItem(state.session, state.revision, { ...login, name, password: secret });
  }
  const health = vault.health(state.session);
  const byName = Object.fromEntries(vault.list(state.session).map(item => [item.name, health.flags[item.id]]));
  assert.deepEqual(byName, { A: { reused: 1, weak: false }, B: { reused: 1, weak: false }, C: { reused: 0, weak: true }, D: { reused: 0, weak: false } });
  assert.equal(JSON.stringify(health).includes("Shared"), false);
});

test("large vaults: 20,000 logins unlock, search, match, and save quickly", async () => {
  const storage = memoryStorage();
  const created = await new Vault(storage).create(password);
  // Build the vault in one encrypted write; 20,000 separate saves would only time the loop.
  const stored = await storage.read();
  const { key } = await decryptVault(stored, password);
  const items = Array.from({ length: 20000 }, (_, i) => createItem({ ...login, name: `Login ${i}`, urls: [`https://site-${i}.example.test`],
    username: `user-${i}@example.test`, password: `secret-${i}-Aa1!xyz` }, null));
  await storage.write(await encryptVault({ version: 1, revision: created.revision, settings: { autoLockMinutes: 0 }, items }, key, stored.kdf));
  const vault = new Vault(storage);
  let started = Date.now();
  let state = await vault.unlock(password);
  const unlockMs = Date.now() - started;
  started = Date.now();
  assert.equal(vault.list(state.session, "user-19999").length, 1);
  assert.equal(vault.list(state.session, "", "https://site-12345.example.test/login").length, 1);
  const searchMs = Date.now() - started;
  started = Date.now();
  state = await vault.saveItem(state.session, state.revision, { ...login, name: "One more" });
  const saveMs = Date.now() - started;
  assert.equal(vault.list(state.session).length, 20001);
  const megabytes = (JSON.stringify(await storage.read()).length / 1048576).toFixed(1);
  console.log(`# 20,001 logins (${megabytes} MB encrypted): unlock ${unlockMs} ms incl. PBKDF2, search + match ${searchMs} ms, save ${saveMs} ms`);
  assert.ok(searchMs < 1000 && saveMs < 3000);
  // The exported backup round-trips through the backup parser at this size.
  assert.equal((await vault.prepareImport(JSON.stringify(await vault.export()), password)).count, 20001);
});

test("project environments: derived from logins, configured overrides, path preservation", async () => {
  const storage = memoryStorage();
  const vault = new Vault(storage);
  let state = await vault.create(password);
  // The spec example: a localhost project folder maps to a production root without duplicating it.
  state = await vault.saveItem(state.session, state.revision, { ...login, name: "SRMS local", project: "SRMS", environment: "local",
    urls: ["http://localhost/srms-college/"], username: "local-user" });
  state = await vault.saveItem(state.session, state.revision, { ...login, name: "SRMS prod", project: "SRMS", environment: "production",
    urls: ["https://srms.example.com/"], username: "prod-user" });
  // Derived map comes from the logins alone — nothing configured yet.
  let envs = vault.environments(state.session);
  assert.equal(envs.merged.SRMS.local, "http://localhost/srms-college/");
  assert.equal(envs.merged.SRMS.production, "https://srms.example.com/");
  assert.deepEqual(envs.configured, {});
  // Path/query/hash preserved; the local base folder is not duplicated on production.
  let target = vault.environmentTarget(state.session, "SRMS", "production", "http://localhost/srms-college/registrar/student/123?tab=grades#top");
  assert.equal(target.url, "https://srms.example.com/registrar/student/123?tab=grades#top");
  assert.equal(vault.list(state.session).find(item => item.id === target.itemId).username, "prod-user");
  // And back: production deep page onto the local base keeps its folder.
  target = vault.environmentTarget(state.session, "SRMS", "local", "https://srms.example.com/registrar/student/123?tab=grades");
  assert.equal(target.url, "http://localhost/srms-college/registrar/student/123?tab=grades");
  // A page outside the project switches to the environment's base address.
  target = vault.environmentTarget(state.session, "SRMS", "production", "https://unrelated.example.com/x");
  assert.equal(target.url, "https://srms.example.com/");
  // Unknown environments resolve to nothing rather than guessing.
  assert.equal(vault.environmentTarget(state.session, "SRMS", "qa", "http://localhost/srms-college/").url, null);
  // A configured entry wins over a login-derived address; a port stays in the URL.
  state = await vault.setProjectEnvironments(state.session, state.revision, "SRMS", { staging: "https://st.example.com:8443/app/" });
  envs = vault.environments(state.session);
  assert.equal(envs.configured.SRMS.staging, "https://st.example.com:8443/app/");
  assert.equal(envs.merged.SRMS.staging, "https://st.example.com:8443/app/");
  target = vault.environmentTarget(state.session, "SRMS", "staging", "http://localhost/srms-college/registrar/x");
  assert.equal(target.url, "https://st.example.com:8443/app/registrar/x");
  // Clearing the map drops the configured layer; derived addresses still resolve.
  state = await vault.setProjectEnvironments(state.session, state.revision, "SRMS", {});
  assert.equal(vault.environments(state.session).merged.SRMS.staging, undefined);
  assert.equal(vault.environments(state.session).merged.SRMS.local, "http://localhost/srms-college/");
  await assert.rejects(vault.setProjectEnvironments(state.session, state.revision, "SRMS", { "bad env!": "https://x.example.com" }), /environment/);
  await assert.rejects(vault.setProjectEnvironments(state.session, state.revision, "SRMS", { staging: "not-a-url" }), /URLs/);
  await assert.rejects(vault.setProjectEnvironments(state.session, state.revision, "SRMS", { staging: "javascript:alert(1)" }), /URLs/);
});

test("project environments survive backups, merges, and payloads that predate them", async () => {
  // A 1.3-era payload has no projects key: it must still decrypt and validate.
  const legacy = { version: 1, revision: 0, items: [], settings: { autoLockMinutes: 0 } };
  const { envelope } = await createEncryptedVault(legacy, password);
  assert.deepEqual((await decryptVault(envelope, password)).payload.projects, {});
  // The map rides along in an exported backup and lands on merge — without overwriting local entries.
  const source = new Vault(memoryStorage());
  const s = await source.create("source passphrase!");
  await source.setProjectEnvironments(s.session, s.revision, "App", { staging: "https://st.example.com", production: "https://app.example.com" });
  const target = new Vault(memoryStorage());
  let t = await target.create(password);
  t = await target.setProjectEnvironments(t.session, t.revision, "App", { production: "https://local-def.example.com" });
  const merged = await target.mergeBackup(t.session, t.revision, JSON.stringify(await source.export()), "source passphrase!");
  const envs = target.environments(merged.state.session);
  assert.equal(envs.configured.App.staging, "https://st.example.com/");
  assert.equal(envs.configured.App.production, "https://local-def.example.com/", "local entries win merge conflicts");
  // And the merged vault itself round-trips through export → decrypt.
  const reexported = await target.export();
  assert.equal((await decryptVault(reexported, password)).payload.projects.App.environments.staging, "https://st.example.com/");
});
