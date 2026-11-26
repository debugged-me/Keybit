// Automatic encrypted backups to a folder the user picked, such as one in iCloud Drive, Dropbox, or Google Drive.
// The folder handle lives in this extension's IndexedDB; writing needs the browser's folder permission, which it
// may ask for again after a restart ("Reconnect").
export const BACKUP_FILE = "KeyBit Backup.kvault"; // Legacy pre-1.4 filename; still discovered during sync.
async function deviceFileName() {
  let { backupDeviceId } = /** @type {{backupDeviceId?: string}} */ (await chrome.storage.local.get("backupDeviceId"));
  if (typeof backupDeviceId !== "string" || !/^[a-f0-9-]{36}$/i.test(backupDeviceId)) {
    backupDeviceId = crypto.randomUUID();
    await chrome.storage.local.set({ backupDeviceId });
  }
  return `KeyBit Backup ${backupDeviceId.slice(0, 8)}.kvault`;
}
function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("keybit", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("handles");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function transact(mode, run) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = run(db.transaction("handles", mode).objectStore("handles"));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
export const getFolder = () => transact("readonly", store => store.get("backup-folder")).catch(() => null);
export const setFolder = handle => transact("readwrite", store => handle ? store.put(handle, "backup-folder") : store.delete("backup-folder"));
export async function writeBackup(envelope, { ask = false } = {}) {
  const folder = await getFolder();
  if (!folder) return { status: "off" };
  let permission = await folder.queryPermission({ mode: "readwrite" });
  if (permission !== "granted" && ask) permission = await folder.requestPermission({ mode: "readwrite" });
  if (permission !== "granted") return { status: "reconnect", folder: folder.name };
  const name = await deviceFileName();
  const file = await folder.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  await writable.write(JSON.stringify(envelope, null, 2));
  await writable.close();
  return { status: "saved", folder: folder.name, file: name, at: Date.now() };
}

// One encrypted file per browser profile prevents two devices from silently overwriting each
// other. The Backup page can merge these snapshots after the user supplies their password.
export async function folderBackups({ ask = false } = {}) {
  const folder = await getFolder();
  if (!folder) return [];
  let permission = await folder.queryPermission({ mode: "read" });
  if (permission !== "granted" && ask) permission = await folder.requestPermission({ mode: "read" });
  if (permission !== "granted") throw new Error("Reconnect the backup folder before syncing.");
  const files = [];
  for await (const entry of /** @type {any} */ (folder).values()) {
    if (entry.kind !== "file" || !/^KeyBit Backup(?: [a-f0-9]{8})?\.kvault$/i.test(entry.name)) continue;
    const file = await entry.getFile();
    files.push({ name: entry.name, modified: file.lastModified, text: await file.text() });
  }
  return files.sort((a, b) => b.modified - a.modified);
}
