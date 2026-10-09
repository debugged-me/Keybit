import test from "node:test";
import assert from "node:assert/strict";
import { Vault } from "../src/vault/vault.js";
import { decryptVault } from "../src/crypto/crypto.js";
import { fromBase64 } from "../src/crypto/encoding.js";
import { newPasskeyMaterial, attestationObject, clientDataJSON, signAssertion, base64url } from "../src/vault/passkey.js";

const password = "a unique test passphrase";
const login = { name: "Private test name", urls: ["https://secret.example.com"], username: "private-user", password: "private-password", notes: "", environment: "production" };
function memoryStorage() {
  let data = null;
  return { async read() { return structuredClone(data); }, async write(value) { data = structuredClone(value); } };
}

// A minimal CBOR reader, just enough to verify the structures KeyBit encodes.
function readCbor(bytes, pos = 0) {
  const head = bytes[pos]; const major = head >> 5; let info = head & 31; pos++;
  if (info === 24) info = bytes[pos++];
  else if (info === 25) { info = (bytes[pos] << 8) | bytes[pos + 1]; pos += 2; }
  else if (info === 26) { info = bytes.readUInt32BE(pos); pos += 4; }
  if (major === 0) return [info, pos];
  if (major === 1) return [-1 - info, pos];
  if (major === 2) return [bytes.subarray(pos, pos + info), pos + info];
  if (major === 3) return [new TextDecoder().decode(bytes.subarray(pos, pos + info)), pos + info];
  if (major === 4) {
    const list = [];
    for (let i = 0; i < info; i++) { const [value, next] = readCbor(bytes, pos); list.push(value); pos = next; }
    return [list, pos];
  }
  if (major === 5) {
    const map = new Map();
    for (let i = 0; i < info; i++) { const [key, at] = readCbor(bytes, pos); const [value, next] = readCbor(bytes, at); map.set(key, value); pos = next; }
    return [map, pos];
  }
  throw new Error("Unsupported CBOR.");
}
const parseCbor = bytes => readCbor(bytes)[0];
// WebCrypto verifies ECDSA as raw r||s; WebAuthn signs DER. Convert for the test.
function derToRaw(der) {
  assert.equal(der[0], 0x30, "signature is a DER sequence");
  const rLength = der[3];
  const r = der.subarray(4, 4 + rLength), s = der.subarray(6 + rLength, 6 + rLength + der[5 + rLength]);
  const raw = new Uint8Array(64);
  raw.set(r.subarray(Math.max(0, r.length - 32)), 32 - Math.min(32, r.length));
  raw.set(s.subarray(Math.max(0, s.length - 32)), 64 - Math.min(32, s.length));
  return raw;
}

test("passkey attestation is a well-formed WebAuthn 'none' object", async () => {
  const material = await newPasskeyMaterial();
  assert.equal(material.credentialId.length, 32);
  const clientData = clientDataJSON("webauthn.create", "Y2hhbGxlbmdlLTAwMQ", "https://fixture.test");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(clientData)),
    { type: "webauthn.create", challenge: "Y2hhbGxlbmdlLTAwMQ", origin: "https://fixture.test", crossOrigin: false });
  const { attestation, authData } = await attestationObject("fixture.test", material.credentialId, material.coseKey);
  const map = parseCbor(attestation);
  assert.equal(map.get("fmt"), "none");
  const stored = map.get("authData");
  assert.deepEqual(stored, authData);
  const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("fixture.test")));
  assert.deepEqual(authData.subarray(0, 32), rpHash, "authenticator data starts with the rpId hash");
  assert.equal(authData[32], 0x45, "flags are user-present + user-verified + attested credential");
  assert.deepEqual(authData.subarray(33, 37), new Uint8Array(4), "signCount starts at zero");
  assert.deepEqual(authData.subarray(37, 53), new Uint8Array(16), "AAGUID is zeroed for a software authenticator");
  const credentialLength = (authData[53] << 8) | authData[54];
  assert.equal(credentialLength, 32);
  assert.deepEqual(authData.subarray(55, 87), material.credentialId);
  const cose = parseCbor(authData.subarray(87));
  assert.equal(cose.get(1), 2, "COSE key type EC2");
  assert.equal(cose.get(3), -7, "COSE algorithm ES256");
  assert.equal(cose.get(-1), 1, "COSE curve P-256");
  assert.equal(cose.get(-2).length, 32);
  assert.equal(cose.get(-3).length, 32);
});

test("assertion signatures verify against the passkey's public key", async () => {
  const material = await newPasskeyMaterial();
  const clientData = clientDataJSON("webauthn.get", "c2lnbi1jaGFsbGVuZ2U", "https://fixture.test");
  const { authData, signature } = await signAssertion(material.privateKey, "fixture.test", clientData, 7);
  assert.equal(authData[32], 0x05, "assertion flags are user-present + user-verified");
  assert.deepEqual([...authData.subarray(33, 37)], [0, 0, 0, 7], "signature counter is encoded big-endian");
  const publicKey = await crypto.subtle.importKey("spki", fromBase64(material.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const signed = new Uint8Array([...authData, ...new Uint8Array(await crypto.subtle.digest("SHA-256", clientData))]);
  assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, derToRaw(signature), signed));
});

test("passkeys store, match relying parties, count sign-ins, and never reach a CSV", async () => {
  const storage = memoryStorage();
  const vault = new Vault(storage);
  let state = await vault.create(password);
  const material = await newPasskeyMaterial();
  const credentialId = base64url(material.credentialId);
  state = await vault.saveItem(state.session, state.revision, { type: "passkey", name: "alice@fixture.test",
    urls: [], username: "", password: "", notes: "", rpId: "fixture.test", credentialId,
    userName: "alice@fixture.test", userHandle: "dXNlcjE", privateKey: material.privateKey, signCount: 0 });
  const row = vault.list(state.session).find(item => item.type === "passkey");
  assert.equal(row.rpId, "fixture.test");
  assert.equal(vault.list(state.session, "fixture.test").length, 1, "search matches the relying-party id");
  assert.equal(vault.passkeyCandidates(state.session, "fixture.test", null).length, 1);
  assert.equal(vault.passkeyCandidates(state.session, "other.test", null).length, 0, "passkeys never leak across sites");
  assert.equal(vault.passkeyCandidates(state.session, "fixture.test", ["bm90LWl0"]).length, 0);
  assert.equal(vault.passkeyCandidates(state.session, "fixture.test", [credentialId]).length, 1);
  state = await vault.touchPasskey(state.session, row.id, 1);
  assert.equal(vault.item(state.session, row.id).signCount, 1);
  assert.equal(vault.item(state.session, row.id).lastUsedAt.length > 0, true);
  assert.equal(vault.exportCsv(state.session).includes("fixture.test"), false, "CSV export never carries private keys");
  state = await vault.deleteItem(state.session, state.revision, row.id);
  assert.equal(vault.passkeyCandidates(state.session, "fixture.test", null).length, 0, "a trashed passkey is not offered");
  state = await vault.restoreItem(state.session, state.revision, row.id);
  assert.equal(vault.passkeyCandidates(state.session, "fixture.test", null).length, 1);
});

test("share files are single-item encrypted vaults the recipient merges with the passphrase", async () => {
  const storage = memoryStorage();
  const vault = new Vault(storage);
  let state = await vault.create(password);
  state = await vault.saveItem(state.session, state.revision, { ...login, history: [{ password: "older-secret", changedAt: new Date().toISOString() }] });
  const id = vault.list(state.session)[0].id;
  const envelope = await vault.shareItem(state.session, id, "a share passphrase");
  const { payload } = await decryptVault(envelope, "a share passphrase");
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].password, login.password, "the shared item keeps its login");
  assert.notEqual(payload.items[0].id, id, "the shared copy gets a fresh id");
  assert.deepEqual(payload.items[0].history, [], "old passwords are not shared");
  await assert.rejects(decryptVault(envelope, "the wrong passphrase"));
  await assert.rejects(vault.shareItem(state.session, id, "short"), /at least 8 characters/);
  const material = await newPasskeyMaterial();
  state = await vault.saveItem(state.session, state.revision, { type: "passkey", name: "a@b.test",
    urls: [], username: "", password: "", notes: "", rpId: "b.test", credentialId: base64url(material.credentialId),
    userName: "a@b.test", userHandle: "dQ", privateKey: material.privateKey, signCount: 0 });
  const passkeyId = vault.list(state.session).find(item => item.type === "passkey").id;
  await assert.rejects(vault.shareItem(state.session, passkeyId, "a share passphrase"), /can't be shared/);
});
