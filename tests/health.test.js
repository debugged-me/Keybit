import test from "node:test";
import assert from "node:assert/strict";
import { isWeak, passwordAge, securityReport } from "../src/vault/health.js";

const YEAR = 365 * 86400000;
const NOW = Date.now();
const login = fields => ({ type: "login", name: "Site", urls: ["https://x.example"], username: "u",
  password: "a-strong-different-password-1", environment: "other", updatedAt: NOW, ...fields });

test("securityReport on an empty vault scores 100 with no factors", () => {
  const report = securityReport([]);
  assert.equal(report.score, 100);
  assert.deepEqual(report.factors, []);
  assert.equal(report.metrics.logins, 0);
});

test("the score explains itself: every factor carries a count and a signed delta", () => {
  const items = [
    login({ id: "weak", username: "weak", password: "password" }),
    login({ id: "reused-a", username: "first", password: "shared-pass-123" }),
    login({ id: "reused-b", username: "second", password: "shared-pass-123" }),
    login({ id: "old", username: "old", password: "old-unique-pw-77", updatedAt: NOW - 3 * YEAR }),
    login({ id: "totp", username: "totp", password: "totp-unique-pw-88", totp: "JBSWY3DPEHPK3PXP" }),
    { type: "passkey", id: "pk", name: "Passkey" }
  ];
  const report = securityReport(items, NOW);
  // 1 weak (−8) + 2 sharing a password (−12) + 1 old (−3) + 1 TOTP (+2) + 1 passkey (+3) = 82.
  assert.equal(report.score, 82);
  const deltas = Object.fromEntries(report.factors.map(factor => [factor.label, factor.delta]));
  assert.equal(deltas["weak passwords"], -8);
  assert.equal(deltas["reused passwords"], -12);
  assert.equal(deltas["passwords unchanged for over 2 years"], -3);
  assert.equal(deltas["accounts with 2FA"], 2);
  assert.equal(deltas["saved passkeys"], 3);
  for (const factor of report.factors) assert.ok(Number.isInteger(factor.count) && Number.isInteger(factor.delta));
  assert.equal(report.metrics.weak, 1);
  assert.equal(report.metrics.reused, 2);
  assert.equal(report.metrics.strong, report.metrics.logins - 1);
  assert.equal(report.metrics.old, 1);
  assert.equal(report.metrics.totp, 1);
  assert.equal(report.metrics.passkeys, 1);
});

test("age bands are informational only: fresh < 1 year, aging 1–2, old > 2", () => {
  assert.equal(passwordAge(NOW - 100 * 86400000, NOW), "fresh");
  assert.equal(passwordAge(NOW - 500 * 86400000, NOW), "aging");
  assert.equal(passwordAge(NOW - 3 * YEAR, NOW), "old");
});

test("duplicates mean the same username and password twice; reuse alone does not count", () => {
  const report = securityReport([
    login({ id: "a", username: "me", password: "one-shared-pw" }),
    login({ id: "b", username: "me", password: "one-shared-pw" }),      // duplicate of a
    login({ id: "c", username: "other", password: "one-shared-pw" }),   // reuse, not duplicate
    login({ id: "d", username: "me", password: "different-pw-9" })
  ], NOW);
  assert.equal(report.metrics.duplicates, 1, "Only the exact same credential counts");
  assert.equal(report.metrics.reused, 3, "All three sharers flag as reused");
});

test("deleted items and non-login types do not skew login metrics", () => {
  const report = securityReport([
    login({ id: "live" }),
    login({ id: "gone", deletedAt: new Date(NOW).toISOString(), password: "password" }),
    { type: "note", id: "n", name: "n" }
  ], NOW);
  assert.equal(report.metrics.logins, 1);
  assert.equal(report.metrics.weak, 0);
});

test("factor penalties are capped so a huge vault cannot go wildly negative", () => {
  const items = Array.from({ length: 20 }, (_, i) => login({ id: `w${i}`, password: `pw${i}` === "pw0" ? "password" : `x${i}` }));
  const report = securityReport(items, NOW);
  assert.ok(report.score >= 0 && report.score <= 100);
  assert.ok(report.factors.every(factor => factor.delta >= -40), "weak factor capped at −40");
});

test("isWeak keeps its existing rules", () => {
  assert.ok(isWeak("password"));
  assert.ok(isWeak("Short1"));
  assert.ok(!isWeak("a-very-long-and-mixed-P4ssword!"));
});
