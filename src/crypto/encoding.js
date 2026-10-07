// Sized to stay below Chromium's 64 MiB extension-message limit, since backups travel by message.
export const MAX_VAULT_BYTES = 32 * 1024 * 1024;
export const MAX_BACKUP_BYTES = 48 * 1024 * 1024;

export function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export function fromBase64(text, maxBytes = MAX_BACKUP_BYTES) {
  const invalid = () => { throw new Error("The selected backup is invalid or corrupted."); };
  // No regular expression here: a backtracking pattern overflows the stack on multi-megabyte vaults.
  if (typeof text !== "string" || !text.length || text.length % 4 || text.length > Math.ceil(maxBytes / 3) * 4) invalid();
  let binary;
  try { binary = atob(text); } catch { invalid(); }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // Re-encoding rejects non-canonical input, including whitespace that atob would ignore.
  if (bytes.length > maxBytes || toBase64(bytes) !== text) invalid();
  return bytes;
}
