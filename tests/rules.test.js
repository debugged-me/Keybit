import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RULE, isCustomized, normalizeRules, ruleFor, sanitizeRule } from "../src/rules/site-rules.js";
import { Suggestions } from "../src/background/suggestions.js";

// A minimal chrome.* harness: in-memory storage, all host permissions granted, no tabs.
function stubChrome(storage = {}) {
  globalThis.chrome = {
    storage: { local: {
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, storage[key]])),
      set: async values => { Object.assign(storage, values); },
      remove: async key => { delete storage[key]; }
    } },
    tabs: { query: async () => [] },
    permissions: { contains: async () => true },
    scripting: { getRegisteredContentScripts: async () => [], executeScript: async () => [] }
  };
  return storage;
}

test("rules normalize, sanitize, and only keep real choices", () => {
  assert.deepEqual(sanitizeRule({ enabled: false, junk: 1, logins: "yes" }), { ...DEFAULT_RULE, enabled: false });
  const rules = normalizeRules({
    "https://a.example": { cards: false },
    "not a url": { enabled: false },
    "https://b.example": { ...DEFAULT_RULE }, // all defaults — dropped
    "https://c.example:8443/path/ignored?x=1": { save: false }
  });
  assert.deepEqual(Object.keys(rules).sort(), ["https://a.example", "https://c.example:8443"]);
  assert.equal(ruleFor(rules, "https://a.example").cards, false);
  assert.equal(ruleFor(rules, "https://unknown.example").enabled, true, "no rule means defaults");
  assert.equal(isCustomized(DEFAULT_RULE), false);
  assert.equal(isCustomized({ ...DEFAULT_RULE, subdomains: true }), true);
});

test("scope is exact origin unless the rule opts into subdomains", () => {
  const rules = normalizeRules({
    "https://example.com": { cards: false, subdomains: true },
    "https://shop.example.com": { totp: false }, // exact child wins over the parent rule
    "http://example.com": { enabled: false, subdomains: true } // different scheme — never mixes
  });
  assert.equal(ruleFor(rules, "https://app.example.com").cards, false, "subdomain inherits");
  assert.equal(ruleFor(rules, "https://shop.example.com").totp, false);
  assert.equal(ruleFor(rules, "https://shop.example.com").cards, true, "exact rule stands alone");
  assert.equal(ruleFor(rules, "http://app.example.com").enabled, false);
  assert.equal(ruleFor(rules, "https://example.com:8443").cards, true, "a different port is a different site");
  assert.equal(ruleFor(rules, "https://notexample.com").cards, true, "suffix lookalikes do not match");
});

test("1.3 disabledOrigins migrate to enabled:false rules", async () => {
  const storage = stubChrome({ disabledOrigins: ["https://off.example", "junk", "http://127.0.0.1:8000/app"] });
  const suggestions = new Suggestions();
  await suggestions.refresh();
  assert.equal(storage.disabledOrigins, undefined, "legacy key removed");
  assert.equal(suggestions.ruleFor("https://off.example").enabled, false);
  assert.equal(suggestions.ruleFor("http://127.0.0.1:8000").enabled, false, "migration keeps the exact origin");
  assert.deepEqual(suggestions.disabled.sort(), ["http://127.0.0.1:8000", "https://off.example"].sort());
  assert.equal(await suggestions.allows("https://off.example"), false);
  delete globalThis.chrome;
});

test("setRule stores, gates offers, and drops rules back at defaults", async () => {
  stubChrome();
  const suggestions = new Suggestions();
  await suggestions.refresh();
  const origin = "https://app.example.com";
  await suggestions.setRule(origin, { totp: false, save: false });
  let rule = suggestions.ruleFor(origin);
  assert.equal(rule.totp, false);
  assert.equal(suggestions.offered(origin, "totp"), false);
  assert.equal(suggestions.offered(origin, "save"), false);
  assert.equal(suggestions.offered(origin, "logins"), true);
  // The master switch also takes the offer flags down, and disabled lists the origin.
  await suggestions.setRule(origin, { enabled: false });
  assert.equal(suggestions.offered(origin, "logins"), false);
  assert.deepEqual(suggestions.disabled, [origin]);
  assert.equal(await suggestions.allows(origin), false);
  // With the site back on, a disabled flag alone blocks its offer, leaving the others.
  await suggestions.setRule(origin, { enabled: true });
  assert.equal(suggestions.offered(origin, "cards"), true);
  await suggestions.setRule(origin, { cards: false });
  assert.equal(suggestions.offered(origin, "cards"), false);
  assert.equal(suggestions.offered(origin, "logins"), true);
  // Turning everything back to defaults removes the record entirely.
  await suggestions.setRule(origin, { enabled: true, logins: true, save: true, generate: true, totp: true, cards: true, subdomains: false });
  rule = suggestions.ruleFor(origin);
  assert.equal(isCustomized(rule), false);
  assert.deepEqual(suggestions.siteRules()[origin], undefined);
  delete globalThis.chrome;
});

test("subdomain flag on a parent rule gates child origins — and nothing else", async () => {
  stubChrome();
  const suggestions = new Suggestions();
  await suggestions.refresh();
  await suggestions.setRule("https://example.com", { subdomains: true, logins: false });
  assert.equal(suggestions.offered("https://app.example.com", "logins"), false);
  assert.equal(suggestions.offered("https://app.example.com", "save"), true, "other flags unaffected");
  assert.equal(suggestions.offered("https://example.com", "logins"), false);
  assert.equal(suggestions.offered("http://app.example.com", "logins"), true, "scheme boundary respected");
  delete globalThis.chrome;
});
