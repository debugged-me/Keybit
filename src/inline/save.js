import { element, siteTile, needsReload } from "../ui/common.js";
const token = location.hash.slice(1);
/** @type {(selector: string) => any} Page elements are looked up by known IDs. */
const $ = selector => document.querySelector(selector);
const save = $("#save");
const alternate = $("#alternate");
let finished = false;
let card = null;
let choosing = false;
async function request(type, args = {}) {
  const response = await chrome.runtime.sendMessage({ type, token, ...args });
  if (!response?.ok) throw new Error(response?.error ?? "Save prompt unavailable. Sign in again.");
  return response.data;
}
function close() { finished = true; parent.postMessage({ type: "KEYBIT_SAVE_CLOSE", token }, "*"); }
function resize() {
  requestAnimationFrame(() => parent.postMessage({ type: "KEYBIT_SAVE_RESIZE", token,
    height: $("header").offsetHeight + $("main").scrollHeight + $("footer").offsetHeight + 2 }, "*"));
}
function fail(error) {
  save.disabled = true; alternate.hidden = true;
  for (const selector of [".credential", "#explain", "#choices"]) $(selector).hidden = true;
  const status = $("#status"); status.hidden = false; status.textContent = error.message;
  resize();
}
function explain(...parts) {
  const node = $("#explain");
  node.replaceChildren(...parts.map(part => typeof part === "string" ? part : element("strong", {}, part.strong)));
  node.hidden = false;
}
function selected() { return $('input[name="target"]:checked')?.value; }
// Decides the card's wording and buttons. An update always names the login it changes.
function render(state) {
  card = state;
  $("#site").textContent = state.site;
  $("#username").textContent = state.username || "No username";
  $("#tile").replaceWith(Object.assign(siteTile(state.site, "", state.origin), { id: "tile" }));
  $("#explain").hidden = true; $("#choices").hidden = true; alternate.hidden = true;
  const [first] = state.candidates;
  const set = (heading, primary, action, secondary, secondaryAction) => {
    $("#heading").textContent = heading;
    save.textContent = primary; save.dataset.action = action;
    if (secondary) { alternate.textContent = secondary; alternate.dataset.action = secondaryAction; alternate.hidden = false; }
  };
  if (!state.update) set("Save this password?", "Save password", "new");
  else if (choosing || (!state.preferNew && state.candidates.length > 1)) {
    $("#choice-list").replaceChildren(...state.candidates.map((candidate, index) => element("label", { className: "choice" },
      element("input", { type: "radio", name: "target", value: candidate.id, checked: index === 0 }), siteTile(candidate.scope, "", candidate.url),
      element("span", { className: "details" }, element("span", { className: "primary" }, candidate.name),
        element("span", { className: "secondary" }, candidate.environment === "other" ? candidate.scope : `${candidate.scope} · ${candidate.environment}`)))));
    $("#choices").hidden = false;
    set("Update which login?", "Update selected", "update", state.kind === "change" ? null : "Save as new", "new");
  } else if (!state.preferNew) {
    set("Update this password?", "Update password", "update", state.kind === "change" ? null : "Save as new", "new");
    explain("Replaces the password of ", { strong: first.name }, first.name === first.scope ? ". The old one stays in its history." : ` (${first.scope}). The old one stays in its history.`);
  } else {
    // The only match is a broader login, such as a whole-server login seen from another project folder.
    set("Save as a new login?", "Save as new", "new", state.candidates.length > 1 ? "Update existing…" : `Update ${first.name}`, state.candidates.length > 1 ? "choose" : "update");
    explain("You already use this username for ", { strong: first.scope }, ". Saving a new login keeps both passwords.");
  }
  save.disabled = false; resize();
}
async function refresh() {
  if (needsReload()) { fail(new Error("KeyBit was updated but not reloaded yet. Open the KeyBit popup and choose Reload KeyBit, then sign in again to save.")); return; }
  try {
    const state = await request("SAVE_PROMPT_STATE");
    if (!finished) render(state);
  } catch (error) { if (!finished) fail(error); }
}
async function confirm(action) {
  if (action === "choose") { choosing = true; render(card); return; }
  const id = action === "update" ? (choosing || !$("#choices").hidden ? selected() : card.candidates[0]?.id) : undefined;
  save.disabled = true; alternate.disabled = true;
  try { await request("SAVE_PROMPT_CONFIRM", { action, id }); close(); }
  catch (error) { fail(error); }
  finally { alternate.disabled = false; }
}
async function dismiss() { await request("SAVE_PROMPT_DISMISS").catch(() => {}); close(); }
save.addEventListener("click", () => void confirm(save.dataset.action));
alternate.addEventListener("click", () => void confirm(alternate.dataset.action));
$("#dismiss").addEventListener("click", () => void dismiss());
$("#close").addEventListener("click", () => void dismiss());
document.addEventListener("keydown", event => { if (event.key === "Escape") void dismiss(); });
chrome.runtime.onMessage.addListener(message => { if (message?.event === "vault-state" && !message.state?.unlocked) close(); });
// Polling keeps the prompt's binding fresh; it redraws only before the user has picked a target.
const poll = setInterval(() => { if (!document.hidden && !finished && !choosing && $("#choices").hidden) void refresh(); }, 5000);
const sizes = new ResizeObserver(resize);
sizes.observe(document.body);
window.addEventListener("pagehide", () => { clearInterval(poll); sizes.disconnect(); finished = true; });
await refresh();
