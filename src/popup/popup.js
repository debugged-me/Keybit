import { VaultClient } from "../ui/client.js";
import { renderAuth } from "../ui/auth.js";
import { loginRow } from "../ui/items.js";
import { element, announce, openPage, siteTile, copyText, showReloadBanner } from "../ui/common.js";
import { parseWebsite, scopeLabel, scopeUrl, isLocalHost } from "../matching/url-matcher.js";
import { openLoginDialog, closeLoginDialog } from "../ui/login-form.js";
import { generatePassword } from "../generator/password-generator.js";

const $ = selector => document.querySelector(selector);
let page = null;
let listRequest = 0;
let generated = "";
const matches = $("#matches");
const client = new VaultClient(state => {
  $("#vault-state").textContent = state.unlocked ? "Unlocked" : "Locked";
  $("#vault-state").classList.toggle("unlocked", state.unlocked);
  $("#unlocked").hidden = !state.unlocked;
  $("#lock").hidden = !state.unlocked;
  renderAuth($("#auth"), client);
  if (!state.unlocked) closeLoginDialog();
  matches.replaceChildren(); $("#results").replaceChildren(); $("#others").hidden = true;
  if (state.unlocked) void renderLists();
});
const fillAction = async id => {
  await client.request("FILL", { id, tabId: page.tabId, url: page.url });
  announce("Login filled. Review the page before signing in.");
};
// This site's logins first; a search also lists matching logins from other sites (copy only).
async function renderLists() {
  const request = ++listRequest;
  const session = client.state.session;
  const query = $("#search").value.trim();
  try {
    const here = page ? await client.request("LIST", { url: page.url, query }) : [];
    const everywhere = query ? await client.request("LIST", { query }) : [];
    if (!client.is(session) || request !== listRequest) return;
    matches.replaceChildren(...here.map(item => loginRow(item, client, { action: fillAction, disabled: page.forms !== 1 })));
    if (!here.length) matches.append(element("p", { className: "empty" }, !page ? "Open a website to see its saved logins." : query ? "No logins for this site match your search." : "No saved login for this site yet."));
    const others = everywhere.filter(item => !here.some(match => match.id === item.id)).slice(0, 30);
    $("#results").replaceChildren(...others.map(item => loginRow(item, client)));
    $("#others").hidden = !query;
    if (query && !others.length) $("#results").append(element("p", { className: "empty" }, "No other logins match."));
  } catch (error) { announce(error.message, true); }
}
function showSite(site) {
  $("#site-toggle").hidden = !site;
  if (site) $("#site-enabled").checked = site.enabled && site.access;
}
async function checkPage() {
  const button = $("#check-page"); button.disabled = true;
  page = null; matches.replaceChildren(); ++listRequest;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = parseWebsite(tab?.url);
    $("#site-name").textContent = scopeLabel(url);
    $("#site-tile").replaceWith(Object.assign(siteTile(scopeLabel(url)), { id: "site-tile" }));
    const [result, site] = await Promise.all([client.request("DETECT", { tabId: tab.id }), client.request("SITE_STATUS", { origin: url.origin })]);
    page = { ...result, tabId: tab.id };
    showSite(site);
    $("#detection-status").textContent = result.forms === 1 ? "Login form detected. Choose an account to fill." : result.forms > 1 ? "Multiple login forms found. Fill is unavailable."
      : result.newForms ? "Sign-up form detected. Click its password field for a strong password." : "No login form on this page.";
  } catch {
    showSite(null);
    $("#site-name").textContent = "Page unavailable";
    $("#site-tile").replaceWith(Object.assign(siteTile("–"), { id: "site-tile" }));
    $("#detection-status").textContent = "KeyBit works on regular HTTP and HTTPS websites.";
  } finally { button.disabled = false; if (client.state.unlocked) await renderLists(); }
}
function generate() {
  generated = generatePassword({ length: 20, symbols: $("#symbols").getAttribute("aria-pressed") === "true" });
  $("#generated").textContent = generated;
}
$("#toggle-generator").addEventListener("click", event => {
  const open = $("#generator").hidden;
  $("#generator").hidden = !open; event.currentTarget.setAttribute("aria-expanded", String(open));
  if (open && !generated) generate();
});
$("#regenerate").addEventListener("click", generate);
$("#symbols").addEventListener("click", event => { event.currentTarget.setAttribute("aria-pressed", String(event.currentTarget.getAttribute("aria-pressed") !== "true")); generate(); });
$("#copy-generated").addEventListener("click", async () => {
  try { await copyText(generated); announce("Password copied. Clipboard is not cleared automatically."); } catch (error) { announce(error.message, true); }
});
$("#site-enabled").addEventListener("change", async event => {
  if (!page) return;
  const toggle = event.target;
  const enabled = toggle.checked;
  const url = new URL(page.origin);
  toggle.disabled = true;
  try {
    // Browser-level site access can be restricted separately; asking needs this click.
    if (enabled && !(await chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] }))) throw new Error("Site access was not allowed.");
    await client.request("SET_SITE_ENABLED", { origin: page.origin, enabled });
    announce(enabled ? "KeyBit will appear when you click a login field on this site." : `KeyBit is off for ${url.host}. Turn it back on here or in KeyBit → Sites turned off.`);
  } catch (error) { toggle.checked = !enabled; announce(error.message, true); }
  finally { toggle.disabled = false; }
});
$("#search").addEventListener("input", () => void renderLists());
$("#check-page").addEventListener("click", () => void checkPage());
$("#manage").addEventListener("click", () => void openPage("src/vault-ui/vault.html"));
// Add a login without leaving the popup, starting from the current site.
$("#add-login").addEventListener("click", async () => {
  const site = page ? parseWebsite(page.url) : null;
  const existing = site ? await client.request("LIST", { url: page.url }).catch(() => []) : [];
  openLoginDialog({ client, revision: client.state.revision, existing,
    prefill: site ? { website: scopeUrl(site), environment: isLocalHost(site) ? "local" : "other" } : {},
    onSaved: async state => { client.update(state); announce("Login saved and encrypted."); await renderLists(); } });
});
$("#lock").addEventListener("click", () => void client.lock());
$("#settings").addEventListener("click", () => void openPage("src/vault-ui/vault.html#backup"));
window.addEventListener("pagehide", () => { generated = ""; $("#generated").textContent = ""; });
showReloadBanner($("main"));
await client.refresh();
await checkPage();
