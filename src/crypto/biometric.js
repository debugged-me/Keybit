import { toBase64, fromBase64 } from "./encoding.js";

// Touch ID unlock: the vault key is sealed with a key that only the device authenticator can reproduce
// (the WebAuthn PRF output, released after Touch ID). The master password itself is never stored.
const aad = credentialId => new TextEncoder().encode(`keybit-biometric-v1:${credentialId}`);
async function prfKey(prf) {
  if (!(prf instanceof Uint8Array) || prf.length !== 32) throw new Error("Touch ID did not return a usable key. Unlock with your master password.");
  return crypto.subtle.importKey("raw", /** @type {BufferSource} */ (prf), { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function sealRawKey(raw, prf, credentialId) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(credentialId), tagLength: 128 }, await prfKey(prf), raw);
  return { iv: toBase64(iv), data: toBase64(new Uint8Array(data)) };
}
export async function openRawKey(sealed, prf, credentialId) {
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(sealed.iv, 12), additionalData: aad(credentialId), tagLength: 128 },
      await prfKey(prf), fromBase64(sealed.data, 64)));
  } catch { throw new Error("Touch ID unlock failed. Unlock with your master password."); }
}
