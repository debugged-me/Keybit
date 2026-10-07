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
