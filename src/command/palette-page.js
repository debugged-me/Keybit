// The palette's document. Authenticates to the worker with the one-time token in the fragment —
// commands are fetched and run through it, so a page script can never reach the vault directly.
const token = location.hash.slice(1);
const send = (type, payload) => chrome.runtime.sendMessage({ type, ...payload }).catch(() => null);
const queryInput = document.getElementById("query");
const resultsEl = document.getElementById("results");
const statusEl = document.getElementById("status");
let commands = [];
let active = 0;
let generation = 0;
let pendingConfirm = null;

const ICONS = {
  fill: '<path d="M10 3a5 5 0 0 0-4.9 6.2L2 12.3V15h2v-1.6l1.2-1.2A5 5 0 1 0 10 3Zm0 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z"/>',
  key: '<path d="M7 3a5 5 0 0 0-4.9 6.2L.5 10.8V13h2v-1.2l1-1A5 5 0 1 0 7 3Zm0 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z"/>',
  lock: '<path d="M10 2a4 4 0 0 0-4 4v3H5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1h-1V6a4 4 0 0 0-4-4Zm0 2a2 2 0 0 1 2 2v3H8V6a2 2 0 0 1 2-2Z"/>',
  search: '<circle cx="9" cy="9" r="5.5"/><path d="m13.5 13.5 4 4"/>',
  globe: '<circle cx="10" cy="10" r="7.5"/><path d="M2.5 10h15M10 2.5c-4.2 4.2-4.2 10.8 0 15m0-15c4.2 4.2 4.2 10.8 0 15"/>',
  eye: '<path d="M10 4.5C5.5 4.5 2.2 7.6 1 10c1.2 2.4 4.5 5.5 9 5.5s7.8-3.1 9-5.5c-1.2-2.4-4.5-5.5-9-5.5Zm0 9a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z"/>',
  note: '<path d="M4 2h8l4 4v12H4V2Zm7 1.5V7h3.5"/>',
  external: '<path d="M8 3H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4h-2v3H5V5h3V3Zm5 0h4v4l-1.5-1.5-4.7 4.7-1.4-1.4 4.7-4.7L13 3Z"/>',
  card: '<rect x="2" y="5" width="16" height="11" rx="2"/><path d="M2 8h16"/>',
  id: '<rect x="3" y="4" width="14" height="12" rx="2"/><circle cx="7.5" cy="9.5" r="1.8"/><path d="M11.5 8.5h3.5M11.5 11h3.5M4.5 13.5c.6-1.4 1.7-2 3-2s2.4.6 3 2"/>',
  shield: '<path d="M10 1.5 3 4v5c0 4.4 3 7.6 7 9 4-1.4 7-4.6 7-9V4l-7-2.5Z"/>'
};
function icon(name) {
  const glyph = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  glyph.setAttribute("viewBox", "0 0 20 20");
  glyph.setAttribute("fill", "none");
  glyph.setAttribute("stroke", "currentColor");
  glyph.setAttribute("stroke-width", "1.6");
  glyph.classList.add("glyph");
  glyph.setAttribute("aria-hidden", "true");
  glyph.innerHTML = ICONS[name] ?? ICONS.key;
  return glyph;
}

function close() {
  parent.postMessage({ type: "KEYBIT_PALETTE_CLOSE", token }, "*");
}
async function refresh() {
  const gen = ++generation;
  const response = await send("PALETTE_QUERY", { token, query: /** @type {HTMLInputElement} */ (queryInput).value });
  if (gen !== generation || !response?.ok) return;
  commands = response.data.commands;
  statusEl.textContent = response.data.locked ? "Vault locked" : "";
  if (commands.length === 0) {
    resultsEl.innerHTML = "";
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No matching commands";
    resultsEl.append(empty);
    active = -1;
    return;
  }
  if (pendingConfirm && !commands.some(command => command.id === pendingConfirm.id && command.env === pendingConfirm.env && command.project === pendingConfirm.project))
    pendingConfirm = null;
  render();
}
function render() {
  resultsEl.innerHTML = "";
  active = Math.min(Math.max(active, 0), commands.length - 1);
  commands.forEach((command, index) => {
    const row = document.createElement("li");
    row.className = `row${command.production ? " production" : ""}`;
    row.id = `cmd-${index}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", index === active ? "true" : "false");
    row.append(icon(command.icon));
    const main = document.createElement("span");
    main.className = "main";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = command.label;
    main.append(label);
    if (command.hint) {
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = command.hint;
      main.append(hint);
    }
    row.append(main);
    if (command.production) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "Prod";
      row.append(tag);
    }
    row.addEventListener("click", () => void run(command));
    row.addEventListener("mousemove", () => { if (active !== index) { active = index; render(); } });
    resultsEl.append(row);
  });
  if (commands.length) queryInput.setAttribute("aria-activedescendant", `cmd-${active}`);
  else queryInput.removeAttribute("aria-activedescendant");
}
async function run(command, confirmed = false) {
  const response = await send("PALETTE_RUN", { token, command, confirmed });
  if (!response?.ok) { statusEl.textContent = response?.error || "Could not run that"; return; }
  if (response.data.confirm) {
    // Production switches confirm inline: press Enter again to open.
    pendingConfirm = command;
    statusEl.textContent = "Production — press Enter again to confirm";
    return;
  }
  pendingConfirm = null;
  // "Generate password" returns the secret to this extension page for the copy — the worker has
  // already armed the 30-second clipboard clear.
  if (response.data.password) {
    try { await navigator.clipboard.writeText(response.data.password); statusEl.textContent = "Password copied"; }
    catch { statusEl.textContent = "Generated — copy failed"; }
  }
  if (response.data.message) statusEl.textContent = response.data.message;
  if (response.data.close !== false) close();
}
queryInput.addEventListener("input", () => void refresh());
queryInput.addEventListener("keydown", event => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (!commands.length) return;
    active = (active + (event.key === "ArrowDown" ? 1 : -1) + commands.length) % commands.length;
    render();
    resultsEl.children[active]?.scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter") {
    event.preventDefault();
    if (pendingConfirm) void run(pendingConfirm, true);
    else if (commands[active]) void run(commands[active]);
  } else if (event.key === "Escape") {
    event.preventDefault();
    if (pendingConfirm) { pendingConfirm = null; statusEl.textContent = ""; }
    else close();
  }
});
document.getElementById("backdrop").addEventListener("mousedown", event => { if (/** @type {HTMLElement} */ (event.target).id === "backdrop") close(); });
queryInput.focus();
void refresh();
