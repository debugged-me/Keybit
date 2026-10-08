import { parseWebsite } from "../matching/url-matcher.js";

// Per-site rules: the old single "off" switch becomes a structured set of offers. Rules are
// non-secret preferences in chrome.storage.local — never usernames, passwords, or other vault data.
export const RULE_FLAGS = ["enabled", "logins", "save", "generate", "totp", "cards", "peek"];
export const DEFAULT_RULE = Object.freeze({ enabled: true, logins: true, save: true, generate: true, totp: true, cards: true, peek: true, subdomains: false });
// Which rule a dropdown/panel mode consumes.
export const MODE_FLAG = { login: "logins", username: "logins", otp: "totp", card: "cards", identity: "cards", new: "generate" };
export function sanitizeRule(raw) {
  const rule = { ...DEFAULT_RULE };
  for (const flag of [...RULE_FLAGS, "subdomains"]) if (typeof raw?.[flag] === "boolean") rule[flag] = raw[flag];
  return rule;
}
// True when the stored record differs from the defaults and is worth keeping.
export function isCustomized(rule) {
  return Object.keys(DEFAULT_RULE).some(key => rule[key] !== DEFAULT_RULE[key]);
}
// The effective rule for an origin: an exact entry wins; otherwise a rule may opt in to subdomains
// with `subdomains` — only then does it cover hostnames beneath it (same scheme and port, longest
// host wins). Scope is never broadened without that explicit flag.
export function ruleFor(rules, origin) {
  let site;
  try { site = parseWebsite(origin); } catch { return { ...DEFAULT_RULE }; }
  const exact = rules?.[site.origin];
  if (exact) return sanitizeRule(exact);
  let best = null;
  for (const [stored, raw] of Object.entries(rules ?? {})) {
    if (!raw?.subdomains) continue;
    let base;
    try { base = parseWebsite(stored); } catch { continue; }
    if (base.protocol !== site.protocol || base.port !== site.port) continue;
    if (site.hostname !== base.hostname && !site.hostname.endsWith(`.${base.hostname}`)) continue;
    if (!best || base.hostname.length > best.hostname.length) best = base;
  }
  return best ? sanitizeRule(rules[best.origin]) : { ...DEFAULT_RULE };
}
// Every persisted entry, normalized — invalid origins are dropped, rules at defaults are omitted so
// the map only ever carries real choices.
export function normalizeRules(raw) {
  const rules = {};
  for (const [origin, value] of Object.entries(raw ?? {})) {
    let key;
    try { key = parseWebsite(origin).origin; } catch { continue; }
    const rule = sanitizeRule(value);
    if (isCustomized(rule)) rules[key] = rule;
  }
  return rules;
}
