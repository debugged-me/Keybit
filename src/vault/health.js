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
