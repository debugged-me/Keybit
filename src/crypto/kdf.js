import { fromBase64, toBase64 } from "./encoding.js";

export const ITERATIONS = 600000;
export function newKdf() {
  return { name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS, salt: toBase64(crypto.getRandomValues(new Uint8Array(16))) };
}

// The raw 256-bit key bytes, only for wrapping with Touch ID. Callers must zero them after use.
export async function deriveRawKey(password, kdf) {
  if (typeof password !== "string" || password.length === 0 || password.length > 1024) throw new Error("Enter a master password of up to 1,024 characters.");
  const bytes = new TextEncoder().encode(password);
  try {
    const material = await crypto.subtle.importKey("raw", bytes, "PBKDF2", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", iterations: kdf.iterations, salt: fromBase64(kdf.salt, 16) }, material, 256));
  } finally { bytes.fill(0); }
}
export async function importRawKey(raw) {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function deriveKey(password, kdf) {
  const raw = await deriveRawKey(password, kdf);
  try { return await importRawKey(raw); } finally { raw.fill(0); }
}
