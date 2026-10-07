import { VaultClient } from "../ui/client.js";
import { renderAuth } from "../ui/auth.js";
import { loginRow } from "../ui/items.js";
import { element, announce, openPage } from "../ui/common.js";
import { parseWebsite } from "../matching/url-matcher.js";

const $ = selector => document.querySelector(selector);
let page = null;
let listRequest = 0;
const matches = $("#matches");
const client = new VaultClient(state => {
  $("#vault-state").textContent = state.unlocked ? "Unlocked" : "Locked";
  $("#vault-state").classList.toggle("unlocked", state.unlocked);
  $("#unlocked").hidden = !state.unlocked;
  $("#lock").hidden = !state.unlocked;
  renderAuth($("#auth"), client);
  matches.replaceChildren();
  if (state.unlocked) void renderMatches();
});
async function renderMatches() {
  const request = ++listRequest;
  const session = client.state.session;
  if (!page) { matches.replaceChildren(element("p", { className: "empty" }, "Open a website to see its saved logins.")); return; }
  try {
    const items = await client.request("LIST", { url: page.origin });
    if (!client.is(session) || request !== listRequest) return;
    matches.replaceChildren(...items.map(item => loginRow(item, client, "Fill", async id => {
      await client.request("FILL", { id, tabId: page.tabId, origin: page.origin });
      announce("Login filled. Review the page before signing in.");
    }, page.forms !== 1)));
    if (!items.length) matches.append(element("p", { className: "empty" }, "No saved login matches this website."));
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
    $("#site-name").textContent = url.host;
    $("#site-avatar").textContent = url.hostname.replace(/^www\./, "")[0]?.toUpperCase() ?? "?";
    const [result, site] = await Promise.all([client.request("DETECT", { tabId: tab.id }), client.request("SITE_STATUS", { origin: url.origin })]);
    page = { ...result, tabId: tab.id };
    showSite(site);
    $("#detection-status").textContent = result.forms === 1 ? "Login form detected. Choose an account to fill." : result.forms > 1 ? "Multiple login forms found. Fill is unavailable." : "No login form on this page.";
  } catch {
    showSite(null);
    $("#site-name").textContent = "Page unavailable";
    $("#site-avatar").textContent = "–";
    $("#detection-status").textContent = "KeyBit works on regular HTTP and HTTPS websites.";
  } finally { button.disabled = false; if (client.state.unlocked) await renderMatches(); }
}
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
    announce(enabled ? "KeyBit will appear when you click a login field on this site." : `KeyBit is off for ${url.host}. Turn it back on here or in Settings.`);
  } catch (error) { toggle.checked = !enabled; announce(error.message, true); }
  finally { toggle.disabled = false; }
});
$("#check-page").addEventListener("click", () => void checkPage());
$("#manage").addEventListener("click", () => void openPage("src/vault-ui/vault.html"));
$("#add-login").addEventListener("click", () => void openPage("src/vault-ui/vault.html#new"));
$("#lock").addEventListener("click", () => void client.lock());
$("#settings").addEventListener("click", () => { void chrome.runtime.openOptionsPage().catch(() => announce("Could not open Settings.", true)); });
await client.refresh();
await checkPage();
