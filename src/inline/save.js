const token = location.hash.slice(1);
const save = document.querySelector("#save");
let finished = false;
async function request(type) {
  const response = await chrome.runtime.sendMessage({ type, token });
  if (!response?.ok) throw new Error(response?.error ?? "Save prompt unavailable. Sign in again.");
  return response.data;
}
function close() { finished = true; parent.postMessage({ type: "KEYBIT_SAVE_CLOSE", token }, "*"); }
function resize() {
  requestAnimationFrame(() => parent.postMessage({ type: "KEYBIT_SAVE_RESIZE", token,
    height: document.querySelector("header").offsetHeight + document.querySelector("main").scrollHeight + document.querySelector("footer").offsetHeight + 2 }, "*"));
}
function fail(error) {
  save.disabled = true;
  document.querySelector("#site").textContent = "";
  document.querySelector("#username").textContent = "";
  document.querySelector(".credential").hidden = true;
  const status = document.querySelector("#status"); status.hidden = false; status.textContent = error.message;
  resize();
}
async function dismiss() { await request("SAVE_PROMPT_DISMISS").catch(() => {}); close(); }
async function refresh() {
  try {
    const state = await request("SAVE_PROMPT_STATE");
    if (finished) return;
    document.querySelector("#heading").textContent = state.update ? "Update this password?" : "Save this password?";
    document.querySelector("#site").textContent = state.origin;
    document.querySelector("#username").textContent = state.username || "No username";
    document.querySelector("#avatar").textContent = [...(state.username || new URL(state.origin).host).trim()][0]?.toLocaleUpperCase() || "•";
    save.textContent = state.update ? "Update password" : "Save password";
    save.disabled = false; resize();
  } catch (error) { if (!finished) fail(error); }
}
save.addEventListener("click", async () => {
  save.disabled = true;
  try { await request("SAVE_PROMPT_CONFIRM"); close(); } catch (error) { fail(error); }
});
document.querySelector("#dismiss").addEventListener("click", () => void dismiss());
document.querySelector("#close").addEventListener("click", () => void dismiss());
document.addEventListener("keydown", event => { if (event.key === "Escape") void dismiss(); });
chrome.runtime.onMessage.addListener(message => { if (message?.event === "vault-state" && !message.state?.unlocked) close(); });
const poll = setInterval(() => { if (!document.hidden && !finished) void refresh(); }, 5000);
const sizes = new ResizeObserver(resize);
sizes.observe(document.body);
window.addEventListener("pagehide", () => { clearInterval(poll); sizes.disconnect(); finished = true; });
await refresh();
