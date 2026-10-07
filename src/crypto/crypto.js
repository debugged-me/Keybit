import { fromBase64, toBase64, MAX_BACKUP_BYTES } from "./encoding.js";
import { deriveKey, newKdf, ITERATIONS } from "./kdf.js";
import { validatePayload } from "../vault/schema.js";

const invalid = () => { throw new Error("The selected backup is invalid or corrupted."); };
export function validateEnvelope(value) {
  if (!value || value.formatVersion !== 1 || value.kdf?.name !== "PBKDF2" || value.kdf.hash !== "SHA-256" ||
      !Number.isInteger(value.kdf.iterations) || value.kdf.iterations < ITERATIONS || value.kdf.iterations > 2000000 ||
      value.cipher?.name !== "AES-GCM") invalid();
  if (fromBase64(value.kdf.salt, 16).length !== 16 || fromBase64(value.cipher.iv, 12).length !== 12 || fromBase64(value.ciphertext, 4 * 1024 * 1024 + 16).length < 16) invalid();
  // Reconstruct a canonical, bounded header. The header is authenticated as AAD.
  return { formatVersion: 1, kdf: { name: "PBKDF2", hash: "SHA-256", iterations: value.kdf.iterations, salt: value.kdf.salt },
    cipher: { name: "AES-GCM", iv: value.cipher.iv }, ciphertext: value.ciphertext };
}

export function parseBackup(text) {
  if (typeof text !== "string" || text.length > MAX_BACKUP_BYTES) invalid();
  try { return validateEnvelope(JSON.parse(text)); } catch { invalid(); }
}

const aad = envelope => new TextEncoder().encode(JSON.stringify({ formatVersion: envelope.formatVersion, kdf: envelope.kdf, cipher: envelope.cipher }));

export async function encryptVault(payload, key, kdf) {
  const bytes = new TextEncoder().encode(JSON.stringify(validatePayload(payload)));
  try {
    if (bytes.length > 4 * 1024 * 1024) throw new Error("The vault is full. Remove unused entries before saving.");
    const envelope = { formatVersion: 1, kdf: { ...kdf }, cipher: { name: "AES-GCM", iv: toBase64(crypto.getRandomValues(new Uint8Array(12))) } };
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: fromBase64(envelope.cipher.iv, 12), additionalData: aad(envelope), tagLength: 128 }, key, bytes);
    return { ...envelope, ciphertext: toBase64(new Uint8Array(encrypted)) };
  } finally { bytes.fill(0); }
}

export async function createEncryptedVault(payload, password) {
  if (typeof password !== "string" || [...password].length < 12) throw new Error("Use a master password of at least 12 characters.");
  const kdf = newKdf();
  const key = await deriveKey(password, kdf);
  return { key, envelope: await encryptVault(payload, key, kdf) };
}

export async function decryptVault(value, password) {
  const envelope = validateEnvelope(value);
  const key = await deriveKey(password, envelope.kdf);
  let bytes;
  try {
    bytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(envelope.cipher.iv, 12), additionalData: aad(envelope), tagLength: 128 }, key, fromBase64(envelope.ciphertext)));
    const payload = validatePayload(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    return { key, payload, envelope };
  } catch { throw new Error("Incorrect master password or corrupted vault."); }
  finally { bytes?.fill(0); }
}
