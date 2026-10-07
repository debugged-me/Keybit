import { element, siteTile, icon, iconButton, clearFields } from "./common.js";
import { parseWebsite, scopeLabel, loginScope } from "../matching/url-matcher.js";
import { isWeak } from "../vault/health.js";
import { parseTotp } from "../vault/totp.js";
import { loadPrefs, generate } from "../generator/prefs.js";

// Accepts "example.com", "localhost/app", or a full URL. Local hosts default to http, everything else to https.
export function normalizeWebsite(value) {
  const text = value.trim();
  if (!text || /^[a-z][a-z\d+.-]*:\/\//i.test(text)) return text;
  const host = text.split(/[/:?#]/)[0];
  const local = /^(?:localhost|.+\.localhost|\d{1,3}(?:\.\d{1,3}){3}|.+\.test|.+\.local)$/i.test(host);
  return `${local ? "http" : "https"}://${text}`;
}
export function strength(password) {
  if (!password) return null;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(pattern => pattern.test(password)).length;
  if (isWeak(password)) return { level: 1, label: "Weak" };
  return (password.length >= 16 && classes >= 3) || (password.length >= 24 && classes >= 2) ? { level: 3, label: "Strong" } : { level: 2, label: "Good" };
}

const ENVIRONMENTS = [["other", "Other"], ["local", "Local"], ["development", "Development"], ["staging", "Staging"], ["production", "Production"]];
let dialog = null;
let hooks = null;
/** @type {any} The open dialog's context: { client, item, kind, revision, existing, onSaved, onDelete, snapshot }. */
let current = null;
/** @type {(id: string) => any} */
const $ = id => dialog.querySelector(`#${id}`);

function field(label, input, ...extra) { return element("div", { className: "form-field" }, element("label", { for: input.id }, label), input, ...extra); }
function build() {
  const passwordInput = element("input", { id: "password", type: "password", autocomplete: "new-password", maxlength: 4096, spellcheck: "false" });
  const reveal = element("button", { type: "button", className: "icon-button", id: "reveal", title: "Show password", "aria-label": "Show password", "aria-pressed": "false" }, icon("eye"));
  const generateButton = element("button", { type: "button", className: "icon-button", id: "generate", title: "Generate a strong password", "aria-label": "Generate a strong password" }, icon("key"));
  dialog = element("dialog", { id: "login-dialog", className: "modal", "aria-labelledby": "editor-title" },
    element("form", { id: "login-form", autocomplete: "off", novalidate: true },
      element("header", { className: "modal-header" }, element("h2", { id: "editor-title" }, "Add login"),
        element("button", { type: "button", className: "icon-button", id: "close-dialog", title: "Close", "aria-label": "Close" }, icon("close"))),
      element("div", { className: "modal-body" },
        element("div", { className: "login-only" },
          field("Website", element("input", { id: "website", maxlength: 2048, placeholder: "example.com or localhost/project", autocapitalize: "off", spellcheck: "false" }),
            element("div", { id: "scope-preview", className: "scope-preview", hidden: true }), element("div", { id: "extra-urls", className: "extra-urls" }),
            element("button", { type: "button", id: "add-url", className: "text-button" }, "+ Add another address"))),
        field("Name", element("input", { id: "name", maxlength: 200, placeholder: "Shown in KeyBit" })),
        element("div", { className: "login-only" },
          element("div", { className: "field-row" },
            field("Username or email", element("input", { id: "username", maxlength: 1024, autocapitalize: "off", spellcheck: "false", autocomplete: "off" })),
            field("Environment", element("select", { id: "environment" }, ...ENVIRONMENTS.map(([value, label]) => element("option", { value }, label))))),
          element("p", { id: "duplicate-note", className: "callout", hidden: true }),
          element("div", { className: "form-field" },
            element("div", { className: "label-row" }, element("label", { for: "password" }, "Password"),
              element("span", { id: "strength", className: "strength", hidden: true }, element("span", { className: "strength-bar" }, element("i"), element("i"), element("i")), element("span", { className: "strength-label" }))),
            element("div", { className: "password-field" }, passwordInput, element("span", { className: "field-actions" }, reveal, generateButton)))),
        field("Project", element("input", { id: "project", maxlength: 100, list: "project-list", placeholder: "Optional, e.g. SRMS", autocomplete: "off" }), element("datalist", { id: "project-list" })),
        element("div", { className: "login-only" },
          element("div", { id: "totp-field", className: "form-field", hidden: true },
            element("label", { for: "totp" }, "2FA setup key"), element("input", { id: "totp", maxlength: 1024, autocomplete: "off", spellcheck: "false", placeholder: "Setup key or otpauth:// link from the website" }),
            element("p", { className: "hint" }, "The key a website shows when you turn on an authenticator app. KeyBit then shows the 6-digit codes."))),
        element("div", { className: "form-field", id: "notes-field", hidden: true }, element("label", { for: "notes", id: "notes-label" }, "Notes"), element("textarea", { id: "notes", maxlength: 20000, spellcheck: "false" })),
        element("div", { className: "more-fields" },
          element("button", { type: "button", id: "toggle-totp", className: "text-button login-only" }, "+ Add 2FA code"),
          element("button", { type: "button", id: "toggle-notes", className: "text-button" }, "+ Add notes")),
        element("p", { id: "form-error", className: "form-error", role: "alert", hidden: true })),
      element("footer", { className: "modal-footer" },
        element("button", { type: "button", id: "delete", className: "text-button danger", hidden: true }, "Delete"),
        element("span", { className: "spacer" }),
        element("button", { type: "button", id: "cancel", className: "secondary-button" }, "Cancel"),
        element("button", { type: "submit", id: "save", className: "primary-button" }, "Save"))));
  document.body.append(dialog);

  const urlInputs = () => [$("website"), ...dialog.querySelectorAll(".extra-url input")];
  const addUrl = (value = "") => {
    const input = element("input", { maxlength: 2048, placeholder: "Another address for the same login", autocapitalize: "off", spellcheck: "false", "aria-label": "Another website address" });
    input.value = value;
    input.addEventListener("blur", () => { input.value = normalizeWebsite(input.value); });
    const remove = iconButton("close", "Remove this address");
    const row = element("div", { className: "extra-url" }, input, remove);
    remove.addEventListener("click", () => { row.remove(); $("add-url").hidden = false; });
    $("extra-urls").append(row);
    $("add-url").hidden = urlInputs().length >= 10;
    return input;
  };
  const preview = () => {
    let url = null;
    try { url = parseWebsite(normalizeWebsite($("website").value)); } catch { /* Shown on save. */ }
    $("scope-preview").hidden = !url;
    if (url) {
      const label = scopeLabel(url);
      const folder = loginScope(url) !== "/";
      $("scope-preview").replaceChildren(siteTile(label), element("span", {}, folder ? "Fills only in the " : "Fills on ", element("strong", {}, folder ? label.split("/").slice(1).join("/") : label), folder ? ` project on ${url.host}` : ""));
    }
    $("name").placeholder = current?.kind === "note" ? "Server keys, licence, Wi-Fi…" : url ? scopeLabel(url) : "Shown in KeyBit";
    duplicate(url);
  };
  // Same username on the same site or project: allowed, but say so before a second login is made.
  const duplicate = url => {
    const username = $("username").value.trim().toLowerCase();
    const match = url && username && current?.existing.find(item => item.id !== current.item?.id && item.scope === scopeLabel(url) && item.username.toLowerCase() === username);
    $("duplicate-note").hidden = !match;
    if (match) $("duplicate-note").textContent = `You already have ${match.username} on ${match.scope} (${match.name}). Saving keeps both logins.`;
  };
  const meter = () => {
    const result = strength(passwordInput.value);
    $("strength").hidden = !result;
    if (result) { $("strength").dataset.level = String(result.level); $("strength").querySelector(".strength-label").textContent = result.label; }
  };
  $("website").addEventListener("input", preview);
  $("website").addEventListener("blur", () => { $("website").value = normalizeWebsite($("website").value); preview(); });
  $("username").addEventListener("input", preview);
  $("add-url").addEventListener("click", () => addUrl().focus());
  passwordInput.addEventListener("input", meter);
  reveal.addEventListener("click", () => {
    const shown = reveal.getAttribute("aria-pressed") !== "true";
    reveal.setAttribute("aria-pressed", String(shown)); passwordInput.type = shown ? "text" : "password";
    reveal.title = shown ? "Hide password" : "Show password"; reveal.setAttribute("aria-label", reveal.title);
  });
  generateButton.addEventListener("click", async () => {
    try {
      passwordInput.value = await generate(await loadPrefs());
      if (reveal.getAttribute("aria-pressed") !== "true") reveal.click();
      meter();
    } catch (error) { showError(error.message); }
  });
  $("toggle-notes").addEventListener("click", () => { $("notes-field").hidden = false; $("toggle-notes").hidden = true; $("notes").focus(); });
  $("toggle-totp").addEventListener("click", () => { $("totp-field").hidden = false; $("toggle-totp").hidden = true; $("totp").focus(); });
  $("close-dialog").addEventListener("click", () => requestClose());
  $("cancel").addEventListener("click", () => requestClose());
  dialog.addEventListener("cancel", event => { event.preventDefault(); requestClose(); });
  dialog.addEventListener("close", reset);
  $("delete").addEventListener("click", async () => {
    if (!current?.item || !confirm(`Delete this ${current.kind === "note" ? "note" : "login"}? This cannot be undone.`)) return;
    const { item, revision, onDelete, client } = current;
    try { const state = await client.request("DELETE", { id: item.id, revision }); closeLoginDialog(); await onDelete?.(state, item.id); }
    catch (error) { showError(error.message); }
  });
  $("login-form").addEventListener("submit", async event => {
    event.preventDefault();
    showError("");
    const note = current.kind === "note";
    let item;
    if (note) {
      if (!$("name").value.trim()) { showError("Give the note a title."); $("name").focus(); return; }
      item = { id: current.item?.id ?? null, type: "note", name: $("name").value.trim(), notes: $("notes").value, project: $("project").value.trim(), favorite: current.item?.favorite ?? false };
    } else {
      const urls = [];
      for (const input of urlInputs()) {
        input.value = normalizeWebsite(input.value);
        if (!input.value && input !== $("website")) continue;
        try { urls.push(parseWebsite(input.value).href); } catch (error) { showError(error.message); input.focus(); return; }
      }
      if (!passwordInput.value) { showError("Enter a password, or generate one."); passwordInput.focus(); return; }
      const totp = $("totp").value.trim();
      if (totp) { try { parseTotp(totp); } catch (error) { showError(error.message); $("totp").focus(); return; } }
      item = { id: current.item?.id ?? null, type: "login", urls, name: $("name").value.trim() || scopeLabel(urls[0]), username: $("username").value.trim(),
        password: passwordInput.value, environment: $("environment").value, notes: $("notes").value, project: $("project").value.trim(), totp, favorite: current.item?.favorite ?? false };
    }
    $("save").disabled = true;
    try {
      const state = await current.client.request("SAVE", { item, revision: current.revision });
      const { onSaved } = current;
      closeLoginDialog();
      await onSaved?.(state, item.id);
    } catch (error) { showError(error.message); }
    finally { item = null; $("save").disabled = false; }
  });
  return { preview, meter, addUrl };
}
function showError(text) { const node = $("form-error"); node.textContent = text; node.hidden = !text; }
function values() { return [...dialog.querySelectorAll("input, select, textarea")].map(input => input.value).join("\u0000"); }
function requestClose() {
  if (current && values() !== current.snapshot && !confirm("Discard your changes? What you typed will be lost.")) return;
  closeLoginDialog();
}
function reset() {
  if (!dialog) return;
  clearFields($("login-form")); $("login-form").reset();
  $("extra-urls").replaceChildren();
  $("password").type = "password"; $("reveal").setAttribute("aria-pressed", "false");
  showError(""); current = null;
  document.documentElement.classList.remove("dialog-open");
}
export function closeLoginDialog() { if (dialog?.open) dialog.close(); else reset(); }

// Opens the add/edit dialog. `item` (with its secrets) edits an existing login or note; `prefill` seeds a new login.
// `kind` is "login" or "note"; `projects` fills the project suggestions.
/** @param {{ client: any, item?: any, kind?: string, revision?: number, prefill?: { website?: string, username?: string, environment?: string, project?: string },
 *  existing?: any[], projects?: string[], onSaved?: Function, onDelete?: Function }} options */
export function openLoginDialog({ client, item = null, kind = item?.type ?? "login", revision, prefill = {}, existing = [], projects = [], onSaved, onDelete }) {
  if (!dialog) hooks = build();
  if (dialog.open) dialog.close();
  current = { client, item, kind, revision, existing, onSaved, onDelete };
  const note = kind === "note";
  dialog.classList.toggle("note-mode", note);
  $("editor-title").textContent = `${item ? "Edit" : "Add"} ${note ? "secure note" : "login"}`;
  $("name").previousElementSibling.textContent = note ? "Title" : "Name";
  $("notes-label").textContent = note ? "Note" : "Notes";
  $("website").value = item?.urls?.[0] ?? prefill.website ?? "";
  for (const url of item?.urls?.slice(1) ?? []) hooks.addUrl(url);
  $("add-url").hidden = (item?.urls?.length ?? 1) >= 10;
  $("name").value = item?.name ?? "";
  $("username").value = item?.username ?? prefill.username ?? "";
  $("password").value = item?.password ?? "";
  $("environment").value = item?.environment ?? prefill.environment ?? "other";
  $("project").value = item?.project ?? prefill.project ?? "";
  $("project-list").replaceChildren(...projects.map(project => element("option", { value: project })));
  $("totp").value = item?.totp ?? "";
  $("notes").value = item?.notes ?? "";
  $("notes-field").hidden = !note && !item?.notes; $("toggle-notes").hidden = note || !!item?.notes;
  $("totp-field").hidden = !item?.totp; $("toggle-totp").hidden = !!item?.totp;
  $("delete").hidden = !item;
  hooks.preview(); hooks.meter();
  current.snapshot = values();
  document.documentElement.classList.add("dialog-open");
  dialog.showModal();
  // Start where typing is needed.
  (note ? $("name") : $("website").value ? (item ? $("name") : $("username")) : $("website")).focus();
}
