import { element, all, siteTile, icon, iconButton, needsReload, relativeTime } from "../ui/common.js";
/** @type {(selector: string) => any} */
const $ = selector => document.querySelector(selector);
import { loadPrefs, savePrefs, generate } from "../generator/prefs.js";

const token = location.hash.slice(1);
const accounts = $("#accounts");
let session = null;
let rendering = 0;
let generated = "";
let prefs = null;
let filter = "";
let last = null;
let codeTimer = null;
async function request(type, args = {}) {
  const response = await chrome.runtime.sendMessage({ type, token, ...args });
  if (!response?.ok) throw new Error(response?.error ?? "Suggestions unavailable. Click the login field again.");
  return response.data;
}
function close() { parent.postMessage({ type: "KEYBIT_CLOSE", token }, "*"); }
function resize() {
  requestAnimationFrame(() => {
    const height = $("header").offsetHeight + accounts.scrollHeight + $("footer").offsetHeight + $("#status").offsetHeight + 2;
    parent.postMessage({ type: "KEYBIT_RESIZE", token, height }, "*");
  });
}
function status(text) { const node = $("#status"); node.textContent = text; node.hidden = !text; resize(); }
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
// The visible text is the button's accessible name; a hidden prefix says what choosing it does.
function fillButton(item, action, secondary, extra = null, tile = null) {
  const button = element("button", { type: "button", className: "account" }, element("span", { className: "visually-hidden" }, `${action} `), tile ?? siteTile(item.scope || item.name, "", item.urls?.[0]),
    element("span", { className: "details" }, element("span", { className: "primary" }, item.username || item.name), element("span", { className: "secondary" }, secondary)), extra);
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await request("PANEL_FILL", { id: item.id, session }); close(); }
    catch (error) { status(error.message); await refresh(); }
  });
  return button;
}
function accountButton(item) {
  const secondary = item.continue ? "Chosen on the previous step" : [item.username ? item.name : "No username", item.lastUsedAt ? `used ${relativeTime(item.lastUsedAt)}` : null].filter(Boolean).join(" · ");
  const badge = item.continue ? element("span", { className: "badge continue" }, "Continue")
    : item.environment !== "other" ? element("span", { className: `badge ${item.environment}` }, item.environment === "development" ? "Dev" : item.environment) : null;
  return fillButton(item, "Fill", secondary, badge);
}
function codeButton(item) {
  const half = Math.ceil(item.code.length / 2);
  return fillButton(item, "Fill the 2FA code for", item.name,
    element("span", { className: "code" }, element("strong", {}, `${item.code.slice(0, half)} ${item.code.slice(half)}`), element("span", { className: "remaining" }, `${item.remaining}s`)));
}
// Sign-up and change-password fields: a password generated here, in the extension frame, with the user's generator settings.
async function generator(state) {
  prefs ??= await loadPrefs();
  if (!generated) generated = await generate(prefs);
  const use = element("button", { type: "button", className: "account", id: "use-generated" },
    element("span", { className: "tile tone-key", "aria-hidden": "true" }, icon("key")),
    element("span", { className: "details" }, element("span", { className: "primary" }, "Use a strong password"),
      element("code", { className: "secondary generated" }, generated)));
  use.addEventListener("click", async () => {
    use.disabled = true;
    try { await request("PANEL_FILL_NEW", { password: generated }); close(); }
    catch (error) { status(error.message); use.disabled = false; }
  });
  const again = iconButton("refresh", "Generate another", { id: "regenerate" });
  again.addEventListener("click", async () => { generated = ""; await render(last); resize(); $("#regenerate")?.focus(); });
  const memorable = prefs.mode === "memorable";
  const toggle = element("button", { type: "button", className: "chip", id: "symbols", "aria-pressed": String(memorable || prefs.symbols) }, memorable ? "Words" : "Symbols");
  toggle.addEventListener("click", async () => {
    prefs = memorable ? { ...prefs, mode: "random" } : { ...prefs, symbols: !prefs.symbols };
    await savePrefs(prefs); generated = ""; await render(last); resize(); $("#symbols")?.focus();
  });
  return [element("div", { className: "generator-row" }, use, again),
    element("div", { className: "generator-options" }, toggle,
      element("span", {}, state.unlocked ? "KeyBit offers to save it after you submit." : "Unlock KeyBit to save it after you submit."))];
}
async function render(result) {
  clearTimeout(codeTimer);
  if (result.mode === "new") { accounts.replaceChildren(...await generator(result.state)); return; }
  if (!result.state.unlocked) {
    accounts.replaceChildren(result.state.exists ? message("KeyBit is locked", "Unlock to fill a saved login on this site.", "Unlock KeyBit")
      : message("Set up KeyBit", "Create your vault to save and fill logins.", "Create vault"));
    return;
  }
  if (result.mode === "otp") {
    accounts.replaceChildren(...result.items.map(codeButton));
    // Fetch fresh codes when the current ones expire.
    const soonest = Math.min(...result.items.map(item => item.remaining));
    if (Number.isFinite(soonest)) codeTimer = setTimeout(() => void refresh(), soonest * 1000 + 250);
    return;
  }
  // Cards and identities fill anywhere — they carry no site binding.
  if (result.mode === "card" || result.mode === "identity") {
    accounts.replaceChildren(...result.items.map(item => {
      const secondary = item.type === "card" ? `${item.brand} ···· ${item.last4}${item.cardholder ? ` · ${item.cardholder}` : ""}` : [item.fullName, item.city, item.country].filter(Boolean).join(" · ");
      return fillButton(item, `Fill this ${item.type}`, secondary, null, element("span", { className: "tile tone-key", "aria-hidden": "true" }, icon(item.type === "card" ? "card" : "id")));
    }));
    if (!result.items.length) accounts.append(message("Nothing to fill", `No ${result.mode === "card" ? "cards" : "identities"} in the vault yet.`));
    return;
  }
  const needle = filter.trim().toLocaleLowerCase();
  const shown = needle ? result.items.filter(item => `${item.username} ${item.name}`.toLocaleLowerCase().includes(needle)) : result.items;
  accounts.replaceChildren(...(result.warning ? [element("div", { className: "phish-warning", role: "alert" }, icon("alert"), element("span", {}, result.warning))] : []), ...shown.map(accountButton));
  if (!result.items.length) accounts.append(message("No saved logins here", "Sign in normally and KeyBit will offer to save it."));
  else if (!shown.length) accounts.append(message("No match", `No saved login matches “${filter.trim()}”.`));
}
async function refresh() {
  const current = ++rendering;
  if (needsReload()) {
    accounts.replaceChildren(message("Finish updating KeyBit", "KeyBit was updated but not reloaded yet. Open KeyBit and choose Reload KeyBit.", "Open KeyBit"));
    resize(); return;
  }
  try {
    const result = await request("PANEL_STATE");
    if (current !== rendering) return;
    session = result.state.session;
    $("#site").textContent = result.site;
    // Polling keeps the panel's token alive; the generator only redraws when the lock state changes.
    const unchanged = result.mode === "new" && last?.mode === "new" && last.state.unlocked === result.state.unlocked;
    last = { ...result, state: { ...result.state } };
    if (unchanged) return;
    const focused = accounts.contains(document.activeElement) ? all("button", accounts).indexOf(document.activeElement) : -1;
    await render(result);
    if (focused >= 0) all("button", accounts)[focused]?.focus();
  } catch (error) { session = null; accounts.replaceChildren(message("Suggestions unavailable", error.message)); }
  finally { resize(); }
}
function move(step) {
  const buttons = all("button", accounts);
  if (!buttons.length) return;
  const index = buttons.indexOf(document.activeElement);
  buttons[(index + step + buttons.length) % buttons.length].focus();
}
$("#close").addEventListener("click", close);
$("#open").addEventListener("click", openKeyBit);
document.addEventListener("keydown", event => {
  if (event.key === "Escape") close();
  else if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); move(event.key === "ArrowDown" ? 1 : -1); }
});
window.addEventListener("message", event => {
  if (event.source !== parent) return;
  // The content script hands over keyboard focus when the user presses ArrowDown in the login field.
  if (event.data?.type === "KEYBIT_KEYBOARD" && !accounts.contains(document.activeElement)) accounts.querySelector("button")?.focus();
  // Typing in the username field narrows the list (the page could send this too; it only filters what is shown).
  if (event.data?.type === "KEYBIT_FILTER" && typeof event.data.text === "string" && last) { filter = event.data.text.slice(0, 200); void render(last).then(resize); }
});
chrome.runtime.onMessage.addListener(message => {
  if (message?.event !== "vault-state") return;
  session = null; ++rendering;
  if (!message.state?.unlocked && last?.mode !== "new") accounts.replaceChildren();
  if (last?.mode === "new") last = null;
  void refresh();
});
// Light polling keeps the panel's short-lived token alive; changes arrive as vault-state events.
const poll = setInterval(() => { if (!document.hidden) void refresh(); }, 20000);
window.addEventListener("pagehide", () => { clearInterval(poll); clearTimeout(codeTimer); session = null; generated = ""; accounts.replaceChildren(); });
await refresh();
