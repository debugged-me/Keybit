import { parseWebsite } from "../matching/url-matcher.js";
import { parseTotp } from "./totp.js";

export const AUTO_LOCK_OPTIONS = [1, 5, 10, 15, 30, 0];
export const ENVIRONMENTS = ["local", "development", "staging", "production", "other"];
export const ITEM_TYPES = ["login", "note"];
export const HISTORY_LIMIT = 5;
export const MAX_URLS = 10;
const invalid = () => { throw new Error("The vault data is invalid or unsupported."); };
const text = (value, max, required = false) => {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) invalid();
  return value;
};
const date = value => {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
};

// Settings saved before 1.3 have no lockOnScreenLock; it defaults to on.
export function validateSettings(settings) {
  if (!settings || !AUTO_LOCK_OPTIONS.includes(settings.autoLockMinutes)) invalid();
  const lockOnScreenLock = settings.lockOnScreenLock ?? true;
  if (typeof lockOnScreenLock !== "boolean") invalid();
  return { autoLockMinutes: settings.autoLockMinutes, lockOnScreenLock };
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

export function validatePayload(payload) {
  if (!payload || payload.version !== 1 || !Number.isSafeInteger(payload.revision) || payload.revision < 0 || !Array.isArray(payload.items)) invalid();
  const items = payload.items.map(validateItem);
  if (new Set(items.map(item => item.id)).size !== items.length) invalid();
  return { version: 1, revision: payload.revision, items, settings: validateSettings(payload.settings) };
}

export function emptyVault() { return { version: 1, revision: 0, items: [], settings: { autoLockMinutes: 0, lockOnScreenLock: true } }; }

export function createItem(input, previous) {
  const now = new Date().toISOString();
  return validateItem({ ...input, id: previous?.id ?? crypto.randomUUID(), type: previous?.type ?? input.type ?? "login",
    createdAt: previous?.createdAt ?? now, updatedAt: now });
}

// The same login or note twice: same site (or project folder), username, and password; or same note text.
export function duplicateKey(item, scopeLabel) {
  return item.type === "note" ? `note\n${item.name}\n${item.notes}` : `login\n${scopeLabel(item.urls[0])}\n${item.username}\n${item.password}`;
}
