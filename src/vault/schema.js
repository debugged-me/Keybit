import { parseWebsite } from "../matching/url-matcher.js";
import { parseTotp } from "./totp.js";

export const AUTO_LOCK_OPTIONS = [1, 5, 10, 15, 30, 0];
export const ENVIRONMENTS = ["local", "development", "staging", "production", "other"];
export const ITEM_TYPES = ["login", "note", "passkey", "card", "identity"];
export const HISTORY_LIMIT = 5;
export const MAX_URLS = 10;
export const MAX_PROJECTS = 200;
export const MAX_ENVIRONMENTS = 16;
const invalid = () => { throw new Error("The vault data is invalid or unsupported."); };
const text = (value, max, required = false) => {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) invalid();
  return value;
};
const date = value => {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
};

// Settings saved before 1.3 have no lockOnScreenLock; before 1.4, no confirmProduction — both default on.
export function validateSettings(settings) {
  if (!settings || !AUTO_LOCK_OPTIONS.includes(settings.autoLockMinutes)) invalid();
  const lockOnScreenLock = settings.lockOnScreenLock ?? true;
  const confirmProduction = settings.confirmProduction ?? true;
  if (typeof lockOnScreenLock !== "boolean" || typeof confirmProduction !== "boolean") invalid();
  return { autoLockMinutes: settings.autoLockMinutes, lockOnScreenLock, confirmProduction };
}

export function validateItem(item) {
  const type = item?.type ?? "login";
  if (!item || !ITEM_TYPES.includes(type) || typeof item.id !== "string" || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(item.id)) invalid();
  const project = item.project ?? "";
  const favorite = item.favorite ?? false;
  if (typeof favorite !== "boolean") invalid();
  // Items deleted before 1.4 were removed outright; deletedAt marks the 30-day Recently deleted bin.
  const common = { id: item.id, type, name: text(item.name, 200, true), notes: text(item.notes ?? "", 20000), project: text(project, 100).trim(),
    favorite, deletedAt: item.deletedAt == null ? null : date(item.deletedAt), createdAt: date(item.createdAt), updatedAt: date(item.updatedAt) };
  if (type === "note") return { ...common, urls: [], username: "", environment: "other" };
  // Payment cards: digits only, brand derived from the number (never caller-supplied).
  if (type === "card") {
    const number = text(item.number, 32, true).replace(/[\s-]/g, "");
    const cvv = text(item.cvv ?? "", 8);
    if (!/^\d{12,19}$/.test(number) || (cvv && !/^\d{3,4}$/.test(cvv))) invalid();
    const expiryMonth = Math.floor(Number(item.expiryMonth)), expiryYear = Math.floor(Number(item.expiryYear));
    if (!Number.isInteger(expiryMonth) || expiryMonth < 1 || expiryMonth > 12 || !Number.isInteger(expiryYear) || expiryYear < 0 || expiryYear > 9999) invalid();
    return { ...common, urls: [], username: "", environment: "other", totp: "", history: [],
      cardholder: text(item.cardholder ?? "", 200), number, expiryMonth, expiryYear, cvv, brand: cardBrand(number) };
  }
  if (type === "identity") {
    return { ...common, urls: [], username: "", environment: "other", totp: "", history: [],
      firstName: text(item.firstName ?? "", 100), lastName: text(item.lastName ?? "", 100),
      email: text(item.email ?? "", 320), phone: text(item.phone ?? "", 60), address: text(item.address ?? "", 300),
      city: text(item.city ?? "", 120), region: text(item.region ?? "", 120), postal: text(item.postal ?? "", 20),
      country: text(item.country ?? "", 120), company: text(item.company ?? "", 200) };
  }
  // Passkeys are WebAuthn credentials created in-page; the private key is a PKCS8 secret, never an autofill password.
  if (type === "passkey") {
    const signCount = item.signCount ?? 0;
    if (typeof item.rpId !== "string" || !item.rpId || item.rpId.length > 255 ||
        typeof item.credentialId !== "string" || !item.credentialId || item.credentialId.length > 1023 ||
        typeof item.userName !== "string" || !item.userName || item.userName.length > 1024 ||
        typeof item.userHandle !== "string" || item.userHandle.length > 1023 ||
        typeof item.privateKey !== "string" || !item.privateKey || item.privateKey.length > 4096 ||
        !Number.isInteger(signCount) || signCount < 0 || signCount > 0xffffffff) invalid();
    return { ...common, urls: [], username: "", password: "", environment: "other", totp: "", history: [],
      rpId: item.rpId, credentialId: item.credentialId, userName: item.userName, userHandle: item.userHandle,
      privateKey: item.privateKey, signCount, lastUsedAt: item.lastUsedAt == null ? null : date(item.lastUsedAt) };
  }
  // Items saved before 1.2 have no history; before 1.3, no 2FA secret, project, or favorite.
  const history = item.history ?? [];
  if (!Array.isArray(item.urls) || !item.urls.length || item.urls.length > MAX_URLS || !ENVIRONMENTS.includes(item.environment) ||
      !Array.isArray(history) || history.length > HISTORY_LIMIT) invalid();
  const totp = text(item.totp ?? "", 1024).trim();
  if (totp) parseTotp(totp);
  return { ...common, urls: [...new Set(item.urls.map(url => parseWebsite(url).href))], username: text(item.username, 1024),
    password: text(item.password, 4096, true), environment: item.environment, totp,
    history: history.map(entry => ({ password: text(entry?.password, 4096, true), changedAt: date(entry?.changedAt) })) };
}

// Per-project environment URLs, added in 1.4E: { name: { environments: { staging: url } } }.
// Vaults and backups written before 1.4 have no `projects` key — it is optional everywhere.
export function validateProjects(projects) {
  if (projects == null) return {};
  if (typeof projects !== "object" || Array.isArray(projects)) invalid();
  const entries = Object.entries(projects);
  if (entries.length > MAX_PROJECTS) invalid();
  const out = {};
  for (const [rawName, entry] of entries) {
    const name = text(rawName, 100).trim();
    const environments = entry?.environments;
    if (!name || typeof environments !== "object" || environments == null || Array.isArray(environments)) invalid();
    const list = Object.entries(environments);
    if (list.length > MAX_ENVIRONMENTS) invalid();
    const clean = {};
    for (const [key, value] of list) {
      const env = key.trim().toLowerCase();
      if (!/^[a-z][a-z\d_-]{0,39}$/.test(env)) invalid();
      try { clean[env] = parseWebsite(value).href; } catch { invalid(); }
    }
    out[name] = { environments: clean };
  }
  return out;
}

export function validatePayload(payload) {
  if (!payload || payload.version !== 1 || !Number.isSafeInteger(payload.revision) || payload.revision < 0 || !Array.isArray(payload.items)) invalid();
  const items = payload.items.map(validateItem);
  if (new Set(items.map(item => item.id)).size !== items.length) invalid();
  return { version: 1, revision: payload.revision, items, settings: validateSettings(payload.settings), projects: validateProjects(payload.projects) };
}

// Card network from the IIN range — display only, the number itself is authoritative.
export function cardBrand(number) {
  const digits = String(number).replace(/\D/g, "");
  if (/^4/.test(digits)) return "Visa";
  if (/^(5[1-5]|2[2-7])/.test(digits)) return "Mastercard";
  if (/^3[47]/.test(digits)) return "Amex";
  if (/^6(?:011|5)/.test(digits)) return "Discover";
  if (/^35/.test(digits)) return "JCB";
  if (/^62/.test(digits)) return "UnionPay";
  if (/^3(?:0[0-5]|[689])/.test(digits)) return "Diners";
  return "Card";
}
export const expiryDisplay = item => `${String(item.expiryMonth).padStart(2, "0")}/${String(item.expiryYear).padStart(item.expiryYear > 99 ? 4 : 2, "0")}`;

export function emptyVault() { return { version: 1, revision: 0, items: [], settings: { autoLockMinutes: 0, lockOnScreenLock: true, confirmProduction: true }, projects: {} }; }

export function createItem(input, previous) {
  const now = new Date().toISOString();
  return validateItem({ ...input, id: previous?.id ?? crypto.randomUUID(), type: previous?.type ?? input.type ?? "login",
    createdAt: previous?.createdAt ?? now, updatedAt: now });
}

// The same login or note twice: same site (or project folder), username, and password; or same note text.
export function duplicateKey(item, scopeLabel) {
  if (item.type === "note") return `note\n${item.name}\n${item.notes}`;
  if (item.type === "passkey") return `passkey\n${item.rpId}\n${item.credentialId}`;
  if (item.type === "card") return `card\n${item.number}\n${item.expiryMonth}/${item.expiryYear}`;
  if (item.type === "identity") return `identity\n${item.firstName}\n${item.lastName}\n${item.email}`;
  return `login\n${scopeLabel(item.urls[0])}\n${item.username}\n${item.password}`;
}
