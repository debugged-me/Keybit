import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { emptyVault, createItem, validatePayload } from "../src/vault/schema.js";
import { createEncryptedVault, decryptVault } from "../src/crypto/crypto.js";
import { splitSecret, encodeShare, combineShares } from "../src/vault/shamir.js";
import { totpCode } from "../src/vault/totp.js";
import { matchesUrl, loginScope } from "../src/matching/url-matcher.js";

test("release versions stay synchronized", async () => {
  const [pkg, lock, chromeManifest, firefoxManifest, source] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../package-lock.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../manifest.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../manifest.firefox.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../src/version.js", import.meta.url), "utf8")
  ]);
  assert.equal(chromeManifest.version, pkg.version);
  assert.equal(firefoxManifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  assert.match(source, new RegExp(`VERSION = ["']${pkg.version.replaceAll(".", "\\.")}["']`));
});

test("new vaults use secure lock defaults", () => {
  const vault = emptyVault();
  assert.equal(vault.settings.stayUnlocked, false);
  assert.equal(vault.settings.lockOnScreenLock, true);
});

test("schema normalizes tags and validates developer secrets", () => {
  const item = createItem({ type: "secret", name: "Production API", secretKind: "api", notes: "", project: "KeyBit", favorite: false,
    tags: ["Production", "production", "Client"], customFields: [{ name: "Token", value: "kb_test", concealed: true }] });
  assert.deepEqual(item.tags, ["production", "client"]);
  assert.equal(item.customFields[0].concealed, true);
  const payload = validatePayload({ ...emptyVault(), items: [item] });
  assert.equal(payload.items[0].secretKind, "api");
});

test("encrypted vault round trip authenticates custom fields", async () => {
  const payload = emptyVault();
  payload.items.push(createItem({ type: "note", name: "Recovery", notes: "offline", project: "", favorite: false,
    tags: ["critical"], customFields: [{ name: "Code", value: "123-456", concealed: true }] }));
  const { envelope } = await createEncryptedVault(payload, "correct horse battery staple");
  const opened = await decryptVault(envelope, "correct horse battery staple");
  assert.equal(opened.payload.items[0].customFields[0].value, "123-456");
  await assert.rejects(() => decryptVault(envelope, "incorrect password"), /Incorrect master password/);
});

test("Shamir recovery rebuilds from the threshold", () => {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const split = splitSecret(secret, 3, 5);
  const shares = split.shares.map(share => encodeShare(split.kit, 3, share.index, share.bytes));
  assert.deepEqual(combineShares([shares[0], shares[2], shares[4]]), secret);
  assert.throws(() => combineShares(shares.slice(0, 2)), /needs 3 shares/);
});

test("TOTP follows the RFC 6238 SHA-1 vector", async () => {
  const result = await totpCode("otpauth://totp/Test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8", 59000);
  assert.equal(result.code, "94287082");
});

test("localhost projects stay isolated while normal origins match", () => {
  assert.equal(loginScope("http://localhost/shop/login"), "/shop/");
  assert.equal(matchesUrl("http://localhost/shop/", "http://localhost/shop/admin"), true);
  assert.equal(matchesUrl("http://localhost/shop/", "http://localhost/blog/admin"), false);
  assert.equal(matchesUrl("https://example.com/", "https://example.com/login"), true);
  assert.equal(matchesUrl("https://example.com/", "https://evil.example/login"), false);
});
