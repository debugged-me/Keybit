import { element, siteTile, icon, iconButton, needsReload } from "../ui/common.js";
import { generatePassword } from "../generator/password-generator.js";
const token = location.hash.slice(1);
const accounts = document.querySelector("#accounts");
let session = null;
let rendering = 0;
let generated = "";
let symbols = true;
async function request(type, args = {}) {
  const response = await chrome.runtime.sendMessage({ type, token, ...args });
  if (!response?.ok) throw new Error(response?.error ?? "Suggestions unavailable. Click the login field again.");
  return response.data;
}
function close() { parent.postMessage({ type: "KEYBIT_CLOSE", token }, "*"); }
function resize() {
  requestAnimationFrame(() => {
    const height = document.querySelector("header").offsetHeight + accounts.scrollHeight + document.querySelector("footer").offsetHeight + document.querySelector("#status").offsetHeight + 2;
    parent.postMessage({ type: "KEYBIT_RESIZE", token, height }, "*");
  });
}
function status(text) { const node = document.querySelector("#status"); node.textContent = text; node.hidden = !text; resize(); }
function openKeyBit() { void request("PANEL_OPEN").catch(error => status(error.message)); }
function message(title, text, action) {
  const box = element("div", { className: "empty" }, element("h2", {}, title), element("p", {}, text));
  if (action) {
    const button = element("button", { type: "button", className: "primary-button" }, action);
    button.addEventListener("click", openKeyBit);
    box.append(button);
  }
  return box;
}
function accountButton(item) {
  const label = item.username || item.name;
  const button = element("button", { type: "button", className: "account", "aria-label": `Fill ${label} (${item.name})` },
    siteTile(item.scope || item.name),
    element("span", { className: "details" }, element("span", { className: "primary" }, label),
      element("span", { className: "secondary" }, item.username ? item.name : "No username")),
    item.environment !== "other" ? element("span", { className: `badge ${item.environment}` }, item.environment === "development" ? "Dev" : item.environment) : null);
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await request("PANEL_FILL", { id: item.id, session }); close(); }
    catch (error) { status(error.message); await refresh(); }
  });
  return button;
}
// Sign-up and change-password fields: a password generated here, in the extension frame.
function generator(state) {
  if (!generated) generated = generatePassword({ length: 20, symbols });
  const use = element("button", { type: "button", className: "account", id: "use-generated", "aria-label": "Use the suggested strong password" },
    element("span", { className: "tile tone-key", "aria-hidden": "true" }, icon("key")),
    element("span", { className: "details" }, element("span", { className: "primary" }, "Use a strong password"),
      element("code", { className: "secondary generated" }, generated)));
  use.addEventListener("click", async () => {
    use.disabled = true;
    try { await request("PANEL_FILL_NEW", { password: generated }); close(); }
    catch (error) { status(error.message); use.disabled = false; }
  });
  const again = iconButton("refresh", "Generate another", { id: "regenerate" });
  again.addEventListener("click", () => { generated = ""; render(state); document.querySelector("#regenerate")?.focus(); });
  const toggle = element("button", { type: "button", className: "chip", id: "symbols", "aria-pressed": String(symbols) }, "Symbols");
  toggle.addEventListener("click", () => { symbols = !symbols; generated = ""; render(state); document.querySelector("#symbols")?.focus(); });
  return [element("div", { className: "generator-row" }, use, again),
    element("div", { className: "generator-options" }, toggle,
      element("span", {}, state.unlocked ? "KeyBit offers to save it after you submit." : "Unlock KeyBit to save it after you submit."))];
}
function render(result) {
  if (result.mode === "new") { accounts.replaceChildren(...generator(result.state)); resize(); return; }
  if (!result.state.unlocked) {
    accounts.replaceChildren(result.state.exists ? message("KeyBit is locked", "Unlock to fill a saved login on this site.", "Unlock KeyBit")
      : message("Set up KeyBit", "Create your vault to save and fill logins.", "Create vault"));
    return;
  }
  accounts.replaceChildren(...result.items.map(accountButton));
  if (!result.items.length) accounts.append(message("No saved logins here", "Sign in normally and KeyBit will offer to save it."));
}
let last = null;
async function refresh() {
  const current = ++rendering;
  if (needsReload()) {
    // Files were updated without reloading KeyBit; the popup offers the one-click reload.
    accounts.replaceChildren(message("Finish updating KeyBit", "KeyBit was updated but not reloaded yet. Open KeyBit and choose Reload KeyBit.", "Open KeyBit"));
    resize(); return;
  }
  try {
    const result = await request("PANEL_STATE");
    if (current !== rendering) return;
    session = result.state.session;
    document.querySelector("#site").textContent = result.site;
    // Polling keeps the panel's token alive; the generator only redraws when the lock state changes.
    const unchanged = result.mode === "new" && last?.mode === "new" && last.state.unlocked === result.state.unlocked;
    last = { ...result, state: { ...result.state } };
    if (unchanged) return;
    const focused = accounts.contains(document.activeElement) ? [...accounts.querySelectorAll("button")].indexOf(document.activeElement) : -1;
    render(result);
    if (focused >= 0) accounts.querySelectorAll("button")[focused]?.focus();
  } catch (error) { session = null; accounts.replaceChildren(message("Suggestions unavailable", error.message)); }
  finally { resize(); }
}
function move(step) {
  const buttons = [...accounts.querySelectorAll("button")];
  if (!buttons.length) return;
  const index = buttons.indexOf(document.activeElement);
  buttons[(index + step + buttons.length) % buttons.length].focus();
}
document.querySelector("#close").addEventListener("click", close);
document.querySelector("#open").addEventListener("click", openKeyBit);
document.addEventListener("keydown", event => {
  if (event.key === "Escape") close();
  else if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); move(event.key === "ArrowDown" ? 1 : -1); }
});
// The content script hands over keyboard focus when the user presses ArrowDown in the login field.
window.addEventListener("message", event => {
  if (event.source === parent && event.data?.type === "KEYBIT_KEYBOARD" && !accounts.contains(document.activeElement)) accounts.querySelector("button")?.focus();
});
chrome.runtime.onMessage.addListener(message => {
  if (message?.event !== "vault-state") return;
  session = null; ++rendering;
  if (!message.state?.unlocked && last?.mode !== "new") accounts.replaceChildren();
  if (last?.mode === "new") last = null;
  void refresh();
});
const poll = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
window.addEventListener("pagehide", () => { clearInterval(poll); session = null; generated = ""; accounts.replaceChildren(); });
await refresh();
