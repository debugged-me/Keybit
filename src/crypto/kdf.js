import { fromBase64, toBase64 } from "./encoding.js";

export const ITERATIONS = 600000;
export function newKdf() {
  return { name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS, salt: toBase64(crypto.getRandomValues(new Uint8Array(16))) };
}

export async function deriveKey(password, kdf) {
  if (typeof password !== "string" || password.length === 0 || password.length > 1024) throw new Error("Enter a master password of up to 1,024 characters.");
  const bytes = new TextEncoder().encode(password);
  try {
    const material = await crypto.subtle.importKey("raw", bytes, "PBKDF2", false, ["deriveKey"]);
    return await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", iterations: kdf.iterations, salt: fromBase64(kdf.salt, 16) }, material,
      { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  } finally { bytes.fill(0); }
}
