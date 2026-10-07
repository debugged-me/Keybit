export const MAX_BACKUP_BYTES = 6 * 1024 * 1024;

export function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export function fromBase64(text, maxBytes = MAX_BACKUP_BYTES) {
  if (typeof text !== "string" || !text.length || text.length > Math.ceil(maxBytes / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) {
    throw new Error("The selected backup is invalid or corrupted.");
  }
  const bytes = Uint8Array.from(atob(text), character => character.charCodeAt(0));
  if (bytes.length > maxBytes || toBase64(bytes) !== text) throw new Error("The selected backup is invalid or corrupted.");
  return bytes;
}
