import { VaultClient } from "../ui/client.js";
import { renderAuth } from "../ui/auth.js";
import { element, all, announce, clearFields, siteTile, icon, iconButton, copyText, copySecret, showReloadBanner, relativeTime, revealButton, passwordField } from "../ui/common.js";
import { combineShares, recoveryPassphrase } from "../vault/shamir.js";
import { portableHtml } from "../vault/portable.js";
import { scopeLabel } from "../matching/url-matcher.js";
import { passwordAge } from "../vault/health.js";
import { MAX_BACKUP_BYTES } from "../crypto/encoding.js";
import { totpCode } from "../vault/totp.js";
import { openLoginDialog, closeLoginDialog } from "../ui/login-form.js";
import { loadPrefs, savePrefs, generate as generateWith } from "../generator/prefs.js";
import { parseImport } from "../import/parsers.js";
import { getFolder, setFolder, writeBackup } from "../background/auto-backup.js";
import { biometricAvailable, biometricName, createBiometric } from "../ui/biometric.js";

/** @type {(selector: string) => any} Page elements are looked up by known IDs. */
const $ = selector => document.querySelector(selector);
const LIST_VIEWS = ["logins", "favorites", "notes", "passkeys", "cards", "trash"];
const VIEWS = [...LIST_VIEWS, "health", "generator", "import", "backup", "settings", "sites"];
const LOCK_LABELS = { 0: "Never", 1: "1 minute", 5: "5 minutes", 10: "10 minutes", 15: "15 minutes", 30: "30 minutes" };
const ENV_ORDER = ["production", "staging", "development", "local", "other"];
const ENV_LABELS = { production: "Production", staging: "Staging", development: "Development", local: "Local", other: "Other" };
const BACKUP_NUDGE_DAYS = 30;
let view = "logins";
let restoring = false;
let items = [];
let trash = [];
let health = {};
let projects = [];
let disabledSites = {};
let selectedId = null;
let passkeyCount = 0;
let detail = null;           // { item, revision }: the selected item, including its secrets, until lock or deselect
let pendingSelects = 0;      // selects still fetching: a queued `close` event must not clear them
let codeTicker = null;
let listRequest = 0;
let importToken = null;
let importItems = null;
let prefs = null;
let envMaps = { merged: {}, configured: {} };
let backupInfo = { lastBackupAt: 0, snoozedUntil: 0 };
let sort = (() => { try { return localStorage.getItem("keybit-sort") || "name"; } catch { return "name"; } })();

const client = new VaultClient((state, previous) => {
  renderAuth($("#auth"), client);
  if (!state.unlocked) { closeLoginDialog(); closeDialog(); clearDetail(); items = []; trash = []; health = {}; $("#items").replaceChildren(); $("#health-list").replaceChildren(); }
  if (state.session !== previous.session) { $("#search").value = ""; selectedId = null; }
  if (state.unlocked) restoring = false;
  layout();
  $("#export").disabled = !state.exists;
  if (!state.unlocked) { if (previous.unlocked) clearFields($("#import-form")); return; }
  updateAutoLock(state.settings.autoLockMinutes);
  $("#lock-on-sleep").checked = state.settings.lockOnScreenLock !== false;
  $("#confirm-production").checked = state.settings.confirmProduction !== false;
  $("#biometric").checked = !!state.biometric;
  void refreshList();
  void refreshSites();
  if (location.hash === "#new") { history.replaceState(null, "", location.pathname); show("logins"); openAdd("login"); }
  else if (location.hash === "#new-note") {
    history.replaceState(null, "", location.pathname); show("notes");
    // The context menu's "Save as secure note" parks the selected text here until the vault is unlocked.
    void (async () => {
      const pending = await chrome.storage.session.get("pending-note").catch(() => ({}));
      if (pending?.["pending-note"]) await chrome.storage.session.remove("pending-note").catch(() => {});
      openAdd("note", { notes: pending?.["pending-note"] ?? "" });
    })();
  }
  else if (location.hash === "#welcome") { history.replaceState(null, "", location.pathname); show("logins"); }
  // Another window or a save prompt changed the vault: reload the open item unless it is being edited.
  else if (selectedId && previous.revision !== state.revision && !$("#login-dialog")?.open) void select(selectedId);
});

// Layout and navigation
function layout() {
  const unlocked = client.state.unlocked;
  $("#locked").hidden = unlocked || restoring;
  $("#app").hidden = !unlocked && !restoring;
  $("#sidebar").hidden = !unlocked;
  $("#search-box").hidden = !unlocked; $("#header-actions").hidden = !unlocked;
  $("#back-to-unlock").hidden = unlocked;
  $("#merge-backup").hidden = !unlocked;
  $("#csv-export-card").hidden = !unlocked;
  $("#portable-card").hidden = !unlocked;
  $("#welcome").hidden = !(location.hash === "#welcome" || (client.state.ready && !client.state.exists));
  if (restoring && !unlocked) show("backup", false);
}
const isList = name => LIST_VIEWS.includes(name) || name.startsWith("project:");
function show(name, remember = true) {
  view = VIEWS.includes(name) || (name.startsWith("project:") && projects.includes(name.slice(8))) ? name : "logins";
  if (view === "sites" && !Object.keys(disabledSites).length) view = "logins";
  if (view === "passkeys" && !passkeyCount) view = "logins";
  const section = isList(view) ? "logins" : view;
  for (const candidate of VIEWS.filter(name => !LIST_VIEWS.includes(name) || name === "logins")) $(`#view-${candidate}`).hidden = candidate !== section;
  for (const nav of all(".nav-item")) nav.setAttribute("aria-current", nav.dataset.view === view ? "page" : "false");
  if (remember) history.replaceState(null, "", `#${encodeURIComponent(view)}`);
  if (isList(view)) { clearDetail(); renderList(); }
  if (view === "generator") void renderGenerator();
  if (view === "backup") { renderBackupInfo(); void renderAutoBackup(); }
  if (view === "settings") void renderSettings();
}
document.addEventListener("click", event => {
  const nav = /** @type {HTMLElement} */ (/** @type {Element} */ (event.target).closest?.(".nav-item"));
  if (nav && $("#sidebar").contains(nav)) show(nav.dataset.view);
});
$("#restore-instead").addEventListener("click", () => { restoring = true; layout(); });
$("#back-to-unlock").addEventListener("click", () => { restoring = false; layout(); });

// Lists
const badge = (text, kind = "") => element("span", { className: `badge ${kind}` }, text);
function row(item, onClick) {
  const flags = health.flags?.[item.id] ?? {};
  const note = item.type === "note";
  const passkey = item.type === "passkey";
  const card = item.type === "card";
  const identity = item.type === "identity";
  const secondary = item.deletedAt ? `Deleted ${relativeTime(Date.parse(item.deletedAt))}` :
    note ? ["Secure note", item.project].filter(Boolean).join(" · ") :
    passkey ? `Passkey · ${item.rpId}` :
    card ? `${item.brand} ···· ${item.last4}` :
    identity ? [item.fullName, item.city, item.country].filter(Boolean).join(" · ") || "Identity" :
    `${item.username || "No username"} · ${item.scope}`;
  const button = element("button", { type: "button", className: "item-row login-item", "data-id": item.id, "aria-current": String(item.id === selectedId) },
    note ? element("span", { className: "tile tone-6", "aria-hidden": "true" }, icon("note")) :
    passkey ? element("span", { className: "tile tone-2", "aria-hidden": "true" }, icon("key")) :
    card ? element("span", { className: "tile tone-4", "aria-hidden": "true" }, icon("card")) :
    identity ? element("span", { className: "tile tone-5", "aria-hidden": "true" }, icon("id")) : siteTile(item.scope, "", item.urls?.[0]),
    element("span", { className: "details" }, element("span", { className: "primary" }, item.favorite ? "★ " : "", item.name), element("span", { className: "secondary" }, secondary)),
    element("span", { className: "row-badges" }, item.environment === "production" ? badge("Production", "production") : null,
      passkey ? badge("Passkey") : null, item.hasTotp ? badge("2FA", "totp") : null, flags.reused ? badge("Reused", "warn") : null, flags.weak ? badge("Weak", "weak") : null));
  button.addEventListener("click", onClick);
  return button;
}
function sorted(list) {
  const by = { name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    used: (a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || a.name.localeCompare(b.name),
    updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt) }[sort] ?? (() => 0);
  return [...list].sort(by);
}
function inView(item) {
  if (view === "favorites") return item.favorite;
  if (view === "notes") return item.type === "note";
  if (view === "passkeys") return item.type === "passkey";
  if (view === "cards") return item.type === "card" || item.type === "identity";
  if (view.startsWith("project:")) return item.project === view.slice(8);
  return item.type === "login";
}
// Environment URL editor for a project view: the popup's switcher jumps between these addresses.
// Entries marked "from login" resolve from a login's own environment + site; saving one writes an
// explicit override into the project's environment map.
function renderEnvEditor(project) {
  const host = $("#env-editor");
  host.replaceChildren();
  host.hidden = !project;
  if (!project) return;
  const merged = envMaps.merged[project] ?? {};
  const configured = envMaps.configured[project] ?? {};
  const save = async environments => {
    try {
      client.update(await client.request("SET_PROJECT_ENV", { project, environments, revision: client.state.revision }));
      announce("Environments saved.");
      await refreshList();
    } catch (error) { announce(error.message, true); }
  };
  const order = env => { const index = ENV_ORDER.indexOf(env); return index < 0 ? ENV_ORDER.length : index; };
  const rows = Object.entries(merged).sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b)).map(([env, url]) => {
    const input = element("input", { type: "url", value: url, "aria-label": `${env} address`, placeholder: "https://…" });
    input.addEventListener("change", () => {
      const value = input.value.trim();
      if (value && value !== url) void save({ ...configured, [env]: value }); else input.value = url;
    });
    const remove = iconButton("close", `Remove ${env}`);
    remove.addEventListener("click", () => { const { [env]: gone, ...rest } = configured; void gone; void save(rest); });
    return element("div", { className: "env-row" }, element("span", { className: "env-name" }, env), input,
      env in configured ? remove : element("span", { className: "badge", title: "Resolved from a login's environment — edit to override it" }, "from login"));
  });
  const envName = element("input", { list: "env-names", placeholder: "environment", "aria-label": "Environment name", maxlength: "40" });
  const envUrl = element("input", { type: "url", placeholder: "https://staging.example.com", "aria-label": "Environment URL" });
  const add = element("button", { type: "button", className: "secondary-button" }, "Add");
  add.addEventListener("click", () => {
    const env = envName.value.trim().toLowerCase(), url = envUrl.value.trim();
    if (!env || !url) { announce("Name the environment and give its URL.", true); return; }
    void save({ ...configured, [env]: url });
  });
  host.append(
    element("div", { className: "env-head" },
      element("h3", {}, "Environments"),
      element("span", { className: "muted" }, "Addresses the popup environment switcher jumps between.")),
    ...rows,
    element("div", { className: "env-row env-add" }, envName, envUrl, add),
    element("datalist", { id: "env-names" }, ENV_ORDER.map(env => element("option", { value: env }))));
}
function renderList() {
  if (!isList(view)) return;
  const query = $("#search").value;
  const project = view.startsWith("project:") ? view.slice(8) : null;
  renderEnvEditor(project && !query ? project : null);
  const titles = { logins: "All logins", favorites: "Favorites", notes: "Secure notes", passkeys: "Passkeys", cards: "Cards & IDs", trash: "Recently deleted" };
  $("#list-title").textContent = query ? `Results for “${query}”` : project ?? titles[view];
  $("#add-label").textContent = view === "notes" ? "Add note" : view === "cards" ? "Add card" : "Add login";
  // Passkeys are created by websites, not by hand; there is nothing to add in that view.
  // The cards view adds either type, so it gets a second button.
  $("#add-login").hidden = view === "passkeys";
  $("#add-id").hidden = view !== "cards";
  // Trash always lists the newest deletion first; the sort menu is not meaningful there.
  $("#sort").hidden = view === "trash";
  $("#empty-trash").hidden = view !== "trash" || !trash.length;
  // A search looks everywhere, not only in the current section.
  const shown = query ? sorted(items) : view === "trash" ? trash : sorted(items.filter(inView));
  const open = item => () => void select(item.id);
  if (project && !query) {
    // Developer view: a project's logins grouped by environment, production first.
    $("#items").replaceChildren(...ENV_ORDER.flatMap(environment => {
      const group = shown.filter(item => (item.type === "note" ? "other" : item.environment) === environment);
      return group.length ? [element("h3", { className: `group-heading ${environment}` }, ENV_LABELS[environment]), ...group.map(item => row(item, open(item)))] : [];
    }));
  } else $("#items").replaceChildren(...shown.map(item => row(item, open(item))));
  if (shown.length) return;
  if (query) $("#items").append(element("p", { className: "empty" }, "Nothing matches your search."));
  else if (view === "logins") $("#items").append(gettingStarted());
  else $("#items").append(element("p", { className: "empty" }, view === "favorites" ? "Star a login or note to keep it here."
    : view === "notes" ? "Keep licence keys, server details, or Wi-Fi passwords here, encrypted."
    : view === "passkeys" ? "No passkeys yet. When a site offers to create one, KeyBit asks to keep it here."
    : view === "cards" ? "Save a payment card or an ID (name, address, phone) and KeyBit fills checkout and sign-up forms."
    : view === "trash" ? "Nothing deleted. Items you delete are kept here for 30 days." : "Nothing in this project yet."));
}
function gettingStarted() {
  const action = (label, text, onClick) => {
    const button = element("button", { type: "button", className: "start-step" }, element("strong", {}, label), element("span", {}, text));
    if (onClick) button.addEventListener("click", onClick); else button.disabled = true;
    return button;
  };
  return element("div", { className: "getting-started" }, element("h3", {}, "Get started"),
    action("Import your passwords", "From Chrome, Apple Passwords, Bitwarden, 1Password, or LastPass.", () => show("import")),
    action("Add a login", "Or just sign in to a website; KeyBit offers to save it.", () => openAdd("login")),
    action("Pin KeyBit", "Click the puzzle icon in the toolbar, then the pin next to KeyBit.", null));
}
async function refreshList() {
  const request = ++listRequest;
  const session = client.state.session;
  try {
    // Health is extra information: if it is unavailable, the list must still show.
    const [list, flags, names, deleted, envs] = await Promise.all([client.request("LIST", { query: $("#search").value }),
      client.request("HEALTH").catch(() => ({})), client.request("PROJECTS").catch(() => []), client.request("TRASH_LIST").catch(() => []),
      client.request("ENVIRONMENTS").catch(() => ({ merged: {}, configured: {} }))]);
    if (!client.is(session) || request !== listRequest) return;
    items = list; health = flags; projects = names; trash = deleted; envMaps = envs ?? { merged: {}, configured: {} };
    $("#count-trash").textContent = String(trash.length || "");
    renderProjects();
    renderList();
    const all = $("#search").value ? await client.request("LIST", { query: "" }) : items;
    if (!client.is(session)) return;
    const healthFlags = health.flags ?? {};
    const report = health.report;
    const flagged = all.filter(item => healthFlags[item.id]?.reused || healthFlags[item.id]?.weak ||
      (item.type === "login" && item.updatedAt && passwordAge(item.updatedAt) === "old"));
    passkeyCount = all.filter(item => item.type === "passkey").length;
    $("#nav-passkeys").hidden = !passkeyCount;
    $("#count-passkeys").textContent = String(passkeyCount || "");
    $("#count-logins").textContent = String(all.filter(item => item.type === "login").length);
    $("#count-favorites").textContent = String(all.filter(item => item.favorite).length || "");
    $("#count-notes").textContent = String(all.filter(item => item.type === "note").length || "");
    $("#count-cards").textContent = String(all.filter(item => item.type === "card" || item.type === "identity").length || "");
    $("#count-health").textContent = String(flagged.length); $("#count-health").hidden = !flagged.length;
    $("#health-list").replaceChildren(...flagged.map(item => row(item, () => { show("logins"); void select(item.id); })));
    if (!flagged.length) $("#health-list").append(element("p", { className: "empty" }, "Nothing needs review. Nice."));
    if (report) {
      $("#health-score-big").textContent = `${report.score}%`;
      $("#health-factors").replaceChildren(...(report.factors.length ? report.factors : [{ label: "everything looks good", count: 0, delta: 0 }])
        .map(factor => element("li", { className: factor.delta >= 0 ? "good" : "bad" },
          element("b", {}, `${factor.delta >= 0 ? "+" : ""}${factor.delta}`),
          element("span", {}, factor.count ? `${factor.count} ${factor.label}` : factor.label))));
      const tiles = [["Logins", report.metrics.logins], ["Strong passwords", report.metrics.strong], ["Weak passwords", report.metrics.weak],
        ["Reused passwords", report.metrics.reused], ["Duplicate credentials", report.metrics.duplicates], ["Fresh passwords", report.metrics.fresh],
        ["Aging passwords", report.metrics.aging], ["Old passwords", report.metrics.old], ["Accounts with 2FA", report.metrics.totp],
        ["Saved passkeys", report.metrics.passkeys], ["Production logins", report.metrics.production], ["Needs review", report.metrics.needReview]];
      $("#health-metrics").replaceChildren(...tiles.map(([label, value]) =>
        element("div", { className: "metric" }, element("b", {}, String(value)), element("span", {}, label))));
    }
    // Sidebar summary uses the same report score so both numbers always agree.
    const weak = all.filter(item => healthFlags[item.id]?.weak).length;
    const reused = all.filter(item => healthFlags[item.id]?.reused).length;
    $("#sidebar-health").hidden = !(report?.metrics.logins ?? 0);
    $("#sidebar-health").classList.toggle("warn", flagged.length > 0);
    $("#health-score").textContent = report ? `${report.score}%` : "";
    $("#health-detail").textContent = flagged.length ? `${weak} weak · ${reused} reused` : "All strong";
    await loadBackupInfo(all.length);
  } catch (error) { announce(error.message, true); }
}
function renderProjects() {
  $("#projects-nav").hidden = !projects.length;
  $("#project-items").replaceChildren(...projects.map(name => element("button", { type: "button", className: "nav-item", "data-view": `project:${name}`, "aria-current": String(view === `project:${name}`) },
    icon("folder"), element("span", {}, name), element("span", { className: "count" }, String(items.filter(item => item.project === name).length || "")))));
  if (view.startsWith("project:") && !projects.includes(view.slice(8))) show("logins");
}
$("#search").addEventListener("input", () => { if (!isList(view)) show("logins"); void refreshList(); });
$("#sidebar-health").addEventListener("click", () => show("health"));
// A site-rule change from the popup or another window refreshes the rules view.
chrome.runtime.onMessage.addListener(message => { if (message?.event === "site-rules") void refreshSites(); });
// ⌘K / Ctrl+K jumps to search from anywhere; "/" works when not typing, like the popup.
$("#search-kbd").textContent = /^Mac|iP/.test(navigator.platform) ? "⌘K" : "Ctrl K";
document.addEventListener("keydown", event => {
  if (!client.state.unlocked || $("#login-dialog")?.open || $("#password-dialog")?.open || $("#share-dialog")?.open || $("#detail")?.open) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); $("#search").focus(); $("#search").select(); return; }
  const target = /** @type {HTMLElement} */ (event.target);
  const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable;
  if (event.key === "/" && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); $("#search").focus(); }
});
$("#sort").value = sort;
$("#sort").addEventListener("change", () => { sort = $("#sort").value; try { localStorage.setItem("keybit-sort", sort); } catch { /* Not saved. */ } renderList(); });

// Details
function clearDetail() {
  clearInterval(codeTicker); codeTicker = null;
  selectedId = null; detail = null;
  $("#detail-view").replaceChildren();
  if ($("#detail").open) $("#detail").close();
  for (const node of all(".item-row[aria-current='true']")) node.setAttribute("aria-current", "false");
}
// Escape and clicking the dimmed page behind the dialog both close it. The `close` event is
// dispatched as a queued task, so it can arrive late — while a newer select() is still in flight,
// or after it already re-opened the dialog for another item. Only a close event that finds the
// dialog still closed and matches the current selection may clear it.
$("#detail").addEventListener("close", () => {
  if (pendingSelects || $("#detail").open || !detail || detail.item.id !== selectedId) return;
  clearDetail();
});
$("#detail").addEventListener("click", event => { if (event.target === $("#detail")) clearDetail(); });
async function select(id) {
  const session = client.state.session;
  pendingSelects++;
  selectedId = id;
  for (const node of all(".item-row")) node.setAttribute("aria-current", String(node.dataset.id === id));
  try {
    const response = await client.request("ITEM", { id });
    if (!client.is(session) || selectedId !== id) return;
    detail = { item: response.item, revision: response.state.revision };
    renderDetail();
  } catch (error) { announce(error.message, true); clearDetail(); await client.refresh(); }
  finally { pendingSelects--; }
}
async function copy(value, what) {
  try {
    const secret = ["password", "2FA code", "card number", "CVV"].includes(what);
    const armed = secret ? await copySecret(value) : (await copyText(value), false);
    const label = `${what[0].toUpperCase()}${what.slice(1)} copied.`;
    announce(!secret ? label : armed ? `${label} Clears in 30 seconds.` : `${label} Clipboard is not cleared automatically.`);
  } catch (error) { announce(error.message, true); }
}
function secretValue(password, what = "password") {
  const value = element("span", { className: "secret masked" }, "••••••••••••");
  const reveal = iconButton("eye", `Show ${what}`, { "aria-pressed": "false" });
  reveal.addEventListener("click", () => {
    const shown = reveal.getAttribute("aria-pressed") !== "true";
    reveal.setAttribute("aria-pressed", String(shown)); reveal.title = shown ? `Hide ${what}` : `Show ${what}`; reveal.setAttribute("aria-label", reveal.title);
    value.textContent = shown ? password : "••••••••••••"; value.classList.toggle("masked", !shown);
  });
  return [value, reveal];
}
const copyButton = (value, what) => { const button = iconButton("copy", `Copy ${what}`); button.addEventListener("click", () => void copy(value, what)); return button; };
const fieldBlock = (label, ...value) => element("div", { className: "field" }, element("div", { className: "field-label" }, label), element("div", { className: "field-value" }, ...value));
function renderDetail() {
  clearInterval(codeTicker); codeTicker = null;
  const { item } = detail;
  const note = item.type === "note";
  const passkey = item.type === "passkey";
  const card = item.type === "card";
  const identity = item.type === "identity";
  const flags = health.flags?.[item.id] ?? {};
  const scope = note || passkey || card || identity ? "" : scopeLabel(item.urls[0]);
  const back = iconButton("close", "Close", { className: "icon-button back-button" });
  back.addEventListener("click", clearDetail);
  const star = iconButton("star", item.favorite ? "Remove from favorites" : "Add to favorites", { className: `icon-button star${item.favorite ? " on" : ""}`, "aria-pressed": String(item.favorite) });
  star.addEventListener("click", () => void toggleFavorite());
  const fields = [];
  if (note) fields.push(element("div", { className: "field" }, element("div", { className: "field-label" }, "Note"), element("p", { className: "notes" }, item.notes || "—"), item.notes ? element("div", { className: "field-value" }, copyButton(item.notes, "note")) : null));
  else if (passkey) {
    fields.push(fieldBlock("Signs in to", element("span", {}, item.rpId)));
    fields.push(fieldBlock("Account", element("span", {}, item.userName), copyButton(item.userName, "username")));
    fields.push(fieldBlock("Last used", element("span", {}, item.lastUsedAt ? `${relativeTime(Date.parse(item.lastUsedAt))} · ${item.signCount} sign-in${item.signCount === 1 ? "" : "s"}` : "Not used yet")));
    fields.push(fieldBlock("Created", element("span", {}, new Date(item.createdAt).toLocaleString())));
    if (item.notes) fields.push(element("div", { className: "field" }, element("div", { className: "field-label" }, "Notes"), element("p", { className: "notes" }, item.notes)));
  }
  else if (card) {
    if (item.cardholder) fields.push(fieldBlock("Name on card", element("span", {}, item.cardholder), copyButton(item.cardholder, "name")));
    fields.push(fieldBlock("Number", ...secretValue(item.number, "card number"), copyButton(item.number, "card number")));
    fields.push(fieldBlock("Expiry", element("span", {}, `${String(item.expiryMonth).padStart(2, "0")}/${item.expiryYear}`)));
    if (item.cvv) fields.push(fieldBlock("Security code", ...secretValue(item.cvv, "CVV"), copyButton(item.cvv, "CVV")));
    if (item.brand) fields.push(fieldBlock("Brand", element("span", {}, item.brand)));
    if (item.notes) fields.push(element("div", { className: "field" }, element("div", { className: "field-label" }, "Notes"), element("p", { className: "notes" }, item.notes)));
  }
  else if (identity) {
    const pairs = [["Name", [item.firstName, item.lastName].filter(Boolean).join(" ")], ["Email", item.email], ["Phone", item.phone], ["Address", [item.address, [item.city, item.region, item.postal].filter(Boolean).join(", "), item.country].filter(Boolean).join("\n")], ["Company", item.company]];
    for (const [label, value] of pairs) if (value) fields.push(fieldBlock(label, element("span", { className: "notes" }, value), copyButton(value, label.toLowerCase())));
    if (item.notes) fields.push(element("div", { className: "field" }, element("div", { className: "field-label" }, "Notes"), element("p", { className: "notes" }, item.notes)));
  }
  else {
    fields.push(fieldBlock("Username", element("span", {}, item.username || "—"), item.username ? copyButton(item.username, "username") : null));
    fields.push(fieldBlock("Password", ...secretValue(item.password), copyButton(item.password, "password")));
    if (item.totp) {
      const code = element("span", { className: "totp-code" }, "······");
      const remaining = element("span", { className: "totp-remaining muted" });
      const copyCode = iconButton("copy", "Copy 2FA code");
      let current = "";
      copyCode.addEventListener("click", () => { if (current) void copy(current, "2FA code"); });
      const tick = async () => {
        try {
          const result = await totpCode(item.totp);
          current = result.code;
          code.textContent = `${result.code.slice(0, Math.ceil(result.code.length / 2))} ${result.code.slice(Math.ceil(result.code.length / 2))}`;
          remaining.textContent = `${result.remaining}s`;
        } catch { code.textContent = "Invalid key"; }
      };
      void tick(); codeTicker = setInterval(() => void tick(), 1000);
      fields.push(fieldBlock("2FA code", code, remaining, copyCode));
    }
    for (const [index, url] of item.urls.entries()) {
      const open = iconButton("external", "Open website");
      open.addEventListener("click", () => void chrome.tabs.create({ url }));
      fields.push(fieldBlock(index ? "Also fills on" : "Website", element("span", {}, url), open));
    }
    if (item.notes) fields.push(element("div", { className: "field" }, element("div", { className: "field-label" }, "Notes"), element("p", { className: "notes" }, item.notes)));
  }
  const trashed = Boolean(item.deletedAt);
  const warnings = [];
  if (trashed) warnings.push(element("p", { className: "warning" }, icon("trash"), `Deleted ${relativeTime(Date.parse(item.deletedAt))}. Kept for 30 days, then removed forever.`));
  if (flags.reused) warnings.push(element("p", { className: "warning" }, icon("alert"), `This password is also used by ${flags.reused} other login${flags.reused === 1 ? "" : "s"}. Change it on this site to a unique one.`));
  if (flags.weak) warnings.push(element("p", { className: "warning weak" }, icon("alert"), "This password is short or simple. Generate a stronger one when you next change it."));
  if (!trashed && item.type === "login" && passwordAge(item.updatedAt) === "old")
    warnings.push(element("p", { className: "warning" }, icon("timer"), "This login has not been updated for over 2 years — worth a review, not necessarily unsafe."));
  let history = null;
  if (!note && !passkey && item.history.length) {
    history = element("details", { className: "history" }, element("summary", {}, `Password history (${item.history.length})`),
      ...item.history.map(entry => {
        const [value, reveal] = secretValue(entry.password);
        const restore = iconButton("undo", "Restore this password");
        restore.addEventListener("click", () => void restorePassword(entry.password));
        return element("div", { className: "history-entry" },
          element("span", { className: "when" }, `Replaced ${new Date(entry.changedAt).toLocaleString()}`, value), reveal, copyButton(entry.password, "password"), restore);
      }));
  }
  const meta = [item.project ? `Project ${item.project}` : null, `Updated ${relativeTime(Date.parse(item.updatedAt))}`].filter(Boolean).join(" · ");
  const actions = [];
  if (trashed) {
    const restore = element("button", { type: "button", className: "secondary-button", id: "restore-item" }, "Restore");
    restore.addEventListener("click", () => void restoreItem(item.id));
    const purge = element("button", { type: "button", className: "text-button danger" }, "Delete forever");
    purge.addEventListener("click", () => void purgeItem(item.id));
    actions.push(restore, purge);
  } else if (passkey) {
    const remove = element("button", { type: "button", className: "text-button danger" }, "Delete");
    remove.addEventListener("click", () => void deleteItem(item.id));
    actions.push(remove);
  } else {
    const edit = element("button", { type: "button", className: "secondary-button", id: "edit-login" }, "Edit");
    edit.addEventListener("click", () => openLoginDialog({ client, item: detail.item, revision: detail.revision, existing: items, projects, onSaved: afterSave, onDelete: afterDelete }));
    const share = element("button", { type: "button", className: "secondary-button", id: "share-item" }, "Share…");
    share.addEventListener("click", () => openShare(item));
    const remove = element("button", { type: "button", className: "text-button danger" }, "Delete");
    remove.addEventListener("click", () => void deleteItem(item.id));
    actions.push(edit, share, remove);
  }
  $("#detail-view").replaceChildren(...[
    element("div", { className: "detail-header" }, note ? element("span", { className: "tile tone-6", "aria-hidden": "true" }, icon("note")) :
      passkey ? element("span", { className: "tile tone-2", "aria-hidden": "true" }, icon("key")) :
      card ? element("span", { className: "tile tone-4", "aria-hidden": "true" }, icon("card")) :
      identity ? element("span", { className: "tile tone-5", "aria-hidden": "true" }, icon("id")) : siteTile(scope, "", item.urls?.[0]),
      element("h3", {}, item.name, element("span", { className: "site" }, note ? "Secure note" : passkey ? `Passkey · ${item.rpId}` : card ? `${item.brand} ···· ${item.last4}` : identity ? "Identity" : scope,
        !note && item.environment !== "other" ? badge(item.environment, item.environment === "production" ? "production" : "") : null)), star, back),
    ...warnings, ...fields, history,
    element("div", { className: "detail-actions" }, ...actions, element("span", { className: "meta" }, meta))
  ].filter(Boolean));
  if (!$("#detail").open) $("#detail").showModal();
}
async function toggleFavorite() {
  if (!detail) return;
  const { item, revision } = detail;
  try {
    const state = await client.request("SAVE", { item: { ...item, favorite: !item.favorite }, revision });
    client.update(state); await refreshList(); await select(item.id);
  } catch (error) { announce(error.message, true); await client.refresh(); }
}
async function restorePassword(password) {
  if (!detail || !confirm("Restore this password? The current one moves to the password history.")) return;
  try {
    const state = await client.request("SAVE", { item: { ...detail.item, password }, revision: detail.revision });
    client.update(state); announce("Password restored. The previous one is in the history.");
    await select(detail.item.id);
  } catch (error) { announce(error.message, true); await client.refresh(); }
}
const kindWord = type => ({ note: "note", passkey: "passkey", card: "card", identity: "identity" }[type] ?? "login");
async function deleteItem(id) {
  if (!confirm(`Delete this ${kindWord(detail?.item.type)}? It is kept in Recently deleted for 30 days.`)) return;
  try {
    const state = await client.request("DELETE", { id, revision: detail?.revision ?? client.state.revision });
    await afterDelete(state);
  } catch (error) { announce(error.message, true); await client.refresh(); }
}
async function restoreItem(id) {
  const kind = detail?.item.type;
  try {
    const state = await client.request("RESTORE", { id, revision: detail?.revision ?? client.state.revision });
    clearDetail(); client.update(state); announce("Restored.");
    await refreshList();
    if (["note", "login", "passkey", "card", "identity"].includes(kind)) { show({ note: "notes", passkey: "passkeys", card: "cards", identity: "cards" }[kind] ?? "logins"); await select(id); }
  } catch (error) { announce(error.message, true); await client.refresh(); }
}
async function purgeItem(id) {
  if (!confirm(`Delete this ${kindWord(detail?.item.type)} forever? This cannot be undone.`)) return;
  try {
    const state = await client.request("PURGE", { id, revision: detail?.revision ?? client.state.revision });
    await afterDelete(state);
  } catch (error) { announce(error.message, true); await client.refresh(); }
}
$("#empty-trash").addEventListener("click", async () => {
  if (!trash.length || !confirm(`Delete ${trash.length} item${trash.length === 1 ? "" : "s"} forever? This cannot be undone.`)) return;
  try {
    client.update(await client.request("EMPTY_TRASH", { revision: client.state.revision }));
    announce("Recently deleted emptied.");
    await refreshList();
  } catch (error) { announce(error.message, true); await client.refresh(); }
});

// Add and edit happen in a modal dialog (ui/login-form.js).
function openAdd(kind = view === "notes" ? "note" : view === "cards" ? "card" : "login", extra = {}) {
  const project = view.startsWith("project:") ? view.slice(8) : "";
  openLoginDialog({ client, kind, revision: client.state.revision, existing: items, projects, prefill: { project, ...extra }, onSaved: afterSave });
}
async function afterSave(state, id) {
  client.update(state); announce("Saved and encrypted.");
  // Read the list directly: refreshes triggered by the same change may finish in any order.
  const all = id ? null : await client.request("LIST", { query: "" }).catch(() => []);
  await refreshList();
  // Show the saved item: the edited one, or the newest for a new one.
  const shown = id ?? [...all].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id;
  if (shown) await select(shown);
}
async function afterDelete(state) { clearDetail(); client.update(state); announce("Deleted."); }
$("#add-login").addEventListener("click", () => openAdd());
$("#add-id").addEventListener("click", () => openAdd("identity"));

// Encrypted share: one item, protected by its own passphrase, merged by the recipient like a backup.
// Eye toggles for every passphrase/password field in static markup.
for (const id of ["share-password", "backup-password", "current-password", "next-password", "next-confirm", "recover-password", "recover-confirm"]) {
  const input = $(`#${id}`);
  if (input) passwordField(input, revealButton(input));
}
function downloadText(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// Recovery kit: an encrypted vault snapshot sealed under a random secret, split M-of-N.
// Any threshold of shares rebuilds the passphrase; the file merges in like any backup.
let kitBundle = null;
$("#create-kit").addEventListener("click", () => {
  kitBundle = null; $("#kit-setup").hidden = false; $("#kit-result").hidden = true;
  $("#kit-create").hidden = false; $("#kit-error").hidden = true;
  $("#kit-dialog").showModal();
});
$("#kit-cancel").addEventListener("click", () => $("#kit-dialog").close());
$("#kit-form").addEventListener("submit", async event => {
  event.preventDefault();
  const threshold = Number($("#kit-threshold").value), count = Number($("#kit-count").value);
  const fail = text => { $("#kit-error").textContent = text; $("#kit-error").hidden = false; };
  if (count < threshold) return fail("Total shares must be at least the shares needed.");
  $("#kit-create").disabled = true;
  try {
    const result = await client.request("RECOVERY_KIT", { threshold, count });
    kitBundle = result.bundle;
    $("#kit-shares").replaceChildren(...result.shares.map((share, index) => {
      const copy = iconButton("copy", `Copy share ${index + 1}`);
      copy.addEventListener("click", () => void copyText(share).then(() => announce(`Share ${index + 1} copied.`)).catch(error => announce(error.message, true)));
      return element("li", {}, element("code", {}, share), copy);
    }));
    $("#kit-setup").hidden = true; $("#kit-result").hidden = false; $("#kit-create").hidden = true;
  } catch (error) { fail(error.message); }
  finally { $("#kit-create").disabled = false; }
});
$("#kit-copy-all").addEventListener("click", () => {
  const shares = all("#kit-shares code").map(node => node.textContent).join("\n");
  if (shares) void copyText(shares).then(() => announce("All shares copied — keep them separate.")).catch(error => announce(error.message, true));
});
$("#kit-download").addEventListener("click", () => {
  if (kitBundle) downloadText("keybit-recovery.kvault", JSON.stringify(kitBundle, null, 2));
});

// Recovering: shares rebuild the bundle's passphrase locally, then the ordinary restore
// path replaces the vault, unlocks it with that passphrase, and sets the new master.
$("#recover-instead").addEventListener("click", () => {
  $("#recover-form").reset(); $("#recover-error").hidden = true;
  $("#recover-dialog").showModal();
});
$("#recover-cancel").addEventListener("click", () => $("#recover-dialog").close());
$("#recover-dialog").addEventListener("close", () => $("#recover-form").reset());
$("#recover-form").addEventListener("submit", async event => {
  event.preventDefault();
  const fail = text => { $("#recover-error").textContent = text; $("#recover-error").hidden = false; };
  const file = $("#recover-file").files[0];
  if (!file || file.size > 48 * 1024 * 1024) return fail("Choose the recovery file (.kvault).");
  const next = $("#recover-password").value;
  if ([...next].length < 12) return fail("Choose a new master password of at least 12 characters.");
  if (next !== $("#recover-confirm").value) return fail("The new passwords don't match.");
  let passphrase;
  try { passphrase = recoveryPassphrase(combineShares($("#recover-shares").value)); }
  catch (error) { return fail(error.message); }
  $("#recover-go").disabled = true;
  try {
    const preview = await client.request("PREPARE_IMPORT", { text: await file.text(), password: passphrase });
    await client.request("COMMIT_IMPORT", { token: preview.token, confirmed: true });
    client.update(await client.request("UNLOCK", { password: passphrase }));
    client.update(await client.request("CHANGE_PASSWORD", { current: passphrase, next }));
    $("#recover-dialog").close();
    announce(`Vault recovered — ${preview.count} item${preview.count === 1 ? "" : "s"}. Your new master password is active.`);
  } catch (error) { fail(error.message); await client.refresh(); }
  finally { passphrase = ""; $("#recover-go").disabled = false; }
});
let sharingId = null;
function openShare(item) {
  sharingId = item.id;
  $("#share-title").textContent = `Share “${item.name}”`;
  $("#share-note").textContent = item.type === "note"
    ? "Creates an encrypted file holding only this note. Send it however you like — the other person merges it in Backup with the passphrase you set here."
    : "Creates an encrypted file holding only this login, password and 2FA key included. Send it however you like — the other person merges it in Backup with the passphrase you set here.";
  $("#share-password").value = ""; $("#share-error").hidden = true;
  $("#share-dialog").showModal(); $("#share-password").focus();
}
$("#share-cancel").addEventListener("click", () => $("#share-dialog").close());
$("#share-dialog").addEventListener("close", () => { sharingId = null; $("#share-password").value = ""; });
$("#share-form").addEventListener("submit", async event => {
  event.preventDefault();
  const password = $("#share-password").value;
  const fail = text => { $("#share-error").textContent = text; $("#share-error").hidden = false; };
  if ([...password].length < 8) return fail("Use a share passphrase of at least 8 characters.");
  if (!sharingId) return;
  $("#share-save").disabled = true;
  try {
    const envelope = await client.request("SHARE_ITEM", { id: sharingId, password });
    $("#share-password").value = "";
    $("#share-dialog").close();
    const slug = (detail?.item.name ?? "item").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "item";
    const url = URL.createObjectURL(new Blob([JSON.stringify(envelope, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = `keybit-share-${slug}.kvault`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    announce("Share file saved. Send it to them and give them the passphrase — they merge it in Backup.");
  } catch (error) { fail(error.message); }
  finally { $("#share-save").disabled = false; }
});

// Auto-lock menu
function updateAutoLock(minutes) {
  const label = `Auto-lock: ${LOCK_LABELS[minutes] ?? `${minutes} minutes`}`;
  $("#autolock").title = label; $("#autolock").setAttribute("aria-label", label);
  $("#autolock").classList.toggle("timed", minutes !== 0);
  for (const option of all("#autolock-menu [data-minutes]")) option.setAttribute("aria-checked", String(Number(option.dataset.minutes) === minutes));
}
function toggleMenu(open = $("#autolock-menu").hidden) {
  $("#autolock-menu").hidden = !open; $("#autolock").setAttribute("aria-expanded", String(open));
  if (open) $("#autolock-menu [aria-checked='true']")?.focus();
}
$("#autolock").addEventListener("click", () => toggleMenu());
for (const option of all("#autolock-menu [data-minutes]")) {
  option.addEventListener("click", async () => {
    const minutes = Number(option.dataset.minutes);
    toggleMenu(false); $("#autolock").focus();
    try {
      client.update(await client.request("SETTINGS", { settings: { autoLockMinutes: minutes } }));
      updateAutoLock(minutes);
      announce(minutes ? `KeyBit will lock after ${LOCK_LABELS[minutes]} of inactivity.` : "Auto-lock set to Never. Quitting the browser still locks KeyBit.");
    } catch (error) { announce(error.message, true); await client.refresh(); }
  });
}
$("#autolock-menu").addEventListener("keydown", event => {
  const options = [...all("#autolock-menu [data-minutes]")];
  const index = options.indexOf(document.activeElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); options[(index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length].focus(); }
  if (event.key === "Escape") { toggleMenu(false); $("#autolock").focus(); }
});
document.addEventListener("pointerdown", event => { if (!(/** @type {Element} */ (event.target)).closest?.(".menu-anchor")) toggleMenu(false); });
$("#lock").addEventListener("click", () => void client.lock());

// Generator: Random or Memorable, remembered for every Generate button and sign-up field.
async function renderGenerator() {
  prefs ??= await loadPrefs();
  for (const button of all("[data-mode]")) button.setAttribute("aria-checked", String(button.dataset.mode === prefs.mode));
  $("#random-options").hidden = prefs.mode === "memorable"; $("#memorable-options").hidden = prefs.mode !== "memorable";
  $("#gen-length").value = prefs.length; $("#gen-length-value").textContent = String(prefs.length);
  $("#gen-words").value = prefs.words; $("#gen-words-value").textContent = String(prefs.words);
  for (const id of ["uppercase", "lowercase", "numbers", "symbols"]) $(`#${id}`).checked = prefs[id];
  await generate();
}
async function generate() {
  try { $("#gen-output").textContent = await generateWith(prefs); }
  catch (error) { $("#gen-output").textContent = ""; announce(error.message, true); }
}
async function updatePrefs(change) { prefs = { ...prefs, ...change }; await savePrefs(prefs); await renderGenerator(); }
for (const button of all("[data-mode]")) button.addEventListener("click", () => void updatePrefs({ mode: button.dataset.mode }));
$("#gen-again").addEventListener("click", () => void generate());
$("#gen-copy").addEventListener("click", () => { if ($("#gen-output").textContent) void copy($("#gen-output").textContent, "password"); });
$("#gen-length").addEventListener("input", () => void updatePrefs({ length: Number($("#gen-length").value) }));
$("#gen-words").addEventListener("input", () => void updatePrefs({ words: Number($("#gen-words").value) }));
for (const id of ["uppercase", "lowercase", "numbers", "symbols"]) $(`#${id}`).addEventListener("change", () => {
  if (!["uppercase", "lowercase", "numbers", "symbols"].some(group => $(`#${group}`).checked)) { $(`#${id}`).checked = true; return; }
  void updatePrefs({ [id]: $(`#${id}`).checked });
});

// Import from another password manager
$("#import-file").addEventListener("change", async () => {
  const file = $("#import-file").files[0];
  importItems = null; $("#import-preview").hidden = true;
  if (!file) return;
  try {
    if (file.size > MAX_BACKUP_BYTES) throw new Error("This file is too large to import.");
    const parsed = parseImport(await file.text(), file.name);
    const preview = await client.request("IMPORT_PREVIEW", { items: parsed.items });
    importItems = parsed.items;
    const total = preview.logins + preview.notes;
    const parts = [`Found ${preview.logins} login${preview.logins === 1 ? "" : "s"}${preview.notes ? ` and ${preview.notes} secure note${preview.notes === 1 ? "" : "s"}` : ""} to import.`];
    if (preview.duplicates) parts.push(`${preview.duplicates} already in KeyBit will be skipped.`);
    if (preview.invalid + parsed.skipped) parts.push(`${preview.invalid + parsed.skipped} entr${preview.invalid + parsed.skipped === 1 ? "y" : "ies"} (cards, identities, or unreadable rows) can't be imported.`);
    $("#import-summary").textContent = parts.join(" ");
    $("#import-confirm").textContent = `Import ${total} item${total === 1 ? "" : "s"}`;
    $("#import-confirm").disabled = !total;
    $("#import-preview").hidden = false;
  } catch (error) { announce(error.message, true); $("#import-file").value = ""; }
});
$("#import-confirm").addEventListener("click", async () => {
  if (!importItems) return;
  $("#import-confirm").disabled = true;
  try {
    const result = await client.request("IMPORT_COMMIT", { items: importItems, revision: client.state.revision });
    client.update(result.state);
    importItems = null; $("#import-preview").hidden = true; $("#import-file").value = "";
    announce(`Imported ${result.added} item${result.added === 1 ? "" : "s"}. Now delete the exported file; it holds your passwords unencrypted.`);
    await refreshList(); show("logins");
  } catch (error) { announce(error.message, true); }
  finally { $("#import-confirm").disabled = false; }
});
$("#import-cancel").addEventListener("click", () => { importItems = null; $("#import-preview").hidden = true; $("#import-file").value = ""; });

// Backup
async function loadBackupInfo(count = items.length) {
  const stored = /** @type {any} */ (await chrome.storage.local.get(["lastBackupAt", "backupSnoozedUntil", "autoBackup"]).catch(() => ({})));
  backupInfo = { lastBackupAt: stored.lastBackupAt ?? 0, snoozedUntil: stored.backupSnoozedUntil ?? 0 };
  // An automatic backup that saved recently counts as a backup.
  const latest = Math.max(backupInfo.lastBackupAt, stored.autoBackup?.status === "saved" ? stored.autoBackup.at : 0);
  const stale = Date.now() - latest > BACKUP_NUDGE_DAYS * 86400000;
  $("#backup-dot").hidden = !(stale && count);
  $("#backup-banner").hidden = !(stale && count && !$("#search").value && view === "logins" && Date.now() > backupInfo.snoozedUntil);
  renderBackupInfo();
}
function renderBackupInfo() {
  $("#last-backup").textContent = backupInfo.lastBackupAt ? `Last exported ${new Date(backupInfo.lastBackupAt).toLocaleString()}.` : "No backup exported from this browser yet.";
}
async function exportBackup() {
  try {
    const data = await client.request("EXPORT");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `keybit-backup-${new Date().toLocaleDateString("en-CA")}.kvault`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    // A non-secret timestamp for the backup reminder.
    await chrome.storage.local.set({ lastBackupAt: Date.now() }).catch(() => {});
    await loadBackupInfo();
    announce("Encrypted backup exported. Keep it and its master password safe.");
  } catch (error) { announce(error.message, true); }
}
$("#export").addEventListener("click", () => void exportBackup());
$("#export-csv").addEventListener("click", async () => {
  if (!confirm("Export a readable CSV? Anyone who opens it can see your passwords. Keep the file offline and delete it when the move is done.")) return;
  try {
    const csv = await client.request("EXPORT_CSV");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url; link.download = `keybit-${new Date().toLocaleDateString("en-CA")}.csv`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    announce("CSV exported. Delete the file when you're done — it shows your passwords.");
  } catch (error) { announce(error.message, true); }
});
$("#export-portable").addEventListener("click", async () => {
  if (!confirm("Export a portable vault? The HTML file opens your vault in any browser with the master password — keep it like a backup.")) return;
  try {
    const data = await client.request("EXPORT");
    downloadText(`keybit-vault-${new Date().toLocaleDateString("en-CA")}.html`, portableHtml(data));
    announce("Portable vault exported. It opens in any browser — guarded by the same master password.");
  } catch (error) { announce(error.message, true); }
});
$("#banner-export").addEventListener("click", () => void exportBackup());
$("#banner-later").addEventListener("click", async () => {
  await chrome.storage.local.set({ backupSnoozedUntil: Date.now() + 7 * 86400000 }).catch(() => {});
  await loadBackupInfo();
});
async function renderAutoBackup() {
  const folder = await getFolder();
  const { autoBackup } = /** @type {any} */ (await chrome.storage.local.get("autoBackup").catch(() => ({})));
  const supported = typeof (/** @type {any} */ (window)).showDirectoryPicker === "function";
  $("#auto-backup-card").hidden = !supported && !folder;
  $("#auto-backup-choose").textContent = folder ? "Change folder" : "Choose folder";
  $("#auto-backup-off").hidden = !folder;
  $("#auto-backup-reconnect").hidden = !folder || autoBackup?.status !== "reconnect";
  $("#auto-backup-status").textContent = !folder ? "Off." : autoBackup?.status === "saved" ? `On: “${folder.name}”, saved ${relativeTime(autoBackup.at)}.`
    : autoBackup?.status === "reconnect" ? `Paused: the browser needs permission for “${folder.name}” again. Click Reconnect.` : autoBackup?.status === "error" ? `Couldn't save to “${folder.name}”. Choose the folder again.` : `On: “${folder.name}”.`;
}
async function saveToFolder(ask) {
  // This page asks for folder permission (it needs a click); later saves happen in the background.
  const result = await writeBackup(await client.request("EXPORT"), { ask });
  await chrome.storage.local.set({ autoBackup: result });
  await renderAutoBackup();
  return result;
}
$("#auto-backup-choose").addEventListener("click", async () => {
  try {
    const handle = await (/** @type {any} */ (window)).showDirectoryPicker({ id: "keybit-backup", mode: "readwrite", startIn: "documents" });
    await setFolder(handle);
    const result = await saveToFolder(true);
    announce(result.status === "saved" ? `Automatic backup is on. KeyBit saved a copy in “${handle.name}”.` : "The browser didn't allow saving to that folder.", result.status !== "saved");
  } catch (error) { if (error?.name !== "AbortError") announce(error.message, true); }
});
$("#auto-backup-reconnect").addEventListener("click", async () => {
  try { const result = await saveToFolder(true); announce(result.status === "saved" ? "Reconnected. Automatic backup is on again." : "The browser didn't allow saving to that folder.", result.status !== "saved"); }
  catch (error) { announce(error.message, true); }
});
$("#auto-backup-off").addEventListener("click", async () => {
  await setFolder(null); await chrome.storage.local.remove("autoBackup");
  await renderAutoBackup(); announce("Automatic backup is off. Files already saved stay in the folder.");
});
async function readBackupFile() {
  const file = $("#backup-file").files[0];
  if (!file || file.size > MAX_BACKUP_BYTES) throw new Error("Choose an encrypted KeyBit backup (.kvault) no larger than 48 MB.");
  return file.text();
}
$("#merge-backup").addEventListener("click", async () => {
  if (!$("#backup-password").value) { announce("Enter the backup's master password.", true); return; }
  $("#merge-backup").disabled = true;
  let password = $("#backup-password").value;
  $("#backup-password").value = "";
  try {
    const result = await client.request("MERGE_BACKUP", { text: await readBackupFile(), password, revision: client.state.revision });
    client.update(result.state); $("#import-form").reset();
    announce(result.added || result.updated ? `Merged: ${result.added} added, ${result.updated} updated. Nothing was deleted.` : "Nothing to merge: this vault already has everything in the backup.");
    await refreshList();
  } catch (error) { announce(error.message, true); }
  finally { password = ""; $("#merge-backup").disabled = false; }
});
$("#import-form").addEventListener("submit", async event => {
  event.preventDefault(); importToken = null; $("#import-confirmation").hidden = true;
  $("#validate-import").disabled = true;
  // Validating locks the vault; stay on this view so the confirmation remains visible.
  restoring = true;
  let password = $("#backup-password").value;
  $("#backup-password").value = "";
  try {
    const preview = await client.request("PREPARE_IMPORT", { text: await readBackupFile(), password });
    importToken = preview.token;
    $("#import-description").textContent = `Backup verified: ${preview.count} item${preview.count === 1 ? "" : "s"}. ${preview.replaces ? "This replaces everything in the current vault. Export a backup first if you need to keep it." : "This becomes your vault on this device."}`;
    $("#confirm-import").textContent = preview.replaces ? "Replace vault with this backup" : "Restore this vault";
    $("#import-confirmation").hidden = false; announce("Backup verified. Review the replacement before confirming.");
    await client.refresh(); layout();
  } catch (error) { announce(error.message, true); await client.refresh(); layout(); }
  finally { password = ""; $("#validate-import").disabled = false; }
});
$("#confirm-import").addEventListener("click", async () => {
  if (!importToken) return;
  $("#confirm-import").disabled = true;
  try {
    client.update(await client.request("COMMIT_IMPORT", { token: importToken, confirmed: true }));
    importToken = null; $("#import-confirmation").hidden = true; $("#import-form").reset();
    restoring = false; layout();
    announce("Backup restored. Unlock it with the backup's master password.");
  } catch (error) { announce(error.message, true); }
  finally { $("#confirm-import").disabled = false; }
});
$("#cancel-import").addEventListener("click", () => { importToken = null; $("#import-confirmation").hidden = true; restoring = false; void client.lock(); });

// Settings
let passwordDialog = null;
function closeDialog() { if ($("#password-dialog").open) $("#password-dialog").close(); }
// "change": current + new password. "confirm": current password only (to turn on Touch ID).
function askPassword(mode) {
  const dialog = $("#password-dialog");
  clearFields(dialog); $("#password-error").hidden = true;
  $("#next-fields").hidden = mode !== "change";
  $("#password-dialog-title").textContent = mode === "change" ? "Change master password" : `Turn on ${biometricName()}`;
  $("#password-save").textContent = mode === "change" ? "Change password" : "Continue";
  $("#password-dialog-note").textContent = mode === "change" ? "At least 12 characters. Touch ID unlock, if on, needs to be set up again afterwards." : `Enter your master password, then confirm with ${biometricName()}.`;
  dialog.showModal(); $("#current-password").focus();
  return new Promise(resolve => { passwordDialog = resolve; });
}
$("#password-cancel").addEventListener("click", () => { closeDialog(); passwordDialog?.(null); passwordDialog = null; });
$("#password-dialog").addEventListener("cancel", () => { passwordDialog?.(null); passwordDialog = null; });
$("#password-dialog").addEventListener("close", () => clearFields($("#password-dialog")));
$("#password-form").addEventListener("submit", event => {
  event.preventDefault();
  const error = text => { $("#password-error").textContent = text; $("#password-error").hidden = false; };
  const current = $("#current-password").value;
  if (!current) return error("Enter your current master password.");
  let next = null;
  if (!$("#next-fields").hidden) {
    next = $("#next-password").value;
    if ([...next].length < 12) return error("Use a new master password of at least 12 characters.");
    if (next !== $("#next-confirm").value) return error("The new passwords don't match.");
  }
  const resolve = passwordDialog; passwordDialog = null;
  closeDialog(); resolve?.({ current, next });
});
$("#change-password").addEventListener("click", async () => {
  let answer = await askPassword("change");
  if (!answer) return;
  try {
    client.update(await client.request("CHANGE_PASSWORD", { current: answer.current, next: answer.next }));
    announce("Master password changed. Use the new one from now on.");
    await renderSettings();
  } catch (error) { announce(error.message, true); }
  finally { answer = null; }
});
$("#lock-on-sleep").addEventListener("change", async event => {
  try { client.update(await client.request("SETTINGS", { settings: { lockOnScreenLock: event.target.checked } })); announce(event.target.checked ? "KeyBit locks when your computer locks or sleeps." : "KeyBit stays unlocked when your computer locks."); }
  catch (error) { event.target.checked = !event.target.checked; announce(error.message, true); }
});
$("#confirm-production").addEventListener("change", async event => {
  try { client.update(await client.request("SETTINGS", { settings: { confirmProduction: event.target.checked } })); announce(event.target.checked ? "KeyBit confirms before opening a production environment." : "Environment switches open production without asking."); }
  catch (error) { event.target.checked = !event.target.checked; announce(error.message, true); }
});
$("#biometric").addEventListener("change", async event => {
  const toggle = event.target;
  if (!toggle.checked) {
    try { client.update(await client.request("BIOMETRIC_DISABLE")); announce(`${biometricName()} unlock is off. You can also remove the “KeyBit vault” passkey in your system's password settings.`); }
    catch (error) { toggle.checked = true; announce(error.message, true); }
    return;
  }
  toggle.checked = false;
  let answer = await askPassword("confirm");
  if (!answer) return;
  try {
    const passkey = await createBiometric();
    client.update(await client.request("BIOMETRIC_ENABLE", { password: answer.current, ...passkey }));
    toggle.checked = true;
    announce(`${biometricName()} unlock is on.`);
  } catch (error) { announce(error.message, true); }
  finally { answer = null; }
});
for (const button of all("[data-theme-choice]")) {
  button.addEventListener("click", async () => { await globalThis.keybitTheme.set(button.dataset.themeChoice); renderTheme(); });
}
function renderTheme() {
  const theme = globalThis.keybitTheme?.get() ?? "system";
  for (const button of all("[data-theme-choice]")) button.setAttribute("aria-checked", String(button.dataset.themeChoice === theme));
}
async function renderSettings() {
  renderTheme();
  const available = await biometricAvailable();
  $("#biometric-row").hidden = !available && !client.state.biometric;
  $("#biometric-title").textContent = `Unlock with ${biometricName()}`;
  $("#biometric").checked = !!client.state.biometric;
  const commands = await chrome.commands.getAll().catch(() => []);
  $("#shortcuts").replaceChildren(...commands.map(command => element("div", { className: "setting shortcut" },
    element("span", {}, command.name === "_execute_action" ? "Open the KeyBit popup" : command.description), element("kbd", {}, command.shortcut || "Not set"))));
}
$("#edit-shortcuts").addEventListener("click", () => void chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));

// Site rules: every origin with a non-default rule, edited in place. A rule at defaults is dropped.
const RULE_LABELS = { enabled: "On", logins: "Autofill", save: "Save prompts", generate: "Generated passwords", totp: "2FA codes", cards: "Cards & IDs", subdomains: "Include subdomains" };
async function refreshSites() {
  try { disabledSites = await client.request("SITE_RULES"); } catch { disabledSites = {}; }
  const origins = Object.keys(disabledSites);
  $("#nav-sites").hidden = !origins.length;
  $("#count-sites").textContent = String(origins.length);
  $("#disabled-sites").replaceChildren(...origins.map(origin => {
    const rule = disabledSites[origin];
    const card = element("div", { className: "site-permission rule-card" }, element("span", { className: "rule-origin" }, origin));
    const toggles = element("span", { className: "rule-toggles" });
    for (const [flag, text] of Object.entries(RULE_LABELS)) {
      const input = element("input", { type: "checkbox", "data-flag": flag });
      input.checked = !!rule[flag];
      input.disabled = !rule.enabled && flag !== "enabled";
      input.addEventListener("change", async () => {
        try {
          const url = new URL(origin);
          // Re-enabling still needs the browser's host permission for that site.
          if (flag === "enabled" && input.checked && !(await chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] }))) throw new Error("Site access was not allowed.");
          await client.request("SET_SITE_RULE", { origin, patch: { [flag]: input.checked } });
          announce(input.checked ? `${text} on for ${url.host}.` : `${text} off for ${url.host}.`);
        } catch (error) { input.checked = !input.checked; announce(error.message, true); }
        await refreshSites();
      });
      toggles.append(element("label", { className: "rule-toggle" }, input, text));
    }
    const reset = element("button", { type: "button", className: "text-button" }, "Reset");
    reset.addEventListener("click", async () => {
      try {
        await client.request("SET_SITE_RULE", { origin, patch: { enabled: true, logins: true, save: true, generate: true, totp: true, cards: true, subdomains: false } });
        announce(`Defaults restored for ${new URL(origin).host}.`);
        await refreshSites();
      } catch (error) { announce(error.message, true); }
    });
    card.append(toggles, reset);
    return card;
  }));
  if (view === "sites" && !origins.length) show("logins");
}

$("#version").textContent = `v${chrome.runtime.getManifest().version}`;
showReloadBanner(document.body);
const initial = decodeURIComponent(location.hash.slice(1));
const [initialView, initialQuery] = initial.split("?");
const focusId = initialView === "item" ? new URLSearchParams(initialQuery ?? "").get("id") : null;
show(["new", "new-note", "welcome", "item"].includes(initialView) ? "logins" : initial, false);
await client.refresh();
layout();
// The command palette's "Show in KeyBit" opens straight onto the item.
if (focusId) void select(focusId);
