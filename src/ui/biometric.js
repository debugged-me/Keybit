import { toBase64, fromBase64 } from "../crypto/encoding.js";

// Touch ID / Windows Hello through a passkey that belongs to this extension. Its PRF output (released only after
// the fingerprint or face check) seals KeyBit's vault key; the master password is never stored.
export const biometricName = () => /Mac|iPhone|iPad/.test(navigator.platform) ? "Touch ID" : /Win/.test(navigator.platform) ? "Windows Hello" : "device unlock";
export async function biometricAvailable() {
  try { return !!window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch { return false; }
}
const friendly = error => error?.name === "NotAllowedError" ? new Error(`${biometricName()} was cancelled or timed out.`) : error;
async function evaluate(credentialId, salt) {
  let assertion;
  try {
    assertion = await navigator.credentials.get({ publicKey: { rpId: location.hostname, challenge: crypto.getRandomValues(new Uint8Array(32)), userVerification: "required", timeout: 60000,
      allowCredentials: [{ type: "public-key", id: fromBase64(credentialId, 1024) }], extensions: { prf: { eval: { first: fromBase64(salt, 32) } } } } });
  } catch (error) { throw friendly(error); }
  const first = /** @type {any} */ (assertion).getClientExtensionResults().prf?.results?.first;
  if (!first) throw new Error(`${biometricName()} on this device can't unlock KeyBit. Use your master password.`);
  return toBase64(new Uint8Array(first));
}
export async function createBiometric() {
  const salt = toBase64(crypto.getRandomValues(new Uint8Array(32)));
  let credential;
  try {
    credential = await navigator.credentials.create({ publicKey: {
      rp: { name: "KeyBit", id: location.hostname }, user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "KeyBit vault", displayName: "KeyBit vault" },
      challenge: crypto.getRandomValues(new Uint8Array(32)), pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "discouraged", userVerification: "required" }, timeout: 60000, extensions: { prf: {} } } });
  } catch (error) { throw friendly(error); }
  const passkey = /** @type {any} */ (credential);
  if (passkey.getClientExtensionResults().prf?.enabled === false) throw new Error(`${biometricName()} on this device can't protect KeyBit's key. Keep using your master password.`);
  const credentialId = toBase64(new Uint8Array(passkey.rawId));
  return { credentialId, salt, prf: await evaluate(credentialId, salt) };
}
export async function unlockWithBiometric(client) {
  const info = await client.request("BIOMETRIC_INFO");
  if (!info) throw new Error(`${biometricName()} unlock is off.`);
  return client.request("BIOMETRIC_UNLOCK", { prf: await evaluate(info.credentialId, info.salt) });
}
