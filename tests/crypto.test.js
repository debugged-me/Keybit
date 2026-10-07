import test from "node:test";
import assert from "node:assert/strict";
import { createEncryptedVault, decryptVault, encryptVault, validateEnvelope } from "../src/crypto/crypto.js";
import { emptyVault } from "../src/vault/schema.js";
import { newKdf } from "../src/crypto/kdf.js";
import { fromBase64 } from "../src/crypto/encoding.js";

test("authenticated encryption round trip, wrong password, tampering, random IV and salt", async () => {
  const payload = emptyVault();
  const { key, envelope } = await createEncryptedVault(payload, "a unique test passphrase");
  assert.equal(key.extractable, false);
  assert.deepEqual((await decryptVault(envelope, "a unique test passphrase")).payload, payload);
  await assert.rejects(decryptVault(envelope, "wrong test passphrase"), /Incorrect master/);
  const bytes = Buffer.from(envelope.ciphertext, "base64"); bytes[0] ^= 1;
  await assert.rejects(decryptVault({ ...envelope, ciphertext: bytes.toString("base64") }, "a unique test passphrase"), /Incorrect master/);
  const altered = structuredClone(envelope); altered.kdf.iterations++;
  await assert.rejects(decryptVault(altered, "a unique test passphrase"), /Incorrect master/);
  assert.notEqual((await encryptVault(payload, key, envelope.kdf)).cipher.iv, envelope.cipher.iv);
  assert.notEqual(newKdf().salt, newKdf().salt);
  assert.throws(() => validateEnvelope({ ...envelope, kdf: { ...envelope.kdf, iterations: 999999999 } }), /invalid/);
  assert.throws(() => validateEnvelope({ ...envelope, cipher: { name: "AES-GCM", iv: "AA==" } }), /invalid/);
  await assert.rejects(createEncryptedVault(payload, "too short"), /12 characters/);
  assert.deepEqual([...fromBase64("QUJD")], [65, 66, 67]);
  for (const bad of ["QUJD\n", "QU JD", "QUJ", "QUJ=", "Q===", "@@@@", "", 42]) assert.throws(() => fromBase64(bad), /invalid/, String(bad));
  assert.throws(() => fromBase64("QUJDRA==", 3), /invalid/);
});
