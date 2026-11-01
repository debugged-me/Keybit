// Browser data export: bookmarks and history read straight from the browser's APIs after the
// user grants the optional permission. Passwords are not collected here — they stay on the
// vault's own EXPORT / EXPORT_CSV path so nothing new can reach plaintext credentials.
const HISTORY_CAP = 50000; // one generous page keeps the flow simple; most profiles are far smaller

const csvCell = value => {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const escapeHtml = value => String(value ?? "").replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);

export function downloadFile(name, text, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// ---- Bookmarks ----
// Flattened rows carry the folder path so a CSV stays meaningful; the HTML build keeps the
// real tree in Netscape format, which every browser's importer understands.
export async function collectBookmarks() {
  return chrome.bookmarks.getTree();
}

export function bookmarkRows(roots) {
  const rows = [];
  const walk = (node, path) => {
    if (node.url) rows.push({ name: node.title ?? "", url: node.url, folder: path.join("/"), added: node.dateAdded });
    for (const child of node.children ?? []) walk(child, child.url ? path : [...path, node.title].filter(Boolean));
  };
  for (const root of roots) for (const child of root.children ?? []) walk(child, []);
  return rows;
}

export function bookmarksCsv(rows) {
  const lines = ["name,url,folder,added"];
  for (const row of rows) lines.push([row.name, row.url, row.folder, row.added ? new Date(row.added).toISOString() : ""].map(csvCell).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

export function bookmarksHtml(roots) {
  const lines = ["<!DOCTYPE NETSCAPE-Bookmark-file-1>", '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">', "<TITLE>Bookmarks</TITLE>", "<H1>Bookmarks</H1>"];
  const write = (node, depth) => {
    const pad = "    ".repeat(depth);
    lines.push(`${pad}<DL><p>`);
    for (const child of node.children ?? []) {
      if (child.url) lines.push(`${pad}    <DT><A HREF="${escapeHtml(child.url)}"${child.dateAdded ? ` ADD_DATE="${Math.floor(child.dateAdded / 1000)}"` : ""}>${escapeHtml(child.title)}</A>`);
      else if (child.children?.length) {
        lines.push(`${pad}    <DT><H3${child.dateGroupModified ? ` LAST_MODIFIED="${Math.floor(child.dateGroupModified / 1000)}"` : ""}>${escapeHtml(child.title)}</H3>`);
        write(child, depth + 1);
      }
    }
    lines.push(`${pad}</DL><p>`);
  };
  for (const root of roots) write(root, 0);
  return `${lines.join("\n")}\n`;
}

// ---- History ----
export async function collectHistory() {
  const items = await chrome.history.search({ text: "", startTime: 0, maxResults: HISTORY_CAP });
  return items.map(item => ({ title: item.title ?? "", url: item.url ?? "", visited: item.lastVisitTime, visits: item.visitCount ?? 0 }));
}

export function historyCsv(rows) {
  const lines = ["title,url,last_visit,visit_count"];
  for (const row of rows) lines.push([row.title, row.url, row.visited ? new Date(row.visited).toISOString() : "", row.visits].map(csvCell).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

export function historyHtml(rows) {
  const cells = rows.map(row => `    <tr><td>${escapeHtml(row.title || row.url)}</td><td><a href="${escapeHtml(row.url)}">${escapeHtml(row.url)}</a></td><td>${escapeHtml(row.visited ? new Date(row.visited).toLocaleString() : "")}</td><td>${row.visits}</td></tr>`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>KeyBit history export</title>
<style>
  body { margin: 32px; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  h1 { font-size: 18px; }
  p { color: #666; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 6px 10px; border-bottom: 1px solid #ddd; text-align: left; vertical-align: top; word-break: break-word; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .4px; }
</style>
</head>
<body>
<h1>Browsing history</h1>
<p>Exported from KeyBit on ${escapeHtml(new Date().toLocaleString())} — ${rows.length} entr${rows.length === 1 ? "y" : "ies"}${rows.length >= HISTORY_CAP ? " (oldest entries trimmed)" : ""}.</p>
<table>
  <thead><tr><th>Title</th><th>URL</th><th>Last visit</th><th>Visits</th></tr></thead>
  <tbody>
${cells.join("\n")}
  </tbody>
</table>
</body>
</html>
`;
}
