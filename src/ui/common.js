import { VERSION } from "../version.js";

// True when this page's files are newer than the running extension: the folder was updated
// but KeyBit was not reloaded, so the background still runs the old code.
export function needsReload() {
  try { return VERSION !== chrome.runtime.getManifest().version; } catch { return false; }
}
// A banner with a one-click reload. Reloading restarts KeyBit's background, so the vault locks.
export function showReloadBanner(container) {
  if (!needsReload() || container.querySelector(".update-banner")) return false;
  const reload = element("button", { type: "button", className: "primary-button", id: "update-reload" }, "Reload KeyBit");
  reload.addEventListener("click", () => chrome.runtime.reload());
  container.prepend(element("div", { className: "update-banner", id: "update-banner", role: "alert" },
    element("p", {}, element("strong", {}, "Finish updating KeyBit. "),
      `Version ${VERSION} is installed, but ${chrome.runtime.getManifest().version} is still running. Reload once to finish. Your logins are safe; you will unlock again.`),
    reload));
  return true;
}
/** Elements matching a selector, as an array (page code looks them up by known selectors). @returns {any[]} */
export function all(selector, root = document) { return [...root.querySelectorAll(selector)]; }
export function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== false && value != null) node.setAttribute(name === "className" ? "class" : name, value === true ? "" : String(value));
  }
  for (const child of children.flat()) if (child != null) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
let toastTimer;
export function announce(text, error = false) {
  const node = /** @type {HTMLElement} */ (document.querySelector("#message"));
  clearTimeout(toastTimer);
  node.textContent = text; node.classList.toggle("error", error); node.hidden = !text;
  node.onclick = () => { node.hidden = true; };
  if (text && !error) toastTimer = setTimeout(() => { node.hidden = true; }, 4000);
}
export async function openPage(path) { await chrome.tabs.create({ url: chrome.runtime.getURL(path) }); }
export function clearFields(container) {
  for (const input of container.querySelectorAll("input, textarea")) if (!["checkbox", "button"].includes(input.type)) input.value = "";
}
export async function copyText(value) {
  try { await navigator.clipboard.writeText(value); }
  catch { throw new Error("Could not copy. Keep this window focused and try again."); }
}
// A site tile: the first letter of the project folder or host, on a tone derived from the whole label.
export function siteTile(label, className = "") {
  const clean = String(label ?? "").replace(/^www\./, "");
  let hash = 0;
  for (const character of clean) hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  const letter = [...(clean.split("/")[1] || clean)][0]?.toLocaleUpperCase() || "•";
  return element("span", { className: `tile tone-${hash % 8} ${className}`.trim(), "aria-hidden": "true" }, letter);
}
const ICONS = {
  key: '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3M16 7l3 3M14 9l2 2"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  fill: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  note: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
  folder: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 9.6l6.2-.9z"/>'
};
// Inline SVG icons are built from fixed markup above, never from user data.
export function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONS[name];
  return svg;
}
export function iconButton(name, label, attributes = {}) {
  return element("button", { type: "button", className: "icon-button", title: label, "aria-label": label, ...attributes }, icon(name));
}
// "just now", "5 min ago", "3 days ago": short, for last-used hints.
export function relativeTime(time, now = Date.now()) {
  const minutes = Math.round((now - time) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days} day${days === 1 ? "" : "s"} ago` : new Date(time).toLocaleDateString();
}
