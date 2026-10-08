import { element, siteTile, needsReload } from "../ui/common.js";
const token = location.hash.slice(1);
/** @type {(selector: string) => any} Page elements are looked up by known IDs. */
const $ = selector => document.querySelector(selector);
const save = $("#save");
const alternate = $("#alternate");
let finished = false;
let state = null;
async function request(type, args = {}) {
  const response = await chrome.runtime.sendMessage({ type, token, ...args });
  if (!response?.ok) throw new Error(response?.error ?? "Passkey prompt unavailable. Try again.");
  return response.data;
}
function close() { finished = true; parent.postMessage({ type: "KEYBIT_PASSKEY_CLOSE", token }, "*"); }
function resize() {
  requestAnimationFrame(() => parent.postMessage({ type: "KEYBIT_PASSKEY_RESIZE", token,
    height: $("header").offsetHeight + $("main").scrollHeight + $("footer").offsetHeight + 2 }, "*"));
}
function fail(error) {
  save.disabled = true; alternate.hidden = true;
  for (const selector of [".credential", "#explain", "#choices"]) $(selector).hidden = true;
  const status = $("#status"); status.hidden = false; status.textContent = error.message;
  resize();
}
function render() {
  $("#site").textContent = state.site;
  $("#tile").replaceWith(Object.assign(siteTile(state.site, "", state.origin), { id: "tile" }));
  if (state.kind === "create") {
    $("#heading").textContent = "Save a passkey?";
    $("#username").textContent = state.user.displayName || state.user.name;
    $("#caption").textContent = state.user.name === state.user.displayName ? state.site : state.user.name;
    $("#explain").textContent = "The passkey stays in your encrypted vault on this device — it is never synced or sent anywhere.";
    save.textContent = "Save passkey";
  } else {
    $("#heading").textContent = "Sign in with a passkey?";
    const [first] = state.candidates;
    if (state.candidates.length === 1) {
      $("#username").textContent = first.userName;
      $("#caption").textContent = state.site;
      save.textContent = `Sign in as ${first.userName}`;
    } else {
      $("#username").textContent = `${state.candidates.length} passkeys`;
      $("#caption").textContent = state.site;
      $("#choice-list").replaceChildren(...state.candidates.map((candidate, index) => element("label", { className: "choice" },
        element("input", { type: "radio", name: "passkey", value: candidate.credentialId, checked: index === 0 }),
        element("span", { className: "details" }, element("span", { className: "primary" }, candidate.userName)))));
      $("#choices").hidden = false;
      save.textContent = "Sign in";
    }
    $("#explain").textContent = "This site asked for a passkey. KeyBit signs you in with the one saved in your vault.";
  }
  save.disabled = false;
  resize();
}
async function confirm() {
  save.disabled = true; alternate.disabled = true;
  const credentialId = $('input[name="passkey"]:checked')?.value;
  try { await request("PASSKEY_CONFIRM", { action: "keybit", credentialId }); close(); }
  catch (error) { fail(error); }
  finally { alternate.disabled = false; }
}
async function device() { save.disabled = true; try { await request("PASSKEY_CONFIRM", { action: "device" }); } catch {} close(); }
async function dismiss() { await request("PASSKEY_DISMISS").catch(() => {}); close(); }
save.addEventListener("click", () => void confirm());
alternate.addEventListener("click", () => void device());
$("#dismiss").addEventListener("click", () => void dismiss());
$("#close").addEventListener("click", () => void dismiss());
document.addEventListener("keydown", event => { if (event.key === "Escape") void dismiss(); });
chrome.runtime.onMessage.addListener(message => { if (message?.event === "vault-state" && !message.state?.unlocked) close(); });
const sizes = new ResizeObserver(resize);
sizes.observe(document.body);
window.addEventListener("pagehide", () => { sizes.disconnect(); finished = true; });
if (needsReload()) fail(new Error("KeyBit was updated but not reloaded yet. Open the KeyBit popup and choose Reload KeyBit."));
else {
  try { state = await request("PASSKEY_STATE"); if (!finished) render(); }
  catch (error) { if (!finished) fail(error); }
}
