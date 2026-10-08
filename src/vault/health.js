// Local-only password checks. Nothing here leaves the worker except per-login flags.
const COMMON = new Set(["password", "password1", "123456", "12345678", "123456789", "1234567890", "qwerty", "111111", "000000",
  "123123", "abc123", "admin", "admin123", "root", "toor", "letmein", "welcome", "iloveyou", "changeme", "secret"]);
export function isWeak(password) {
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(pattern => pattern.test(password)).length;
  return COMMON.has(password.toLowerCase()) || password.length < 8 || (password.length < 12 && classes < 3) || (password.length < 16 && classes < 2);
}
export function vaultHealth(items) {
  const uses = new Map();
  for (const item of items) uses.set(item.password, (uses.get(item.password) ?? 0) + 1);
  return Object.fromEntries(items.map(item => [item.id, { reused: uses.get(item.password) - 1, weak: isWeak(item.password) }]));
}
// Password age is informational, not a verdict: fresh < 1y, aging 1–2y, old > 2y since the login was last changed.
// Item timestamps are ISO strings; anything unparsable counts as fresh rather than old.
export function passwordAge(updatedAt, now = Date.now()) {
  const timestamp = typeof updatedAt === "number" ? updatedAt : Date.parse(updatedAt);
  const days = Math.max(0, now - (Number.isFinite(timestamp) ? timestamp : now)) / 86400000;
  return days < 365 ? "fresh" : days < 730 ? "aging" : "old";
}
// The Security Center report — computed entirely in the worker over decrypted items. No network,
// no persisted password index: the reuse count lives for exactly one call.
//
// Score formula (shown in the UI, so it must stay explainable):
//   start at 100
//   −8 per weak login (at most −40)
//   −6 per login sharing a password (at most −30)
//   −4 per exact duplicate credential — same username and password stored twice (at most −12)
//   −3 per login unchanged for over 2 years (at most −15)
//   −1 per login unchanged for 1–2 years (at most −5)
//   +2 per login with a 2FA code (at most +10)
//   +3 per saved passkey (at most +9)
//   clamped to 0–100. An empty vault scores 100.
export function securityReport(items, now = Date.now()) {
  const logins = items.filter(item => item.type === "login" && !item.deletedAt);
  const flags = vaultHealth(logins);
  const metrics = { logins: logins.length, strong: 0, weak: 0, reused: 0, fresh: 0, aging: 0, old: 0,
    totp: 0, passkeys: items.filter(item => item.type === "passkey" && !item.deletedAt).length,
    duplicates: 0, production: 0, needReview: 0 };
  const credentials = new Map();
  for (const item of logins) {
    const flag = flags[item.id];
    if (flag.weak) metrics.weak++;
    if (flag.reused) metrics.reused++;
    metrics[passwordAge(item.updatedAt, now)]++;
    if (item.totp) metrics.totp++;
    if (item.environment === "production") metrics.production++;
    if (flag.weak || flag.reused || passwordAge(item.updatedAt, now) === "old") metrics.needReview++;
    const key = `${item.username} ${item.password}`;
    credentials.set(key, (credentials.get(key) ?? 0) + 1);
  }
  for (const count of credentials.values()) if (count > 1) metrics.duplicates += count - 1;
  metrics.strong = metrics.logins - metrics.weak;
  // Each factor carries its own count and delta so the UI can show exactly why the score moved.
  const factors = [];
  const deduct = (count, each, cap, label, good = false) => {
    if (!count) return;
    const delta = good ? Math.min(cap, count * each) : -Math.min(cap, count * each);
    factors.push({ label, count, delta });
  };
  deduct(metrics.weak, 8, 40, "weak passwords");
  deduct(metrics.reused, 6, 30, "reused passwords");
  deduct(metrics.duplicates, 4, 12, "duplicate credentials");
  deduct(metrics.old, 3, 15, "passwords unchanged for over 2 years");
  deduct(metrics.aging, 1, 5, "passwords unchanged for 1–2 years");
  deduct(metrics.totp, 2, 10, "accounts with 2FA", true);
  deduct(metrics.passkeys, 3, 9, "saved passkeys", true);
  const score = metrics.logins ? Math.max(0, Math.min(100, 100 + factors.reduce((sum, factor) => sum + factor.delta, 0))) : 100;
  return { score, factors, metrics };
}
