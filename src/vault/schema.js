import { parseWebsite } from "../matching/url-matcher.js";

export const AUTO_LOCK_OPTIONS = [1, 5, 10, 15, 30, 0];
export const ENVIRONMENTS = ["local", "development", "staging", "production", "other"];
export const HISTORY_LIMIT = 5;
const invalid = () => { throw new Error("The vault data is invalid or unsupported."); };
const text = (value, max, required = false) => {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) invalid();
  return value;
};
const date = value => {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
};

export function validateSettings(settings) {
  if (!settings || !AUTO_LOCK_OPTIONS.includes(settings.autoLockMinutes)) invalid();
  return { autoLockMinutes: settings.autoLockMinutes };
}

export function validateItem(item) {
  if (!item || item.type !== "login" || typeof item.id !== "string" || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(item.id) ||
      !Array.isArray(item.urls) || item.urls.length !== 1 || !ENVIRONMENTS.includes(item.environment)) invalid();
  // Items saved before 1.2 have no history.
  const history = item.history ?? [];
  if (!Array.isArray(history) || history.length > HISTORY_LIMIT) invalid();
  return {
    id: item.id, type: "login", name: text(item.name, 200, true),
    urls: [parseWebsite(item.urls[0]).href], username: text(item.username, 1024),
    password: text(item.password, 4096, true), notes: text(item.notes, 20000),
    environment: item.environment, createdAt: date(item.createdAt), updatedAt: date(item.updatedAt),
    history: history.map(entry => ({ password: text(entry?.password, 4096, true), changedAt: date(entry?.changedAt) }))
  };
}

export function validatePayload(payload) {
  if (!payload || payload.version !== 1 || !Number.isSafeInteger(payload.revision) || payload.revision < 0 ||
      !Array.isArray(payload.items)) invalid();
  const items = payload.items.map(validateItem);
  if (new Set(items.map(item => item.id)).size !== items.length) invalid();
  return { version: 1, revision: payload.revision, items, settings: validateSettings(payload.settings) };
}

export function emptyVault() { return { version: 1, revision: 0, items: [], settings: { autoLockMinutes: 0 } }; }

export function createItem(input, previous) {
  const now = new Date().toISOString();
  return validateItem({ ...input, id: previous?.id ?? crypto.randomUUID(), type: "login", createdAt: previous?.createdAt ?? now, updatedAt: now });
}
