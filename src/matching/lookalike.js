// Lookalike-domain detection for pre-fill phishing warnings. Two attacks are caught:
// confusable characters (Cyrillic/Greek letters and digits that resemble Latin, including
// punycode "xn--" spellings) are folded to what they imitate, and near-miss spellings
// (typosquats, dropped letters, added hyphens) are caught by a bounded edit distance.
// Pure functions — used by the worker against the saved-sites list, testable in Node.

// A conservative confusables table: characters that are visually near-identical to Latin.
const CONFUSABLES = new Map(Object.entries({
  "0": "o", "1": "l", "2": "z", "3": "e", "4": "a", "5": "s", "6": "g", "7": "t", "8": "b", "9": "g", "@": "a",
  // Cyrillic
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y", "і": "i", "ј": "j", "ѕ": "s",
  "н": "h", "к": "k", "м": "m", "т": "t", "в": "b", "г": "r", "ԁ": "d", "ԛ": "q", "ԝ": "w", "һ": "h", "ӏ": "l",
  // Greek
  "α": "a", "ε": "e", "ο": "o", "ρ": "p", "υ": "u", "ν": "v", "τ": "t", "ι": "i", "κ": "k", "μ": "m", "η": "n", "χ": "x",
  // Fullwidth, IPA and letterlike forms
  "ɡ": "g", "ℓ": "l", "ı": "i", "℮": "e", "ｏ": "o", "ａ": "a", "ｅ": "e",
}));

// Minimal RFC 3492 decoder — enough to turn "xn--nxasmq6b" labels back into Unicode for comparison.
function adapt(delta, points, first) {
  let d = first ? Math.floor(delta / 700) : Math.floor(delta / 2);
  d += Math.floor(d / points);
  let k = 0;
  while (d > 455) { d = Math.floor(d / 35); k += 36; }
  return k + Math.floor((36 * d) / (d + 38));
}
function punydecode(label) {
  let n = 128, i = 0, bias = 72;
  const out = [];
  const basic = label.lastIndexOf("-");
  if (basic >= 0) for (const ch of label.slice(0, basic)) { if (ch.codePointAt(0) > 127) return label; out.push(ch.codePointAt(0)); }
  let pos = basic + 1;
  while (pos < label.length) {
    const oldi = i;
    let w = 1;
    for (let k = 36; ; k += 36) {
      if (pos >= label.length) return label;
      const c = label.charCodeAt(pos++);
      const digit = c >= 97 ? c - 97 : c >= 65 ? c - 65 : c - 48 + 26;
      if (digit > 35) return label;
      i += digit * w;
      const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
      if (digit < t) break;
      w *= 36 - t;
    }
    bias = adapt(i - oldi, out.length + 1, oldi === 0);
    n += Math.floor(i / (out.length + 1));
    i %= out.length + 1;
    out.splice(i, 0, n);
    i++;
  }
  return String.fromCodePoint(...out);
}

// Common second-level public suffixes, so "example.co.uk" compares as one registrable unit.
const TWO_LEVEL = new Set(["co.uk", "org.uk", "ac.uk", "com.au", "net.au", "org.au", "co.jp", "or.jp", "com.br", "com.cn", "com.tw", "co.nz", "co.in", "com.mx", "com.tr", "co.kr", "com.sg", "com.hk", "com.ar", "co.za", "com.pl", "co.id", "com.my", "com.ph", "com.vn", "co.th", "com.pk", "com.co", "com.pe", "com.sa", "com.ng", "com.ua", "co.il", "com.co.id"]);

function domainOf(host) {
  const parts = String(host).toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const last2 = parts.slice(-2).join(".");
  return TWO_LEVEL.has(last2) ? parts.slice(-3).join(".") : last2;
}

// What the host *looks like* to a person: punycode decoded, lookalike glyphs folded to
// Latin, and hyphens removed (pay-pal.com reads as paypal.com at a glance).
function fold(domain) {
  const decoded = domain.split(".").map(label => label.startsWith("xn--") ? punydecode(label.slice(4)) : label).join(".");
  return [...decoded].map(ch => CONFUSABLES.get(ch) ?? ch).join("").replace(/-/g, "");
}

// Levenshtein with early exit once the gap provably exceeds `limit`.
function distance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let min = limit + 1;
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (row[j] < min) min = row[j];
    }
    if (min > limit) return limit + 1;
    previous = row;
  }
  return previous[b.length];
}

// Returns the saved domain `host` imitates, or null. Only the registrable label is
// compared — a different TLD alone (amazon.de vs amazon.com) is ordinary, while a
// confusable or typo'd label on any TLD is the dangerous case.
export function lookalikeOf(host, savedHosts) {
  const raw = domainOf(host);
  if (!raw || /^[\d.]+$/.test(raw) || raw === "localhost" || raw.endsWith(".test") || raw.endsWith(".local")) return null;
  const label = raw.split(".")[0], folded = fold(label);
  if (!folded) return null;
  for (const savedHost of savedHosts) {
    const savedRaw = domainOf(savedHost);
    if (!savedRaw || savedRaw === raw) continue;
    const savedLabel = savedRaw.split(".")[0], savedFolded = fold(savedLabel);
    if (savedFolded === folded) {
      if (savedLabel === label) continue; // Same spelling, different TLD — fine.
      return savedRaw; // Reads identically but spelled differently — a confusable twin.
    }
    const gap = folded.length >= 12 ? 2 : 1;
    if (distance(folded, savedFolded, gap) <= gap) return savedRaw;
  }
  return null;
}
