import { VaultClient } from "../ui/client.js";
import { renderAuth } from "../ui/auth.js";
import { element, announce, clearFields, siteTile, iconButton, copyText, showReloadBanner } from "../ui/common.js";
import { generatePassword } from "../generator/password-generator.js";
import { parseWebsite, scopeLabel } from "../matching/url-matcher.js";
import { MAX_BACKUP_BYTES } from "../crypto/encoding.js";
import { openLoginDialog, closeLoginDialog } from "../ui/login-form.js";

const $ = selector => document.querySelector(selector);
const VIEWS = ["logins", "health", "generator", "backup", "sites"];
const LOCK_LABELS = { 0: "Never", 1: "1 minute", 5: "5 minutes", 10: "10 minutes", 15: "15 minutes", 30: "30 minutes" };
const BACKUP_NUDGE_DAYS = 30;
let view = "logins";
let restoring = false;
let items = [];
let health = {};
let disabledSites = [];
let selectedId = null;
let detail = null;           // { item, revision }: the selected login, including its password, until lock or deselect
let listRequest = 0;
let importToken = null;
let backupInfo = { lastBackupAt: 0, snoozedUntil: 0 };

const client = new VaultClient((state, previous) => {
  renderAuth($("#auth"), client);
  if (!state.unlocked) { closeLoginDialog(); clearDetail(); items = []; health = {}; $("#items").replaceChildren(); $("#health-list").replaceChildren(); }
  if (state.session !== previous.session) { $("#search").value = ""; selectedId = null; }
  if (state.unlocked) restoring = false;
  layout();
  $("#export").disabled = !state.exists;
  if (!state.unlocked) { if (previous.unlocked) clearFields($("#import-form")); return; }
  updateAutoLock(state.settings.autoLockMinutes);
  void refreshList();
  void refreshSites();
  if (location.hash === "#new") { history.replaceState(null, "", location.pathname); show("logins"); openAdd(); }
  // Another window or a save prompt changed the vault: reload the open login unless it is being edited.
  else if (selectedId && previous.revision !== state.revision && !document.querySelector("#login-dialog")?.open) void select(selectedId);
});

// Layout and navigation
function layout() {
  const unlocked = client.state.unlocked;
  $("#locked").hidden = unlocked || restoring;
  $("#app").hidden = !unlocked && !restoring;
  $("#sidebar").hidden = !unlocked;
  $("#search-box").hidden = !unlocked; $("#header-actions").hidden = !unlocked;
  $("#back-to-unlock").hidden = unlocked;
  if (restoring && !unlocked) show("backup", false);
}
function show(name, remember = true) {
  view = VIEWS.includes(name) ? name : "logins";
  if (view === "sites" && !disabledSites.length) view = "logins";
  for (const candidate of VIEWS) $(`#view-${candidate}`).hidden = candidate !== view;
  for (const nav of document.querySelectorAll(".nav-item")) nav.setAttribute("aria-current", nav.dataset.view === view ? "page" : "false");
  if (remember) history.replaceState(null, "", `#${view}`);
  if (view === "generator" && !$("#gen-output").textContent) generate();
  if (view === "backup") renderBackupInfo();
}
for (const nav of document.querySelectorAll(".nav-item")) nav.addEventListener("click", () => show(nav.dataset.view));
$("#restore-instead").addEventListener("click", () => { restoring = true; layout(); });
$("#back-to-unlock").addEventListener("click", () => { restoring = false; layout(); });

// Login list
const badge = (text, kind) => element("span", { className: `badge ${kind}` }, text);
function row(item, onClick) {
  const flags = health[item.id] ?? {};
  const button = element("button", { type: "button", className: "item-row login-item", "data-id": item.id, "aria-current": String(item.id === selectedId) },
    siteTile(item.scope),
    element("span", { className: "details" }, element("span", { className: "primary" }, item.name),
      element("span", { className: "secondary" }, `${item.username || "No username"} · ${item.scope}`)),
    element("span", { className: "row-badges" }, item.environment === "production" ? badge("Production", "production") : null,
      flags.reused ? badge("Reused", "warn") : null, flags.weak ? badge("Weak", "weak") : null));
  button.addEventListener("click", onClick);
  return button;
}
async function refreshList() {
  const request = ++listRequest;
  const session = client.state.session;
  const query = $("#search").value;
  try {
    // Health is extra information: if it is unavailable, the logins must still show.
    const [list, flags] = await Promise.all([client.request("LIST", { query }), client.request("HEALTH").catch(() => ({}))]);
    if (!client.is(session) || request !== listRequest) return;
    items = list; health = flags;
    $("#list-title").textContent = query ? `Results for “${query}”` : "All logins";
    $("#items").replaceChildren(...items.map(item => row(item, () => void select(item.id))));
    if (!items.length) $("#items").append(element("p", { className: "empty" }, query ? "No logins match your search." : "Your vault is empty. Add a login, or sign in to a website and KeyBit will offer to save it."));
    const flagged = Object.entries(health).filter(([, value]) => value.reused || value.weak).map(([id]) => id);
    $("#count-logins").textContent = String(Object.keys(health).length || (query ? "" : items.length));
    $("#count-health").textContent = String(flagged.length); $("#count-health").hidden = !flagged.length;
    await renderHealth(flagged, session);
    await loadBackupInfo();
  } catch (error) { announce(error.message, true); }
}
async function renderHealth(flagged, session) {
  // The list above may be filtered by search; the health view always covers the whole vault.
  const all = $("#search").value ? await client.request("LIST", { query: "" }) : items;
  if (!client.is(session)) return;
  const byId = new Map(all.map(item => [item.id, item]));
  const rows = flagged.map(id => byId.get(id)).filter(Boolean).map(item => row(item, () => { show("logins"); void select(item.id); }));
  $("#health-list").replaceChildren(...rows);
  if (!rows.length) $("#health-list").append(element("p", { className: "empty" }, "No weak or reused passwords. Nice."));
}
$("#search").addEventListener("input", () => { show("logins"); void refreshList(); });

// Login details
function clearDetail() {
  selectedId = null; detail = null;
  $("#detail-view").replaceChildren(); $("#detail").hidden = true;
  $("#view-logins").classList.remove("has-detail");
  for (const node of document.querySelectorAll(".item-row[aria-current='true']")) node.setAttribute("aria-current", "false");
}
async function select(id) {
  const session = client.state.session;
  selectedId = id;
  for (const node of document.querySelectorAll(".item-row")) node.setAttribute("aria-current", String(node.dataset.id === id));
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
function renderDetail() {
  const { item } = detail;
  const flags = health[item.id] ?? {};
  const scope = scopeLabel(item.urls[0]);
  const back = iconButton("back", "Back to list", { className: "icon-button back-button" });
  back.addEventListener("click", clearDetail);
  const copyButton = (value, what) => { const button = iconButton("copy", `Copy ${what}`); button.addEventListener("click", () => void copy(value, what)); return button; };
  const open = iconButton("external", "Open website");
  open.addEventListener("click", () => void chrome.tabs.create({ url: item.urls[0] }));
  const fields = [
    element("div", { className: "field" }, element("div", { className: "field-label" }, "Username"),
      element("div", { className: "field-value" }, element("span", {}, item.username || "—"), item.username ? copyButton(item.username, "username") : null)),
    element("div", { className: "field" }, element("div", { className: "field-label" }, "Password"),
      element("div", { className: "field-value" }, ...secretValue(item.password), copyButton(item.password, "password"))),
    element("div", { className: "field" }, element("div", { className: "field-label" }, "Website"),
      element("div", { className: "field-value" }, element("span", {}, item.urls[0]), open))
  ];
  if (item.notes) fields.push(element("div", { className: "field" }, element("div", { className: "field-label" }, "Notes"), element("p", { className: "notes" }, item.notes)));
  const warnings = [];
  if (flags.reused) warnings.push(element("p", { className: "warning" }, `This password is also used by ${flags.reused} other login${flags.reused === 1 ? "" : "s"}. Change it on this site to a unique one.`));
  if (flags.weak) warnings.push(element("p", { className: "warning weak" }, "This password is short or simple. Generate a stronger one when you next change it."));
  let history = null;
  if (item.history.length) {
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
  edit.addEventListener("click", () => openLoginDialog({ client, item: detail.item, revision: detail.revision, existing: items, generatorOptions, onSaved: afterSave, onDelete: afterDelete }));
  const remove = element("button", { type: "button", className: "text-button danger" }, "Delete");
  remove.addEventListener("click", () => void deleteLogin(item.id));
  $("#detail-view").replaceChildren(...[
    element("div", { className: "detail-header" }, back, siteTile(scope),
      element("h3", {}, item.name, element("span", { className: "site" }, scope,
        item.environment !== "other" ? badge(item.environment, item.environment === "production" ? "production" : "") : null))),
    ...warnings, ...fields, history,
    element("div", { className: "detail-actions" }, edit, remove, element("span", { className: "meta" }, `Updated ${new Date(item.updatedAt).toLocaleDateString()}`))
  ].filter(Boolean));
  $("#detail").hidden = false; $("#view-logins").classList.add("has-detail");
}
async function restorePassword(password) {
  if (!detail || !confirm("Restore this password? The current one moves to the password history.")) return;
  try {
    const state = await client.request("SAVE", { item: { ...detail.item, password }, revision: detail.revision });
    client.update(state); announce("Password restored. The previous one is in the history.");
    await select(detail.item.id);
  } catch (error) { announce(error.message, true); await client.refresh(); }
}
async function deleteLogin(id) {
  if (!confirm("Delete this login? This cannot be undone.")) return;
  try {
    const state = await client.request("DELETE", { id, revision: detail?.revision ?? client.state.revision });
    await afterDelete(state);
  } catch (error) { announce(error.message, true); await client.refresh(); }
}

// Add and edit happen in a modal dialog (ui/login-form.js).
function openAdd() {
  openLoginDialog({ client, revision: client.state.revision, existing: items, generatorOptions, onSaved: afterSave });
}
async function afterSave(state, id) {
  client.update(state); announce("Login saved and encrypted.");
  await refreshList();
  // Show the saved login: the edited one, or the newest for a new login.
  const shown = id ?? [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id;
  if (shown) await select(shown);
}
async function afterDelete(state) { clearDetail(); client.update(state); announce("Login deleted."); }
$("#add-login").addEventListener("click", () => { show("logins"); openAdd(); });

// Auto-lock menu
function updateAutoLock(minutes) {
  const label = `Auto-lock: ${LOCK_LABELS[minutes] ?? `${minutes} minutes`}`;
  $("#autolock").title = label; $("#autolock").setAttribute("aria-label", label);
  $("#autolock").classList.toggle("timed", minutes !== 0);
  for (const option of document.querySelectorAll("#autolock-menu [data-minutes]")) option.setAttribute("aria-checked", String(Number(option.dataset.minutes) === minutes));
}
function toggleMenu(open = $("#autolock-menu").hidden) {
  $("#autolock-menu").hidden = !open; $("#autolock").setAttribute("aria-expanded", String(open));
  if (open) document.querySelector("#autolock-menu [aria-checked='true']")?.focus();
}
$("#autolock").addEventListener("click", () => toggleMenu());
for (const option of document.querySelectorAll("#autolock-menu [data-minutes]")) {
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
  const options = [...document.querySelectorAll("#autolock-menu [data-minutes]")];
  const index = options.indexOf(document.activeElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); options[(index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length].focus(); }
  if (event.key === "Escape") { toggleMenu(false); $("#autolock").focus(); }
});
document.addEventListener("pointerdown", event => { if (!event.target.closest(".menu-anchor")) toggleMenu(false); });
$("#lock").addEventListener("click", () => void client.lock());

// Generator
function generatorOptions() {
  return { length: Number($("#gen-length").value), uppercase: $("#uppercase").checked, lowercase: $("#lowercase").checked, numbers: $("#numbers").checked, symbols: $("#symbols").checked };
}
function generate() {
  try { $("#gen-output").textContent = generatePassword(generatorOptions()); }
  catch (error) { $("#gen-output").textContent = ""; announce(error.message, true); }
}
$("#gen-again").addEventListener("click", generate);
$("#gen-copy").addEventListener("click", () => { if ($("#gen-output").textContent) void copy($("#gen-output").textContent, "password"); });
$("#gen-length").addEventListener("input", () => { $("#gen-length-value").textContent = $("#gen-length").value; generate(); });
for (const id of ["uppercase", "lowercase", "numbers", "symbols"]) $(`#${id}`).addEventListener("change", generate);

// Backup
async function loadBackupInfo() {
  const stored = await chrome.storage.local.get(["lastBackupAt", "backupSnoozedUntil"]).catch(() => ({}));
  backupInfo = { lastBackupAt: stored.lastBackupAt ?? 0, snoozedUntil: stored.backupSnoozedUntil ?? 0 };
  const stale = Date.now() - backupInfo.lastBackupAt > BACKUP_NUDGE_DAYS * 86400000;
  $("#backup-dot").hidden = !(stale && items.length);
  $("#backup-banner").hidden = !(stale && items.length && !$("#search").value && Date.now() > backupInfo.snoozedUntil);
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
$("#import-form").addEventListener("submit", async event => {
  event.preventDefault(); importToken = null; $("#import-confirmation").hidden = true;
  $("#validate-import").disabled = true;
  // Validating locks the vault; stay on this view so the confirmation remains visible.
  restoring = true;
  let password = $("#backup-password").value;
  $("#backup-password").value = "";
  try {
    const file = $("#backup-file").files[0];
    if (!file || file.size > MAX_BACKUP_BYTES) throw new Error("Choose an encrypted KeyBit backup (.kvault) no larger than 48 MB.");
    const preview = await client.request("PREPARE_IMPORT", { text: await file.text(), password });
    importToken = preview.token;
    $("#import-description").textContent = `Backup verified: ${preview.count} login${preview.count === 1 ? "" : "s"}. ${preview.replaces ? "This replaces every login in the current vault. Export a backup first if you need to keep them." : "This becomes your vault on this device."}`;
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
show(location.hash.slice(1) === "new" ? "logins" : location.hash.slice(1), false);
await client.refresh();
