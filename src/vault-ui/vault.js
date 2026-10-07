import { VaultClient } from "../ui/client.js";
import { renderAuth } from "../ui/auth.js";
import { element, all, announce, clearFields, siteTile, icon, iconButton, copyText, showReloadBanner, relativeTime } from "../ui/common.js";
import { scopeLabel } from "../matching/url-matcher.js";
import { MAX_BACKUP_BYTES } from "../crypto/encoding.js";
import { totpCode } from "../vault/totp.js";
import { openLoginDialog, closeLoginDialog } from "../ui/login-form.js";
import { loadPrefs, savePrefs, generate as generateWith } from "../generator/prefs.js";
import { parseImport } from "../import/parsers.js";
import { getFolder, setFolder, writeBackup } from "../background/auto-backup.js";
import { biometricAvailable, biometricName, createBiometric } from "../ui/biometric.js";

/** @type {(selector: string) => any} Page elements are looked up by known IDs. */
const $ = selector => document.querySelector(selector);
const LIST_VIEWS = ["logins", "favorites", "notes"];
const VIEWS = [...LIST_VIEWS, "health", "generator", "import", "backup", "settings", "sites"];
const LOCK_LABELS = { 0: "Never", 1: "1 minute", 5: "5 minutes", 10: "10 minutes", 15: "15 minutes", 30: "30 minutes" };
const ENV_ORDER = ["production", "staging", "development", "local", "other"];
const ENV_LABELS = { production: "Production", staging: "Staging", development: "Development", local: "Local", other: "Other" };
const BACKUP_NUDGE_DAYS = 30;
let view = "logins";
let restoring = false;
let items = [];
let health = {};
let projects = [];
let disabledSites = [];
let selectedId = null;
let detail = null;           // { item, revision }: the selected item, including its secrets, until lock or deselect
let codeTicker = null;
let listRequest = 0;
let importToken = null;
let importItems = null;
let prefs = null;
let backupInfo = { lastBackupAt: 0, snoozedUntil: 0 };
let sort = (() => { try { return localStorage.getItem("keybit-sort") || "name"; } catch { return "name"; } })();

const client = new VaultClient((state, previous) => {
  renderAuth($("#auth"), client);
  if (!state.unlocked) { closeLoginDialog(); closeDialog(); clearDetail(); items = []; health = {}; $("#items").replaceChildren(); $("#health-list").replaceChildren(); }
  if (state.session !== previous.session) { $("#search").value = ""; selectedId = null; }
  if (state.unlocked) restoring = false;
  layout();
  $("#export").disabled = !state.exists;
  if (!state.unlocked) { if (previous.unlocked) clearFields($("#import-form")); return; }
  updateAutoLock(state.settings.autoLockMinutes);
  $("#lock-on-sleep").checked = state.settings.lockOnScreenLock !== false;
  $("#biometric").checked = !!state.biometric;
  void refreshList();
  void refreshSites();
  if (location.hash === "#new") { history.replaceState(null, "", location.pathname); show("logins"); openAdd("login"); }
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
  $("#welcome").hidden = !(location.hash === "#welcome" || (client.state.ready && !client.state.exists));
  if (restoring && !unlocked) show("backup", false);
}
const isList = name => LIST_VIEWS.includes(name) || name.startsWith("project:");
function show(name, remember = true) {
  view = VIEWS.includes(name) || (name.startsWith("project:") && projects.includes(name.slice(8))) ? name : "logins";
  if (view === "sites" && !disabledSites.length) view = "logins";
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
  const flags = health[item.id] ?? {};
  const note = item.type === "note";
  const secondary = note ? ["Secure note", item.project].filter(Boolean).join(" · ") : `${item.username || "No username"} · ${item.scope}`;
  const button = element("button", { type: "button", className: "item-row login-item", "data-id": item.id, "aria-current": String(item.id === selectedId) },
    note ? element("span", { className: "tile tone-6", "aria-hidden": "true" }, icon("note")) : siteTile(item.scope),
    element("span", { className: "details" }, element("span", { className: "primary" }, item.favorite ? "★ " : "", item.name), element("span", { className: "secondary" }, secondary)),
    element("span", { className: "row-badges" }, item.environment === "production" ? badge("Production", "production") : null,
      item.hasTotp ? badge("2FA", "totp") : null, flags.reused ? badge("Reused", "warn") : null, flags.weak ? badge("Weak", "weak") : null));
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
  if (view.startsWith("project:")) return item.project === view.slice(8);
  return item.type === "login";
}
function renderList() {
  if (!isList(view)) return;
  const query = $("#search").value;
  const project = view.startsWith("project:") ? view.slice(8) : null;
  const titles = { logins: "All logins", favorites: "Favorites", notes: "Secure notes" };
  $("#list-title").textContent = query ? `Results for “${query}”` : project ?? titles[view];
  $("#add-label").textContent = view === "notes" ? "Add note" : "Add login";
  // A search looks everywhere, not only in the current section.
  const shown = sorted(query ? items : items.filter(inView));
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
  else $("#items").append(element("p", { className: "empty" }, view === "favorites" ? "Star a login or note to keep it here." : view === "notes" ? "Keep licence keys, server details, or Wi-Fi passwords here, encrypted." : "Nothing in this project yet."));
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
    const [list, flags, names] = await Promise.all([client.request("LIST", { query: $("#search").value }), client.request("HEALTH").catch(() => ({})), client.request("PROJECTS").catch(() => [])]);
    if (!client.is(session) || request !== listRequest) return;
    items = list; health = flags; projects = names;
    renderProjects();
    renderList();
    const all = $("#search").value ? await client.request("LIST", { query: "" }) : items;
    if (!client.is(session)) return;
    const flagged = all.filter(item => health[item.id]?.reused || health[item.id]?.weak);
    $("#count-logins").textContent = String(all.filter(item => item.type === "login").length);
    $("#count-favorites").textContent = String(all.filter(item => item.favorite).length || "");
    $("#count-notes").textContent = String(all.filter(item => item.type === "note").length || "");
    $("#count-health").textContent = String(flagged.length); $("#count-health").hidden = !flagged.length;
    $("#health-list").replaceChildren(...flagged.map(item => row(item, () => { show("logins"); void select(item.id); })));
    if (!flagged.length) $("#health-list").append(element("p", { className: "empty" }, "No weak or reused passwords. Nice."));
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
$("#sort").value = sort;
$("#sort").addEventListener("change", () => { sort = $("#sort").value; try { localStorage.setItem("keybit-sort", sort); } catch { /* Not saved. */ } renderList(); });

// Details
function clearDetail() {
  clearInterval(codeTicker); codeTicker = null;
  selectedId = null; detail = null;
  $("#detail-view").replaceChildren(); $("#detail").hidden = true;
  $("#view-logins").classList.remove("has-detail");
  for (const node of all(".item-row[aria-current='true']")) node.setAttribute("aria-current", "false");
}
async function select(id) {
  const session = client.state.session;
  selectedId = id;
  for (const node of all(".item-row")) node.setAttribute("aria-current", String(node.dataset.id === id));
  try {
    const response = await client.request("ITEM", { id });
    if (!client.is(session) || selectedId !== id) return;
    detail = { item: response.item, revision: response.state.revision };
    renderDetail();
  } catch (error) { announce(error.message, true); clearDetail(); await client.refresh(); }
}
async function copy(value, what) {
  try { await copyText(value); announce(what === "password" ? "Password copied. Clipboard is not cleared automatically." : `${what[0].toUpperCase()}${what.slice(1)} copied.`); }
  catch (error) { announce(error.message, true); }
}
function secretValue(password) {
  const value = element("span", { className: "secret masked" }, "••••••••••••");
  const reveal = iconButton("eye", "Show password", { "aria-pressed": "false" });
  reveal.addEventListener("click", () => {
    const shown = reveal.getAttribute("aria-pressed") !== "true";
    reveal.setAttribute("aria-pressed", String(shown)); reveal.title = shown ? "Hide password" : "Show password"; reveal.setAttribute("aria-label", reveal.title);
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
  const flags = health[item.id] ?? {};
  const scope = note ? "" : scopeLabel(item.urls[0]);
  const back = iconButton("back", "Back to list", { className: "icon-button back-button" });
  back.addEventListener("click", clearDetail);
  const star = iconButton("star", item.favorite ? "Remove from favorites" : "Add to favorites", { className: `icon-button star${item.favorite ? " on" : ""}`, "aria-pressed": String(item.favorite) });
  star.addEventListener("click", () => void toggleFavorite());
  const fields = [];
  if (note) fields.push(element("div", { className: "field" }, element("div", { className: "field-label" }, "Note"), element("p", { className: "notes" }, item.notes || "—"), item.notes ? element("div", { className: "field-value" }, copyButton(item.notes, "note")) : null));
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
  const warnings = [];
  if (flags.reused) warnings.push(element("p", { className: "warning" }, icon("alert"), `This password is also used by ${flags.reused} other login${flags.reused === 1 ? "" : "s"}. Change it on this site to a unique one.`));
  if (flags.weak) warnings.push(element("p", { className: "warning weak" }, icon("alert"), "This password is short or simple. Generate a stronger one when you next change it."));
  let history = null;
  if (!note && item.history.length) {
    history = element("details", { className: "history" }, element("summary", {}, `Password history (${item.history.length})`),
      ...item.history.map(entry => {
        const [value, reveal] = secretValue(entry.password);
        const restore = iconButton("undo", "Restore this password");
        restore.addEventListener("click", () => void restorePassword(entry.password));
        return element("div", { className: "history-entry" },
          element("span", { className: "when" }, `Replaced ${new Date(entry.changedAt).toLocaleString()}`, value), reveal, copyButton(entry.password, "password"), restore);
      }));
  }
  const edit = element("button", { type: "button", className: "secondary-button", id: "edit-login" }, "Edit");
  edit.addEventListener("click", () => openLoginDialog({ client, item: detail.item, revision: detail.revision, existing: items, projects, onSaved: afterSave, onDelete: afterDelete }));
  const remove = element("button", { type: "button", className: "text-button danger" }, "Delete");
  remove.addEventListener("click", () => void deleteItem(item.id));
  const meta = [item.project ? `Project ${item.project}` : null, `Updated ${relativeTime(Date.parse(item.updatedAt))}`].filter(Boolean).join(" · ");
  $("#detail-view").replaceChildren(...[
    element("div", { className: "detail-header" }, back, note ? element("span", { className: "tile tone-6", "aria-hidden": "true" }, icon("note")) : siteTile(scope),
      element("h3", {}, item.name, element("span", { className: "site" }, note ? "Secure note" : scope,
        !note && item.environment !== "other" ? badge(item.environment, item.environment === "production" ? "production" : "") : null)), star),
    ...warnings, ...fields, history,
    element("div", { className: "detail-actions" }, edit, remove, element("span", { className: "meta" }, meta))
  ].filter(Boolean));
  $("#detail").hidden = false; $("#view-logins").classList.add("has-detail");
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
async function deleteItem(id) {
  if (!confirm(`Delete this ${detail?.item.type === "note" ? "note" : "login"}? This cannot be undone.`)) return;
  try {
    const state = await client.request("DELETE", { id, revision: detail?.revision ?? client.state.revision });
    await afterDelete(state);
  } catch (error) { announce(error.message, true); await client.refresh(); }
}

// Add and edit happen in a modal dialog (ui/login-form.js).
function openAdd(kind = view === "notes" ? "note" : "login") {
  const project = view.startsWith("project:") ? view.slice(8) : "";
  openLoginDialog({ client, kind, revision: client.state.revision, existing: items, projects, prefill: { project }, onSaved: afterSave });
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

// Sites turned off (the list and its section only exist while some site is off)
async function refreshSites() {
  try { disabledSites = await client.request("DISABLED_SITES"); } catch { disabledSites = []; }
  $("#nav-sites").hidden = !disabledSites.length;
  $("#count-sites").textContent = String(disabledSites.length);
  $("#disabled-sites").replaceChildren(...disabledSites.map(origin => {
    const enable = element("button", { type: "button", className: "text-button" }, "Turn on");
    enable.addEventListener("click", async () => {
      const url = new URL(origin);
      try {
        if (!(await chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] }))) throw new Error("Site access was not allowed.");
        await client.request("SET_SITE_ENABLED", { origin, enabled: true });
        announce(`KeyBit is back on for ${url.host}.`);
        await refreshSites();
      } catch (error) { announce(error.message, true); }
    });
    return element("div", { className: "site-permission" }, element("span", {}, origin), enable);
  }));
  if (view === "sites" && !disabledSites.length) show("logins");
}

$("#version").textContent = `v${chrome.runtime.getManifest().version}`;
showReloadBanner(document.body);
const initial = decodeURIComponent(location.hash.slice(1));
show(["new", "welcome"].includes(initial) ? "logins" : initial, false);
await client.refresh();
layout();
