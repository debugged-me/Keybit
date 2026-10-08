// Shamir's secret sharing over GF(256): a random secret splits into `count` shares, any
// `threshold` of which rebuild it exactly — fewer reveal nothing at all. Shares are split
// byte-wise with random polynomial coefficients and carry the kit id and threshold in the
// encoded string, so shares from different kits or a partial set fail with a clear message
// instead of silently producing the wrong secret.
// Pure math + WebCrypto randomness, so the whole module runs in Node tests.
import { base64url, unbase64url } from "./passkey.js";

// AES's field, GF(2^8) mod x⁸+x⁴+x³+x+1, with 3 as the generator for log/exp tables.
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x; LOG[x] = i;
    const doubled = x << 1;
    x = ((doubled & 0x100 ? doubled ^ 0x11b : doubled) ^ x) & 0xff; // ×3
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const div = (a, b) => (b ? (a ? EXP[LOG[a] + 255 - LOG[b]] : 0) : 0);

// The secret is the constant term; the other coefficients are random. Share i is the
// polynomial evaluated at x = i.
export function splitSecret(secret, threshold, count) {
  if (!(secret instanceof Uint8Array) || !secret.length || secret.length > 64) throw new Error("Recovery data is invalid.");
  if (!Number.isInteger(threshold) || threshold < 2 || threshold > 255 ||
      !Number.isInteger(count) || count < threshold || count > 255) {
    throw new Error("Choose a threshold of at least 2 shares out of up to 255.");
  }
  const kit = crypto.getRandomValues(new Uint8Array(4));
  const coefficients = crypto.getRandomValues(new Uint8Array((threshold - 1) * secret.length));
  const shares = [];
  for (let index = 1; index <= count; index++) {
    const bytes = new Uint8Array(secret.length);
    for (let i = 0; i < secret.length; i++) {
      let y = secret[i], power = 1;
      for (let c = 0; c < threshold - 1; c++) { power = mul(power, index); y ^= mul(coefficients[c * secret.length + i], power); }
      bytes[i] = y;
    }
    shares.push({ index, bytes });
  }
  return { kit, threshold, shares };
}

// Lagrange interpolation at x = 0 of one byte position across the given points.
function interpolate(points) {
  let value = 0;
  for (const [j, pj] of points.entries()) {
    let numerator = 1, denominator = 1;
    for (const [k, pk] of points.entries()) {
      if (k === j) continue;
      numerator = mul(numerator, pk.x);            // 0 − xₖ = xₖ in GF(2⁸)
      denominator = mul(denominator, pj.x ^ pk.x);
    }
    value ^= mul(pj.y, div(numerator, denominator));
  }
  return value;
}

const PREFIX = "kb1-";
// Share text: "kb1-" + base64url(version, threshold, kit(4), index, share bytes).
export function encodeShare(kit, threshold, index, bytes) {
  return PREFIX + base64url(new Uint8Array([1, threshold, ...kit, index, ...bytes]));
}
export function decodeShare(text) {
  const clean = String(text ?? "").trim();
  if (!clean.startsWith(PREFIX)) throw new Error("That doesn't look like a KeyBit share — shares start with “kb1-”.");
  const bytes = unbase64url(clean.slice(PREFIX.length), 128);
  if (bytes.length < 8 || bytes[0] !== 1) throw new Error("That share is damaged or from a different KeyBit version.");
  const [, threshold, ...rest] = bytes;
  // Index 0 is never issued: evaluating the polynomial at x = 0 yields the secret itself,
  // so a forged "share 0" would be the secret in share's clothing.
  if (!rest[4]) throw new Error("That share is damaged — its index is invalid.");
  return { kit: rest.slice(0, 4).join("-"), threshold, index: rest[4], bytes: rest.slice(5) };
}

// Rebuilds the secret from share texts (one per line or comma-separated). Returns the bytes
// the recovery passphrase is derived from; wrong or mixed shares only fail later, at the
// bundle's AES-GCM tag — the passphrase simply won't open it.
export function combineShares(texts) {
  const shares = (Array.isArray(texts) ? texts : String(texts ?? "").split(/[\n,]/))
    .map(text => String(text).trim()).filter(Boolean).map(decodeShare);
  if (!shares.length) throw new Error("Paste your recovery shares first.");
  const { kit, threshold } = shares[0];
  if (shares.some(share => share.kit !== kit)) throw new Error("These shares come from different recovery kits.");
  if (shares.length < threshold) throw new Error(`This kit needs ${threshold} shares — you pasted ${shares.length}.`);
  if (new Set(shares.map(share => share.index)).size !== shares.length) throw new Error("A share was pasted twice — each share must be different.");
  const length = shares[0].bytes.length;
  if (shares.some(share => share.bytes.length !== length)) throw new Error("One share is truncated. Copy it again.");
  const secret = new Uint8Array(length);
  for (let i = 0; i < length; i++) secret[i] = interpolate(shares.map(share => ({ x: share.index, y: share.bytes[i] })));
  return secret;
}

// The bundle's passphrase is the secret itself, base64url — it never needs to be seen by a human.
export function recoveryPassphrase(secret) { return base64url(secret); }
