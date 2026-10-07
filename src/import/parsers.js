// Turns exports from other password managers into KeyBit items. Runs in the KeyBit page only;
// the worker validates every item again before saving.

// RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF, and a UTF-8 BOM.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  const input = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i++) {
    const character = input[i];
    if (quoted) {
      if (character === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"' && field === "") quoted = true;
    else if (character === ",") { row.push(field); field = ""; }
    else if (character === "\n" || character === "\r") {
      if (character === "\r" && input[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some(value => value !== "")) rows.push(row);
      row = [];
    } else field += character;
  }
  row.push(field);
  if (row.some(value => value !== "")) rows.push(row);
  return rows;
}

// Column names used by Chrome/Helium/Edge, Apple Passwords, Bitwarden, 1Password, LastPass, Dashlane, KeePass and Firefox.
const COLUMNS = {
  url: ["url", "website", "login_uri", "web site", "uri", "login url", "address", "hostname"],
  username: ["username", "login_username", "user name", "login", "email", "user", "login name"],
  password: ["password", "login_password", "pass"],
  name: ["name", "title", "account name", "item name", "account"],
  notes: ["note", "notes", "extra", "comments", "comment", "notesplain"],
  totp: ["totp", "otpauth", "login_totp", "one-time password", "otp", "2fa", "otpurl"],
  project: ["folder", "grouping", "group", "category", "collection", "vault"],
  favorite: ["favorite", "fav", "favourite"],
  type: ["type"]
};
function columnsOf(header) {
  const names = header.map(name => name.trim().toLowerCase());
  const map = {};
  for (const [field, aliases] of Object.entries(COLUMNS)) {
    const index = names.findIndex(name => aliases.includes(name));
    if (index >= 0) map[field] = index;
  }
  return map;
}
// Bare hosts get https://; app links (android://) and other schemes cannot be filled in a browser.
export function websiteFrom(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(candidate);
    return ["http:", "https:"].includes(url.protocol) && url.hostname && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
const hostOf = url => { try { return new URL(url).host; } catch { return ""; } };
// Entries with a password but no usable website keep their data as a secure note rather than being dropped.
/** @param {{ url?: string, username?: string, password?: string, name?: string, notes?: string, totp?: string, project?: string, favorite?: boolean, isNote?: boolean }} entry */
function toItem({ url, username, password, name, notes, totp, project, favorite, isNote }) {
  const website = websiteFrom(url);
  const title = String(name ?? "").trim();
  if (!isNote && website && password) {
    return { type: "login", name: title || hostOf(website), urls: [website], username: username ?? "", password, notes: notes ?? "", totp: totp ?? "", project: project ?? "", favorite: !!favorite };
  }
  const lines = [username && `Username: ${username}`, password && `Password: ${password}`, url && !website && `Address: ${url}`, totp && `2FA: ${totp}`, notes].filter(Boolean);
  if (!lines.length && !title) return null;
  return { type: "note", name: title || "Imported note", notes: lines.join("\n"), project: project ?? "", favorite: !!favorite };
}
function fromCsv(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new Error("This file is empty.");
  const columns = columnsOf(header);
  if (columns.password === undefined && columns.notes === undefined) throw new Error("This CSV has no password column. Export it again from your password manager as CSV.");
  const value = (row, field) => columns[field] === undefined ? "" : (row[columns[field]] ?? "").trim();
  const items = [];
  let skipped = 0;
  for (const row of rows) {
    const type = value(row, "type").toLowerCase();
    // Bitwarden marks notes, cards and identities by type; LastPass marks secure notes with the URL http://sn.
    const isNote = ["note", "securenote", "secure note", "2"].includes(type) || value(row, "url") === "http://sn";
    if (["card", "identity", "3", "4"].includes(type)) { skipped++; continue; }
    const item = toItem({ url: isNote ? "" : value(row, "url"), username: value(row, "username"), password: row[columns.password] ?? "",
      name: value(row, "name"), notes: columns.notes === undefined ? "" : row[columns.notes] ?? "", totp: value(row, "totp"),
      project: value(row, "project"), favorite: ["1", "true", "yes"].includes(value(row, "favorite").toLowerCase()), isNote });
    if (item) items.push(item); else skipped++;
  }
  return { items, skipped };
}
function fromBitwardenJson(data) {
  if (data.encrypted) throw new Error("This Bitwarden export is encrypted. Export again as JSON (not password protected) or CSV.");
  const folders = new Map((data.folders ?? []).map(folder => [folder.id, folder.name]));
  const items = [];
  let skipped = 0;
  for (const entry of data.items ?? []) {
    const project = folders.get(entry.folderId) ?? "";
    if (entry.type === 1 && entry.login) {
      const urls = (entry.login.uris ?? []).map(uri => websiteFrom(uri?.uri)).filter(Boolean).slice(0, 10);
      const item = toItem({ url: urls[0] ?? entry.login.uris?.[0]?.uri, username: entry.login.username ?? "", password: entry.login.password ?? "", name: entry.name,
        notes: entry.notes ?? "", totp: entry.login.totp ?? "", project, favorite: entry.favorite });
      if (item?.type === "login") item.urls = urls.length ? urls : item.urls;
      if (item) items.push(item); else skipped++;
    } else if (entry.type === 2) items.push(toItem({ name: entry.name, notes: entry.notes ?? "", project, favorite: entry.favorite, isNote: true }));
    else skipped++;
  }
  return { items: items.filter(Boolean), skipped };
}
// Returns { items, skipped, source } or throws a message suitable for the user.
export function parseImport(text, fileName = "") {
  if (typeof text !== "string" || !text.trim()) throw new Error("This file is empty.");
  if (/\.(kvault|cvault)$/i.test(fileName)) throw new Error("This is a KeyBit backup. Restore it from Backup instead.");
  if (/\.1pux$/i.test(fileName)) throw new Error("1Password .1pux files are not supported yet. In 1Password, export as CSV instead.");
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    let data;
    try { data = JSON.parse(trimmed); } catch { throw new Error("This JSON file could not be read."); }
    if (data.formatVersion === 1 && data.ciphertext) throw new Error("This is a KeyBit backup. Restore it from Backup instead.");
    if (!Array.isArray(data.items)) throw new Error("Unsupported JSON export. Use a Bitwarden JSON or any CSV export.");
    return { ...fromBitwardenJson(data), source: "Bitwarden" };
  }
  return { ...fromCsv(text), source: "CSV" };
}
