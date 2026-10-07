import { element } from "../ui/common.js";
const token = location.hash.slice(1);
const accounts = document.querySelector("#accounts");
let session = null;
let rendering = 0;
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
    element("span", { className: "avatar", "aria-hidden": "true" }, [...label.trim()][0]?.toLocaleUpperCase() || "•"),
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
async function refresh() {
  const current = ++rendering;
  try {
    const result = await request("PANEL_STATE");
    if (current !== rendering) return;
    session = result.state.session;
    document.querySelector("#site").textContent = new URL(result.origin).host;
    const focused = accounts.contains(document.activeElement) ? [...accounts.querySelectorAll(".account")].indexOf(document.activeElement) : -1;
    accounts.replaceChildren();
    if (!result.state.unlocked) {
      accounts.append(result.state.exists ? message("KeyBit is locked", "Unlock to fill a saved login on this site.", "Unlock KeyBit")
        : message("Set up KeyBit", "Create your vault to save and fill logins.", "Create vault"));
      return;
    }
    accounts.append(...result.items.map(accountButton));
    if (!result.items.length) accounts.append(message("No saved logins for this site", "Sign in normally and KeyBit will offer to save it."));
    if (focused >= 0) accounts.querySelectorAll(".account")[Math.min(focused, result.items.length - 1)]?.focus();
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
  if (!message.state?.unlocked) accounts.replaceChildren();
  void refresh();
});
const poll = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
window.addEventListener("pagehide", () => { clearInterval(poll); session = null; accounts.replaceChildren(); });
await refresh();
