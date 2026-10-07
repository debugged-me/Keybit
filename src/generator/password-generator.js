export const GROUPS = {
  uppercase: "ABCDEFGHIJKLMNOPQRSTUVWXYZ", lowercase: "abcdefghijklmnopqrstuvwxyz",
  numbers: "0123456789", symbols: "!@#$%^&*()-_=+[]{};:,.?/~"
};

function randomIndex(limit) {
  const ceiling = 256 - (256 % limit);
  const byte = new Uint8Array(1);
  do { crypto.getRandomValues(byte); } while (byte[0] >= ceiling);
  return byte[0] % limit;
}

export function generatePassword(options = {}) {
  const config = { length: 24, uppercase: true, lowercase: true, numbers: true, symbols: true, ...options };
  if (!Number.isInteger(config.length) || config.length < 8 || config.length > 128) throw new Error("Choose a length from 8 to 128.");
  const groups = Object.entries(GROUPS).filter(([name]) => config[name] === true).map(([, group]) => group);
  if (!groups.length) throw new Error("Select at least one character group.");
  const alphabet = groups.join("");
  // Rejection sampling gives a uniform distribution over passwords satisfying all selected groups.
  let result;
  do { result = Array.from({ length: config.length }, () => alphabet[randomIndex(alphabet.length)]).join(""); }
  while (!groups.every(group => [...result].some(character => group.includes(character))));
  return result;
}

// Memorable passwords, such as "Acorn-Tulip-Rugby-Mango-Spoon7". Words come from a list passed in, so the
// word list is only loaded by pages that offer this mode.
export function generatePassphrase(options = {}, words) {
  const config = { words: 5, separator: "-", capitalize: true, number: true, ...options };
  if (!Number.isInteger(config.words) || config.words < 3 || config.words > 10) throw new Error("Choose from 3 to 10 words.");
  if (!Array.isArray(words) || words.length < 1000) throw new Error("The word list is unavailable.");
  const picked = Array.from({ length: config.words }, () => {
    const word = words[uniform(words.length)];
    return config.capitalize ? word[0].toUpperCase() + word.slice(1) : word;
  });
  if (config.number) picked[picked.length - 1] += String(uniform(10));
  return picked.join(config.separator);
}
// Unbiased integer in [0, limit) for limits beyond one byte.
function uniform(limit) {
  const ceiling = 2 ** 32 - (2 ** 32 % limit);
  const value = new Uint32Array(1);
  do { crypto.getRandomValues(value); } while (value[0] >= ceiling);
  return value[0] % limit;
}
