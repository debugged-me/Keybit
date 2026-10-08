import test from "node:test";
import assert from "node:assert/strict";
import { Vault } from "../src/vault/vault.js";
import { decryptVault } from "../src/crypto/crypto.js";
import { splitSecret, combineShares, encodeShare, decodeShare, recoveryPassphrase } from "../src/vault/shamir.js";

const password = "a unique test passphrase";
const login = { name: "Private test name", urls: ["https://secret.example.com"], username: "private-user", password: "private-password", notes: "", environment: "production" };
function memoryStorage() {
  let data = null;
  return { async read() { return structuredClone(data); }, async write(value) { data = structuredClone(value); } };
}
function encodeAll({ kit, threshold, shares }) {
  return shares.map(share => encodeShare(kit, threshold, share.index, share.bytes));
}

test("any threshold of shares rebuilds the secret; subsets and orderings agree", () => {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const kit = splitSecret(secret, 3, 5);
  assert.equal(kit.shares.length, 5);
  const texts = encodeAll(kit);
  const subset = [texts[0], texts[2], texts[4]].join("\n"); // 1st, 3rd, 5th
  assert.deepEqual(combineShares(subset), secret);
  assert.deepEqual(combineShares([texts[4], texts[1], texts[0], texts[3]]), secret, "order and extra shares don't matter");
  assert.deepEqual(combineShares(texts.join(",")), secret, "comma-separated pastes work");
  // A different random split of the same secret produces different share bytes.
  assert.notDeepEqual(encodeAll(splitSecret(secret, 3, 5)), texts);
});

test("shares leak nothing alone and every check on them fails loudly", () => {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const kit = splitSecret(secret, 3, 4);
  const texts = encodeAll(kit);
  // Below threshold nothing about the secret is recoverable: a lone share's bytes differ.
  assert.notDeepEqual(decodeShare(texts[0]).bytes, secret);
  assert.throws(() => combineShares([texts[0], texts[1]]), /needs 3 shares/);
  assert.throws(() => combineShares([texts[0], texts[0], texts[1]]), /pasted twice/);
  assert.throws(() => combineShares("kb1-" + texts[0].slice(4, -4) + "xx"), /invalid|corrupted|damaged|truncated/);
  assert.throws(() => combineShares("not-a-share\nnope"), /doesn't look like/);
  assert.throws(() => combineShares(""), /Paste your recovery shares/);
  // Shares from a second kit can't mix with this kit's.
  const other = encodeAll(splitSecret(secret, 3, 4));
  assert.throws(() => combineShares([texts[0], texts[1], other[0]]), /different recovery kits/);
  // Index 0 is never a real share — the polynomial's constant term lives there.
  assert.throws(() => combineShares([encodeShare(kit.kit, kit.threshold, 0, secret), texts[1], texts[2]]), /damaged/);
  // A forged share from the same kit id can't exist without the kit, but a corrupted
  // share that still decodes just yields the wrong secret — which the AES-GCM tag rejects.
  const damaged = decodeShare(texts[0]);
  damaged.bytes[0] ^= 1;
  const wrong = combineShares([encodeShare(kit.kit, kit.threshold, damaged.index, damaged.bytes), texts[1], texts[2]]);
  assert.notDeepEqual(wrong, secret);
});

test("recovery kit bundles the whole vault and opens with shares, never with the master password", async () => {
  const storage = memoryStorage();
  const vault = new Vault(storage);
  let state = await vault.create(password);
  state = await vault.saveItem(state.session, state.revision, { ...login, history: [{ password: "older-secret", changedAt: new Date().toISOString() }] });
  state = await vault.saveItem(state.session, state.revision, { type: "note", name: "seed note", urls: [], username: "", password: "", notes: "leave no trace", project: "ops" });
  const kit = await vault.recoveryKit(state.session, 2, 3);
  assert.equal(kit.shares.length, 3);
  assert.equal(kit.threshold, 2);
  // The bundle is a standard encrypted vault: it opens with the rebuilt passphrase.
  const rebuilt = recoveryPassphrase(combineShares([kit.shares[2], kit.shares[0]]));
  const { payload } = await decryptVault(kit.bundle, rebuilt);
  assert.equal(payload.items.length, 2);
  assert.equal(payload.items.find(item => item.name === login.name).password, login.password);
  assert.equal(payload.items.find(item => item.name === "seed note").notes, "leave no trace");
  assert.equal(typeof payload.settings.autoLockMinutes, "number", "settings travel with the bundle");
  // The bundle never answers to the master password, and no share is a passphrase.
  await assert.rejects(decryptVault(kit.bundle, password));
  await assert.rejects(decryptVault(kit.bundle, kit.shares.join(" ")));
  // JSON round-trip: the downloaded file text must parse back identically.
  const { payload: fromFile } = await decryptVault(JSON.parse(JSON.stringify(kit.bundle)), recoveryPassphrase(combineShares(kit.shares.slice(0, 2))));
  assert.equal(fromFile.items.length, 2);
  await assert.rejects(vault.recoveryKit(null, 2, 3), /locked/);
  await assert.rejects(vault.recoveryKit(state.session, 1, 3), /at least 2/);
});

test("the recover-dialog chain: shares → import → unlock → new master password", async () => {
  const storage = memoryStorage();
  const vault = new Vault(storage);
  let state = await vault.create(password);
  state = await vault.saveItem(state.session, state.revision, { ...login });
  const kit = await vault.recoveryKit(state.session, 2, 3);
  const text = JSON.stringify(kit.bundle);
  await vault.lock();
  // Exactly what src/vault-ui/vault.js's #recover-form submit does, in order.
  const passphrase = recoveryPassphrase(combineShares(kit.shares.slice(0, 2)));
  const preview = await vault.prepareImport(text, passphrase);
  assert.equal(preview.count, 1);
  await vault.commitImport(preview.token, true);
  state = await vault.unlock(passphrase);
  await vault.changePassword(state.session, passphrase, "a brand new master password");
  await vault.lock();
  await assert.rejects(vault.unlock(password), /Incorrect/, "the old master password is gone");
  state = await vault.unlock("a brand new master password");
  assert.equal(vault.list(state.session).length, 1);
  assert.equal(vault.item(state.session, vault.list(state.session)[0].id).password, login.password);
});
