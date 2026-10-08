// WebAuthn/passkey primitives for KeyBit's built-in passkey store.
// Pure WebCrypto + hand-rolled CBOR/DER so the whole module runs in Node tests.
import { toBase64, fromBase64 } from "../crypto/encoding.js";

const text = new TextEncoder();

export function base64url(bytes) {
  return toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function unbase64url(value, maxBytes = 4096) {
  if (typeof value !== "string" || !value.length || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > maxBytes * 2) {
    throw new Error("Invalid passkey data.");
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  return fromBase64(padded + "=".repeat((4 - (padded.length % 4)) % 4), maxBytes);
}

function concat(...arrays) {
  const out = new Uint8Array(arrays.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of arrays) { out.set(part, offset); offset += part.length; }
  return out;
}

const sha256 = async data => new Uint8Array(await crypto.subtle.digest("SHA-256", data));

// --- Minimal CBOR encoder: enough for WebAuthn attestation objects and COSE keys.
function cborHead(major, length) {
  const tag = major << 5;
  if (length < 24) return [tag | length];
  if (length < 256) return [tag | 24, length];
  return [tag | 25, length >> 8, length & 0xff];
}
export function cbor(value) {
  if (value instanceof Uint8Array) return new Uint8Array([...cborHead(2, value.length), ...value]);
  if (typeof value === "string") { const bytes = text.encode(value); return new Uint8Array([...cborHead(3, bytes.length), ...bytes]); }
  if (typeof value === "number") return new Uint8Array(value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value));
  if (typeof value === "boolean") return new Uint8Array([value ? 0xf5 : 0xf4]);
  if (value instanceof Map || (value && typeof value === "object" && !Array.isArray(value))) {
    const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
    return concat(new Uint8Array(cborHead(5, entries.length)), ...entries.map(([key, val]) => concat(cbor(key), cbor(val))));
  }
  if (Array.isArray(value)) return concat(new Uint8Array(cborHead(4, value.length)), ...value.map(cbor));
  throw new Error("Unsupported CBOR value.");
}

// WebCrypto returns ECDSA signatures as raw r||s; WebAuthn needs ASN.1 DER.
function derInteger(bytes) {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0 && !(bytes[start + 1] & 0x80)) start++;
  const body = bytes.subarray(start);
  const padded = body[0] & 0x80 ? concat([0], body) : body;
  return new Uint8Array([0x02, padded.length, ...padded]);
}
export function toDer(raw) {
  if (raw.length !== 64 && raw[0] === 0x30) return raw; // Already DER.
  const r = derInteger(raw.subarray(0, 32)), s = derInteger(raw.subarray(32, 64));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

// A new software authenticator credential: P-256 keypair + WebAuthn credential ID + COSE key.
export async function newPasskeyMaterial() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const coordinate = value => { const bytes = unbase64url(value, 64); const out = new Uint8Array(32); out.set(bytes.subarray(Math.max(0, bytes.length - 32)), 32 - Math.min(32, bytes.length)); return out; };
  const coseKey = cbor(new Map().set(1, 2).set(3, -7).set(-1, 1).set(-2, coordinate(jwk.x)).set(-3, coordinate(jwk.y)));
  return {
    credentialId: crypto.getRandomValues(new Uint8Array(32)),
    privateKey: toBase64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))),
    publicKey: toBase64(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))),
    coseKey,
  };
}

export function clientDataJSON(type, challenge, origin) {
  return text.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

const FLAG_UP = 0x01, FLAG_UV = 0x04, FLAG_AT = 0x40;

// attestationObject with fmt "none": software self-attestation, accepted by all standard relying parties.
export async function attestationObject(rpId, credentialId, coseKey) {
  const attested = concat(new Uint8Array(16), [credentialId.length >> 8, credentialId.length & 0xff], credentialId, coseKey);
  const authData = concat(await sha256(text.encode(rpId)), [FLAG_UP | FLAG_UV | FLAG_AT], [0, 0, 0, 0], attested);
  return { attestation: cbor(new Map().set("fmt", "none").set("attStmt", new Map()).set("authData", authData)), authData };
}

// Authenticator data + DER signature for an assertion ceremony.
export async function signAssertion(privateKey, rpId, clientData, signCount) {
  const key = await crypto.subtle.importKey("pkcs8", fromBase64(privateKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const authData = concat(await sha256(text.encode(rpId)), [FLAG_UP | FLAG_UV], [signCount >>> 24, signCount >>> 16 & 0xff, signCount >>> 8 & 0xff, signCount & 0xff]);
  const signed = concat(authData, await sha256(clientData));
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, signed));
  return { authData, signature: toDer(raw) };
}
