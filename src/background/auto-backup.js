// Automatic encrypted backups to a folder the user picked, such as one in iCloud Drive, Dropbox, or Google Drive.
// The folder handle lives in this extension's IndexedDB; writing needs the browser's folder permission, which it
// may ask for again after a restart ("Reconnect").
export const BACKUP_FILE = "KeyBit Backup.kvault";
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
  const file = await folder.getFileHandle(BACKUP_FILE, { create: true });
  const writable = await file.createWritable();
  await writable.write(JSON.stringify(envelope, null, 2));
  await writable.close();
  return { status: "saved", folder: folder.name, at: Date.now() };
}
