import { VaultClient } from "../ui/client.js";
import { renderAuth } from "../ui/auth.js";
import { loginRow } from "../ui/items.js";
import { element, announce, openPage, siteTile, copySecret, showReloadBanner } from "../ui/common.js";
import { parseWebsite, scopeLabel, scopeUrl, isLocalHost, currentEnvironment } from "../matching/url-matcher.js";
import { openLoginDialog, closeLoginDialog } from "../ui/login-form.js";
import { loadPrefs, savePrefs, generate as generateWith } from "../generator/prefs.js";

/** @type {(selector: string) => any} Page elements are looked up by known IDs. */
const $ = selector => document.querySelector(selector);
let page = null;
let listRequest = 0;
let generated = "";
let prefs = null;
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
    const envMaps = here.some(item => item.project) ? (await client.request("ENVIRONMENTS").catch(() => null))?.merged ?? {} : {};
    if (!client.is(session) || request !== listRequest) return;
    matches.replaceChildren(...here.map(item => {
      const row = loginRow(item, client, { action: fillAction, disabled: page.forms !== 1 });
      const envs = item.project ? Object.keys(envMaps[item.project] ?? {}).filter(env => env !== "other") : [];
      if (envs.length < 2) return row;
      // Environment switcher: jump this project's login between its configured addresses. The
      // "current" environment is the one whose address this page sits under; falling back to the
      // login's own tag when the page is outside the project entirely.
      const current = currentEnvironment(envMaps[item.project], page.url) ?? item.environment;
      const chips = element("div", { className: "env-switch", role: "group", "aria-label": `Project ${item.project} environments` },
        envs.map(env => {
          const chip = element("button", { type: "button", className: `chip env-chip${env === "production" ? " production" : ""}`, "data-env": env,
            "aria-pressed": String(env === current), title: envMaps[item.project][env] }, env === "production" ? `⚠ ${env}` : env);
          chip.addEventListener("click", async () => {
            chip.disabled = true;
            try {
              // Production asks first when the setting is on: press once to arm, again to open.
              if (env === "production" && env !== current && client.state.settings?.confirmProduction !== false && chip.dataset.confirm !== "1") {
                chip.dataset.confirm = "1"; chip.textContent = `Open ${env}?`; chip.classList.add("confirming");
                setTimeout(() => { delete chip.dataset.confirm; chip.classList.remove("confirming"); chip.textContent = `⚠ ${env}`; }, 4000);
                return;
              }
              const result = await client.request("SWITCH_ENV", { id: item.id, environment: env, tabId: page.tabId });
              announce(result.url ? `Opening ${env} — ${result.matched ? "the matching login will be ready." : "no saved login there yet."}` : `No ${env} address for project ${item.project} yet. Set one in KeyBit's project view.`, !result.url);
            } catch (error) { announce(error.message, true); }
            finally { chip.disabled = false; }
          });
          return chip;
        }));
      return element("div", { className: "login-block" }, row, chips);
    }));
    if (!here.length) matches.append(element("p", { className: "empty" }, !page ? "Open a website to see its saved logins." : query ? "No logins for this site match your search." : "No saved login for this site yet."));
    // Secure notes have nothing to fill or copy here; they open in the KeyBit window.
    const others = everywhere.filter(item => item.type === "login" && !here.some(match => match.id === item.id)).slice(0, 30);
    $("#results").replaceChildren(...others.map(item => loginRow(item, client)));
    $("#others").hidden = !query;
    if (query && !others.length) $("#results").append(element("p", { className: "empty" }, "No other logins match."));
  } catch (error) { announce(error.message, true); }
}
async function checkPage() {
  const button = $("#check-page"); button.disabled = true;
  page = null; matches.replaceChildren(); ++listRequest;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = parseWebsite(tab?.url);
    $("#site-name").textContent = scopeLabel(url);
    $("#site-tile").replaceWith(Object.assign(siteTile(scopeLabel(url), "", url.href), { id: "site-tile" }));
    const result = await client.request("DETECT", { tabId: tab.id });
    page = { ...result, tabId: tab.id };
    const rule = await client.request("SITE_RULE", { origin: url.origin }).catch(() => null);
    if (rule) {
      $("#site-rules-toggle").hidden = false;
      for (const input of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll("#site-rules [data-rule]"))) {
        input.checked = !!rule[input.dataset.rule];
        // The offer toggles are inert while the master switch is off.
        input.disabled = input.closest(".rule").classList.contains("sub") && !rule.enabled;
      }
    }
    $("#detection-status").textContent = result.forms === 1 ? "Login form detected. Choose an account to fill." : result.forms > 1 ? "Multiple login forms found. Fill is unavailable."
      : result.newForms ? "Sign-up form detected. Click its password field for a strong password." : "No login form on this page.";
  } catch {
    $("#site-name").textContent = "Page unavailable";
    $("#site-tile").replaceWith(Object.assign(siteTile("–"), { id: "site-tile" }));
    $("#detection-status").textContent = "KeyBit works on regular HTTP and HTTPS websites.";
    $("#site-rules-toggle").hidden = true; $("#site-rules").hidden = true;
  } finally { button.disabled = false; $("#inspect-page").hidden = !page; if (client.state.unlocked) await renderLists(); }
}
// The quick generator uses (and remembers) the same settings as KeyBit's Generator.
async function generate() {
  prefs ??= await loadPrefs();
  const memorable = prefs.mode === "memorable";
  $("#symbols").setAttribute("aria-pressed", String(!memorable && prefs.symbols)); $("#symbols").disabled = memorable;
  $("#words").setAttribute("aria-pressed", String(memorable));
  $("#generated-length").textContent = memorable ? `${prefs.words} words` : `${prefs.length} characters`;
  generated = await generateWith(prefs);
  $("#generated").textContent = generated;
}
async function updatePrefs(change) { prefs = { ...prefs, ...change }; await savePrefs(prefs); await generate(); }
$("#toggle-generator").addEventListener("click", event => {
  const open = $("#generator").hidden;
  $("#generator").hidden = !open; event.currentTarget.setAttribute("aria-expanded", String(open));
  if (open && !generated) void generate();
});
$("#regenerate").addEventListener("click", () => void generate());
$("#symbols").addEventListener("click", () => void updatePrefs({ symbols: !prefs.symbols }));
$("#words").addEventListener("click", () => void updatePrefs({ mode: prefs.mode === "memorable" ? "random" : "memorable" }));
$("#copy-generated").addEventListener("click", async () => {
  try {
    const armed = await copySecret(generated);
    announce(armed ? "Password copied. Clears in 30 seconds." : "Password copied. Clipboard is not cleared automatically.");
  } catch (error) { announce(error.message, true); }
});
$("#search").addEventListener("input", () => void renderLists());
$("#check-page").addEventListener("click", () => void checkPage());
// Developer Tools → Inspect Login Form: a structural report for the current tab.
$("#inspect-page").addEventListener("click", () => { if (page?.tabId != null) void openPage(`src/developer/inspector.html?tab=${page.tabId}`); });
// Per-site rules: each checkbox is one flag on this exact origin's rule.
$("#site-rules-toggle").addEventListener("click", event => {
  const open = $("#site-rules").hidden;
  $("#site-rules").hidden = !open;
  event.currentTarget.setAttribute("aria-expanded", String(open));
});
$("#site-rules").addEventListener("change", async event => {
  const input = /** @type {HTMLInputElement} */ (event.target);
  if (!input.dataset.rule || !page) return;
  try {
    const rule = await client.request("SET_SITE_RULE", { origin: parseWebsite(page.url).origin, patch: { [input.dataset.rule]: input.checked } });
    for (const other of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll("#site-rules .sub input"))) other.disabled = !rule.enabled;
    announce(rule.enabled ? "Site rule saved." : "KeyBit is off for this site.");
  } catch (error) { input.checked = !input.checked; announce(error.message, true); }
});
$("#manage").addEventListener("click", () => void openPage("src/vault-ui/vault.html"));
// Add a login without leaving the popup, starting from the current site.
$("#add-login").addEventListener("click", async () => {
  const site = page ? parseWebsite(page.url) : null;
  const [existing, projects] = await Promise.all([site ? client.request("LIST", { url: page.url }).catch(() => []) : [], client.request("PROJECTS").catch(() => [])]);
  openLoginDialog({ client, revision: client.state.revision, existing, projects,
    prefill: site ? { website: scopeUrl(site), environment: isLocalHost(site) ? "local" : "other" } : {},
    onSaved: async state => { client.update(state); announce("Login saved and encrypted."); await renderLists(); } });
});
$("#lock").addEventListener("click", () => void client.lock());
$("#settings").addEventListener("click", () => void openPage("src/vault-ui/vault.html#backup"));
window.addEventListener("pagehide", () => { generated = ""; $("#generated").textContent = ""; });
// Keyboard: "/" searches, ↑ ↓ move between logins, Enter fills (or copies the password when it can't fill).
document.addEventListener("keydown", event => {
  if ($("#login-dialog")?.open) return;
  const rows = [...document.querySelectorAll("#unlocked .login-item")];
  const target = /** @type {HTMLElement} */ (event.target);
  const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
  if (event.key === "/" && !typing && !$("#unlocked").hidden) { event.preventDefault(); $("#search").focus(); return; }
  if ((event.key === "ArrowDown" || event.key === "ArrowUp") && rows.length && (target === $("#search") || rows.includes(target))) {
    event.preventDefault();
    const index = rows.indexOf(target);
    /** @type {HTMLElement} */ (rows[index < 0 ? (event.key === "ArrowDown" ? 0 : rows.length - 1) : (index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]).focus();
    return;
  }
  if (event.key === "Enter" && rows.includes(target)) {
    event.preventDefault();
    const fill = target.querySelector('[data-action="fill"]:not(:disabled)');
    /** @type {HTMLElement | null} */ (fill ?? target.querySelector('[data-action="copy-password"]'))?.click();
  }
});
showReloadBanner($("main"));
await client.refresh();
await checkPage();
