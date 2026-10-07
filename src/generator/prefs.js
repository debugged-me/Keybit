import { generatePassword, generatePassphrase } from "./password-generator.js";

// The last generator choice is remembered on this device (it is not secret) and used everywhere KeyBit
// generates: the generator view, the login form, the popup, and sign-up fields.
export const DEFAULT_PREFS = { mode: "random", length: 20, uppercase: true, lowercase: true, numbers: true, symbols: true, words: 5 };
export async function loadPrefs() {
  try { return { ...DEFAULT_PREFS, .../** @type {any} */ (await chrome.storage.local.get("generator")).generator }; } catch { return { ...DEFAULT_PREFS }; }
}
export async function savePrefs(prefs) {
  await chrome.storage.local.set({ generator: { ...DEFAULT_PREFS, ...prefs } }).catch(() => {});
}
let words = null;
export async function generate(prefs = DEFAULT_PREFS) {
  if (prefs.mode !== "memorable") return generatePassword({ length: prefs.length, uppercase: prefs.uppercase, lowercase: prefs.lowercase, numbers: prefs.numbers, symbols: prefs.symbols });
  words ??= (await import("./words.js")).WORDS;
  return generatePassphrase({ words: prefs.words }, words);
}
