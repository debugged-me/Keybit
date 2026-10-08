// Plain-text export for moving to another password manager. The columns match what
// Chrome, Apple Passwords, Bitwarden, 1Password and KeyBit's own importer read back.
const COLUMNS = ["name", "url", "username", "password", "notes", "totp", "folder", "environment", "favorite", "type"];
const cell = value => {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
// A login with several websites becomes one row per site, like other managers' exports.
export function toCsv(items) {
  const rows = [COLUMNS.join(",")];
  for (const item of items) {
    const shared = [item.name, undefined, item.username ?? "", item.password ?? "", item.notes ?? "", item.totp ?? "",
      item.project ?? "", item.environment ?? "", item.favorite ? "1" : "", item.type ?? "login"];
    for (const url of item.urls?.length ? item.urls : [""]) {
      shared[1] = url;
      rows.push(shared.map(cell).join(","));
    }
  }
  return `${rows.join("\r\n")}\r\n`;
}
