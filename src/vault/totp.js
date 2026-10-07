// RFC 6238 time-based one-time passwords (the 6-digit 2FA codes) from an otpauth:// link or a base32 secret.
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const invalid = () => { throw new Error("Enter the 2FA setup key or otpauth:// link that the website showed you."); };
function base32(text) {
  const clean = String(text).toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  if (!clean || /[^A-Z2-7]/.test(clean)) invalid();
  const bytes = [];
  let bits = 0, value = 0;
  for (const character of clean) {
    value = ((value << 5) | BASE32.indexOf(character)) & 0xffff; bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  if (bytes.length < 10) invalid();
  return new Uint8Array(bytes);
}
export function parseTotp(value) {
  const text = String(value ?? "").trim();
  if (!/^otpauth:/i.test(text)) return { secret: base32(text), algorithm: "SHA1", digits: 6, period: 30 };
  let url;
  try { url = new URL(text); } catch { invalid(); }
  if (url.hostname.toLowerCase() !== "totp") throw new Error("Only time-based 2FA codes (TOTP) are supported.");
  const algorithm = (url.searchParams.get("algorithm") ?? "SHA1").toUpperCase();
  const digits = Number(url.searchParams.get("digits") ?? 6);
  const period = Number(url.searchParams.get("period") ?? 30);
  if (!["SHA1", "SHA256", "SHA512"].includes(algorithm) || ![6, 7, 8].includes(digits) || !Number.isInteger(period) || period < 10 || period > 300) invalid();
  return { secret: base32(url.searchParams.get("secret") ?? ""), algorithm, digits, period };
}
export async function totpCode(value, now = Date.now()) {
  const { secret, algorithm, digits, period } = parseTotp(value);
  const counter = Math.floor(now / 1000 / period);
  const message = new DataView(new ArrayBuffer(8));
  message.setUint32(0, Math.floor(counter / 2 ** 32)); message.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: `SHA-${algorithm.slice(3)}` }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message.buffer));
  const offset = mac[mac.length - 1] & 15;
  const binary = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return { code: String(binary % 10 ** digits).padStart(digits, "0"), period, remaining: period - (Math.floor(now / 1000) % period) };
}
