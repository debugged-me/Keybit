import test from "node:test";
import assert from "node:assert/strict";
import { totpCode, parseTotp } from "../src/vault/totp.js";
import { parseCsv, parseImport, websiteFrom } from "../src/import/parsers.js";
import { generatePassphrase } from "../src/generator/password-generator.js";
import { WORDS } from "../src/generator/words.js";
import { Vault } from "../src/vault/vault.js";
import { sealRawKey, openRawKey } from "../src/crypto/biometric.js";

function memoryStorage() {
  let data = null;
  return { async read() { return structuredClone(data); }, async write(value) { data = structuredClone(value); } };
}
const password = "a unique test passphrase";

test("TOTP matches the RFC 6238 test vectors", async () => {
  // Secret "12345678901234567890" for SHA-1, the RFC's 8-digit vectors.
  const uri = "otpauth://totp/Example?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8";
  for (const [seconds, code] of [[59, "94287082"], [1111111109, "07081804"], [1234567890, "89005924"], [2000000000, "69279037"]]) {
    assert.equal((await totpCode(uri, seconds * 1000)).code, code);
  }
  const sha256 = "otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA&digits=8&algorithm=SHA256";
  assert.equal((await totpCode(sha256, 59000)).code, "46119246");
  const plain = await totpCode("jbsw y3dp ehpk 3pxp", 30000);
  assert.match(plain.code, /^\d{6}$/); assert.equal(plain.remaining, 30);
  for (const bad of ["", "not a secret!", "ABC", "otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP", "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=9"]) assert.throws(() => parseTotp(bad));
});

test("imports Chrome, Apple, Bitwarden, 1Password and LastPass exports", () => {
  assert.deepEqual(parseCsv('a,"b ""q"", c",d\r\n"line\nbreak",,\n'), [["a", 'b "q", c', "d"], ["line\nbreak", "", ""]]);
  const chrome = parseImport("﻿name,url,username,password,note\nGitHub,https://github.com/login,octo,s3cret,\nApp,android://abc@com.example/,u,p,\n");
  assert.equal(chrome.items.length, 2);
  assert.deepEqual(chrome.items[0], { type: "login", name: "GitHub", urls: ["https://github.com/login"], username: "octo", password: "s3cret", notes: "", totp: "", project: "", favorite: false });
  assert.equal(chrome.items[1].type, "note", "No browser website: kept as a secure note");
  assert.match(chrome.items[1].notes, /Password: p/);
  const apple = parseImport("Title,URL,Username,Password,Notes,OTPAuth\nShop,shop.example,me,pw,hello,otpauth://totp/x?secret=JBSWY3DPEHPK3PXP\n");
  assert.deepEqual([apple.items[0].urls[0], apple.items[0].totp, apple.items[0].notes], ["https://shop.example/", "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP", "hello"]);
  const lastpass = parseImport("url,username,password,totp,extra,name,grouping,fav\nhttps://a.example,u,p,,,A,Work,1\nhttp://sn,,,,secret note text,Wifi,Home,0\n");
  assert.deepEqual(lastpass.items.map(item => [item.type, item.project, item.favorite]), [["login", "Work", true], ["note", "Home", false]]);
  const onePassword = parseImport("Title,Website,Username,Password,One-time password,Notes,Type\nBank,https://bank.example,me,pw,,n,Login\n");
  assert.equal(onePassword.items[0].urls[0], "https://bank.example/");
  const bitwarden = parseImport(JSON.stringify({ encrypted: false, folders: [{ id: "f", name: "Dev" }], items: [
    { type: 1, name: "Site", folderId: "f", favorite: true, notes: null, login: { username: "u", password: "p", totp: null, uris: [{ uri: "https://a.example" }, { uri: "https://b.example" }] } },
    { type: 2, name: "Note", notes: "text" }, { type: 3, name: "Card" }] }), "export.json");
  assert.deepEqual(bitwarden.items.map(item => item.type), ["login", "note"]);
  assert.deepEqual(bitwarden.items[0].urls, ["https://a.example/", "https://b.example/"]);
  assert.equal(bitwarden.items[0].project, "Dev");
  assert.equal(bitwarden.skipped, 1);
  assert.throws(() => parseImport(JSON.stringify({ encrypted: true, items: [] })), /encrypted/);
  assert.throws(() => parseImport("a,b\n1,2\n"), /no password column/);
  assert.throws(() => parseImport(JSON.stringify({ formatVersion: 1, ciphertext: "x" })), /KeyBit backup/);
  assert.equal(websiteFrom("javascript:alert(1)"), null);
});

test("import skips duplicates and invalid rows in one encrypted write", async () => {
  const storage = memoryStorage();
  const vault = new Vault(storage);
  let state = await vault.create(password);
  state = await vault.saveItem(state.session, state.revision, { name: "Existing", urls: ["https://github.com"], username: "octo", password: "s3cret", notes: "", environment: "other" });
  const { items } = parseImport("name,url,username,password,note,totp\nGitHub,https://github.com/login,octo,s3cret,,\nNew,https://new.example,me,pw,,garbage-secret!\nNew,https://new.example,me,pw,,\n,,,,,\n");
  const before = state.revision;
  assert.deepEqual(vault.previewImport(state.session, items), { logins: 1, notes: 0, duplicates: 2, invalid: 0 });
  const result = await vault.importItems(state.session, state.revision, items);
  assert.equal(result.added, 1); assert.equal(result.duplicates, 2);
  assert.equal(result.state.revision, before + 1, "One write for the whole import");
  const added = vault.list(result.state.session, "new.example")[0];
  assert.equal(vault.item(result.state.session, added.id).totp, "", "A bad 2FA secret is dropped, the login kept");
});

test("CSV export quotes fields, splits extra websites into rows, skips trash, and re-imports cleanly", async () => {
  const storage = memoryStorage();
  const vault = new Vault(storage);
  let state = await vault.create(password);
  state = await vault.saveItem(state.session, state.revision, { name: 'Site, "quoted"', urls: ["https://a.example", "https://b.example"], username: "u", password: 'p,"w', notes: "line\nbreak", environment: "production", project: "Work", totp: "JBSWY3DPEHPK3PXP", favorite: true });
  state = await vault.saveItem(state.session, state.revision, { type: "note", name: "Keys", notes: "ssh-key", project: "Ops" });
  state = await vault.saveItem(state.session, state.revision, { name: "Gone", urls: ["https://gone.example"], username: "g", password: "gp", environment: "other" });
  state = await vault.deleteItem(state.session, state.revision, vault.list(state.session, "gone")[0].id);
  const csv = vault.exportCsv(state.session);
  assert.match(csv, /^name,url,username,password,notes,totp,folder,environment,favorite,type\r\n/);
  assert.ok(csv.includes('"Site, ""quoted"""') && csv.includes('"p,""w"') && csv.includes('"line\nbreak"'), "Fields with commas, quotes and newlines are quoted");
  const parsed = parseImport(csv, "keybit.csv");
  assert.equal(parsed.items.filter(item => item.name === "Gone").length, 0, "Recently deleted items are never exported");
  const urls = parsed.items.filter(item => item.name === 'Site, "quoted"').flatMap(item => item.urls);
  assert.deepEqual(urls.sort(), ["https://a.example/", "https://b.example/"], "Each website becomes its own row");
  const login = parsed.items.find(item => item.urls.includes("https://a.example/"));
  assert.deepEqual([login.password, login.notes, login.totp, login.project, login.favorite], ['p,"w', "line\nbreak", "JBSWY3DPEHPK3PXP", "Work", true]);
  const note = parsed.items.find(item => item.name === "Keys");
  assert.deepEqual([note.type, note.notes, note.project], ["note", "ssh-key", "Ops"], "Notes keep their type, text and folder");
});

test("secure notes, several addresses, projects, favorites and 2FA secrets", async () => {
  const vault = new Vault(memoryStorage());
  let state = await vault.create(password);
  state = await vault.saveItem(state.session, state.revision, { type: "note", name: "Server keys", notes: "ssh ...", project: "SRMS", favorite: true });
  state = await vault.saveItem(state.session, state.revision, { name: "SRMS", urls: ["http://localhost/srms-college/", "https://srms.example.com"], username: "admin", password: "pw-1",
    notes: "", environment: "production", project: "SRMS", totp: "JBSWY3DPEHPK3PXP" });
  const list = vault.list(state.session);
  assert.deepEqual(list.map(item => [item.type, item.project, item.favorite, item.hasTotp]), [["note", "SRMS", true, false], ["login", "SRMS", false, true]]);
  assert.equal(vault.list(state.session, "", "https://srms.example.com/login").length, 1, "Second address matches");
  assert.equal(vault.list(state.session, "", "http://localhost/srms-college/").length, 1);
  assert.deepEqual(vault.projects(state.session), ["SRMS"]);
  assert.deepEqual(Object.keys(vault.health(state.session)).length, 1, "Notes are not password-checked");
  await assert.rejects(vault.saveItem(state.session, state.revision, { name: "Bad", urls: ["https://x.example"], username: "", password: "p", environment: "other", totp: "nope" }), /invalid|2FA/);
  await assert.rejects(vault.saveItem(state.session, state.revision, { name: "Too many", urls: Array.from({ length: 11 }, (_, i) => `https://s${i}.example`), username: "", password: "p", environment: "other" }), /invalid/);
});

test("changing the master password re-encrypts with a new salt; old password stops working", async () => {
  const storage = memoryStorage();
  const vault = new Vault(storage);
  let state = await vault.create(password);
  state = await vault.saveItem(state.session, state.revision, { name: "A", urls: ["https://a.example"], username: "u", password: "pw", notes: "", environment: "other" });
  const salt = (await storage.read()).kdf.salt;
  await assert.rejects(vault.changePassword(state.session, "wrong password here", "another long passphrase"), /incorrect/);
  await assert.rejects(vault.changePassword(state.session, password, "short"), /12 characters/);
  state = await vault.changePassword(state.session, password, "another long passphrase");
  assert.equal(state.unlocked, true);
  assert.notEqual((await storage.read()).kdf.salt, salt);
  const reopened = new Vault(storage);
  await assert.rejects(reopened.unlock(password), /Incorrect/);
  state = await reopened.unlock("another long passphrase");
  assert.equal(reopened.list(state.session).length, 1);
});

test("merging a backup adds new items, takes newer copies, deletes nothing, and keeps replaced passwords", async () => {
  const source = new Vault(memoryStorage());
  let s = await source.create(password);
  s = await source.saveItem(s.session, s.revision, { name: "Shared", urls: ["https://shared.example"], username: "u", password: "old", notes: "", environment: "other" });
  const shared = source.list(s.session)[0];
  // Same logins on two devices: the device merges the backup, then each side changes.
  const targetStorage = memoryStorage();
  const device = new Vault(targetStorage);
  let d = await device.create("device passphrase 123");
  d = await device.mergeBackup(d.session, d.revision, JSON.stringify(await source.export()), password).then(result => result.state);
  d = await device.saveItem(d.session, d.revision, { name: "Device only", urls: ["https://device.example"], username: "d", password: "dp", notes: "", environment: "other" });
  await new Promise(resolve => setTimeout(resolve, 5));
  s = await source.saveItem(s.session, s.revision, { ...source.item(s.session, shared.id), password: "new" });
  await source.saveItem(s.session, s.revision, { type: "note", name: "Source note", notes: "n" });
  const result = await device.mergeBackup(d.session, d.revision, JSON.stringify(await source.export()), password);
  assert.deepEqual([result.added, result.updated, result.unchanged], [1, 1, 0]);
  const merged = device.item(result.state.session, shared.id);
  assert.equal(merged.password, "new");
  assert.ok(merged.history.some(entry => entry.password === "old"));
  assert.equal(device.list(result.state.session).length, 3, "Nothing deleted");
  const again = await device.mergeBackup(result.state.session, result.state.revision, JSON.stringify(await source.export()), password);
  assert.deepEqual([again.added, again.updated], [0, 0]);
  await assert.rejects(device.mergeBackup(again.state.session, again.state.revision, JSON.stringify(await source.export()), "wrong passphrase!!"), /Incorrect/);
});

test("Touch ID sealing: only the authenticator's key opens the vault key; a password change makes it stale", async () => {
  const storage = memoryStorage();
  const vault = new Vault(storage);
  let state = await vault.create(password);
  const raw = await vault.rawKeyFor(state.session, password);
  await assert.rejects(vault.rawKeyFor(state.session, "wrong password here"), /Incorrect/);
  const prf = crypto.getRandomValues(new Uint8Array(32));
  const sealed = await sealRawKey(raw, prf, "cred-1");
  raw.fill(0);
  await assert.rejects(openRawKey(sealed, crypto.getRandomValues(new Uint8Array(32)), "cred-1"), /Touch ID/);
  await assert.rejects(openRawKey(sealed, prf, "cred-2"), /Touch ID/);
  vault.lock();
  state = await vault.unlockWithRawKey(await openRawKey(sealed, prf, "cred-1"));
  assert.equal(state.unlocked, true);
  await vault.changePassword(state.session, password, "another long passphrase");
  vault.lock();
  await assert.rejects(vault.unlockWithRawKey(await openRawKey(sealed, prf, "cred-1")), /out of date/);
});

test("memorable passphrases use the EFF list without bias", () => {
  assert.equal(WORDS.length, 1295);
  const phrase = generatePassphrase({ words: 5 }, WORDS);
  const parts = phrase.split("-");
  assert.equal(parts.length, 5);
  assert.match(parts.at(-1), /^[A-Z][a-z]+\d$/);
  assert.ok(parts.slice(0, -1).every(part => WORDS.includes(part.toLowerCase())));
  assert.throws(() => generatePassphrase({ words: 2 }, WORDS));
});
