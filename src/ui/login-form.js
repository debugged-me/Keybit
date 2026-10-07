import { element, siteTile, icon, clearFields } from "./common.js";
import { generatePassword } from "../generator/password-generator.js";
import { parseWebsite, scopeLabel, loginScope } from "../matching/url-matcher.js";
import { isWeak } from "../vault/health.js";

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
  return password.length >= 16 && classes >= 3 ? { level: 3, label: "Strong" } : { level: 2, label: "Good" };
}

const ENVIRONMENTS = [["other", "Other"], ["local", "Local"], ["development", "Development"], ["staging", "Staging"], ["production", "Production"]];
let dialog = null;
let current = null;   // { item, revision, existing, onSaved, onDelete, snapshot }

function build() {
  const $ = id => dialog.querySelector(`#${id}`);
  const field = (label, input, extra = null) => element("div", { className: "form-field" }, element("label", { for: input.id }, label), input, extra);
  const passwordInput = element("input", { id: "password", type: "password", autocomplete: "new-password", required: true, maxlength: 4096, spellcheck: "false" });
  const reveal = element("button", { type: "button", className: "icon-button", id: "reveal", title: "Show password", "aria-label": "Show password", "aria-pressed": "false" }, icon("eye"));
  const generate = element("button", { type: "button", className: "icon-button", id: "generate", title: "Generate a strong password", "aria-label": "Generate a strong password" }, icon("key"));
  dialog = element("dialog", { id: "login-dialog", className: "modal", "aria-labelledby": "editor-title" },
    element("form", { id: "login-form", autocomplete: "off", novalidate: true },
      element("header", { className: "modal-header" }, element("h2", { id: "editor-title" }, "Add login"),
        element("button", { type: "button", className: "icon-button", id: "close-dialog", title: "Close", "aria-label": "Close" }, icon("close"))),
      element("div", { className: "modal-body" },
        field("Website", element("input", { id: "website", required: true, maxlength: 2048, placeholder: "example.com or localhost/project", autocapitalize: "off", spellcheck: "false" }),
          element("div", { id: "scope-preview", className: "scope-preview", hidden: true })),
        field("Name", element("input", { id: "name", maxlength: 200, placeholder: "Shown in KeyBit" })),
        element("div", { className: "field-row" },
          field("Username or email", element("input", { id: "username", maxlength: 1024, autocapitalize: "off", spellcheck: "false", autocomplete: "off" })),
          field("Environment", element("select", { id: "environment" }, ...ENVIRONMENTS.map(([value, label]) => element("option", { value }, label))))),
        element("p", { id: "duplicate-note", className: "callout", hidden: true }),
        element("div", { className: "form-field" },
          element("div", { className: "label-row" }, element("label", { for: "password" }, "Password"),
            element("span", { id: "strength", className: "strength", hidden: true }, element("span", { className: "strength-bar" }, element("i"), element("i"), element("i")), element("span", { className: "strength-label" }))),
          element("div", { className: "password-field" }, passwordInput, element("span", { className: "field-actions" }, reveal, generate))),
        element("button", { type: "button", id: "toggle-notes", className: "text-button" }, "+ Add notes"),
        element("div", { id: "notes-field", className: "form-field", hidden: true }, element("label", { for: "notes" }, "Notes"), element("textarea", { id: "notes", maxlength: 20000, spellcheck: "false" })),
        element("p", { id: "form-error", className: "form-error", role: "alert", hidden: true })),
      element("footer", { className: "modal-footer" },
        element("button", { type: "button", id: "delete", className: "text-button danger", hidden: true }, "Delete login"),
        element("span", { className: "spacer" }),
        element("button", { type: "button", id: "cancel", className: "secondary-button" }, "Cancel"),
        element("button", { type: "submit", id: "save", className: "primary-button" }, "Save login"))));
  document.body.append(dialog);

  const preview = () => {
    let url = null;
    try { url = parseWebsite(normalizeWebsite($("website").value)); } catch { /* Shown on save. */ }
    $("scope-preview").hidden = !url;
    if (url) {
      const label = scopeLabel(url);
      const folder = loginScope(url) !== "/";
      $("scope-preview").replaceChildren(siteTile(label), element("span", {}, folder ? "Fills only in the " : "Fills on ", element("strong", {}, folder ? label.split("/").slice(1).join("/") : label), folder ? ` project on ${url.host}` : ""));
      $("name").placeholder = label;
    } else $("name").placeholder = "Shown in KeyBit";
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
  passwordInput.addEventListener("input", meter);
  reveal.addEventListener("click", () => {
    const shown = reveal.getAttribute("aria-pressed") !== "true";
    reveal.setAttribute("aria-pressed", String(shown)); passwordInput.type = shown ? "text" : "password";
    reveal.title = shown ? "Hide password" : "Show password"; reveal.setAttribute("aria-label", reveal.title);
  });
  generate.addEventListener("click", () => {
    try {
      passwordInput.value = generatePassword(current.generatorOptions());
      if (reveal.getAttribute("aria-pressed") !== "true") reveal.click();
      meter();
    } catch (error) { showError(error.message); }
  });
  $("toggle-notes").addEventListener("click", () => { $("notes-field").hidden = false; $("toggle-notes").hidden = true; $("notes").focus(); });
  $("close-dialog").addEventListener("click", () => requestClose());
  $("cancel").addEventListener("click", () => requestClose());
  dialog.addEventListener("cancel", event => { event.preventDefault(); requestClose(); });
  dialog.addEventListener("close", reset);
  $("delete").addEventListener("click", async () => {
    if (!current?.item || !confirm("Delete this login? This cannot be undone.")) return;
    const { item, revision, onDelete } = current;
    try { const state = await current.client.request("DELETE", { id: item.id, revision }); closeLoginDialog(); await onDelete?.(state, item.id); }
    catch (error) { showError(error.message); }
  });
  $("login-form").addEventListener("submit", async event => {
    event.preventDefault();
    showError("");
    const website = normalizeWebsite($("website").value);
    $("website").value = website;
    let url;
    try { url = parseWebsite(website); } catch (error) { showError(error.message); $("website").focus(); return; }
    if (!passwordInput.value) { showError("Enter a password, or generate one."); passwordInput.focus(); return; }
    let item = { id: current.item?.id ?? null, urls: [website], name: $("name").value.trim() || scopeLabel(url),
      username: $("username").value.trim(), password: passwordInput.value, environment: $("environment").value, notes: $("notes").value };
    $("save").disabled = true;
    try {
      const state = await current.client.request("SAVE", { item, revision: current.revision });
      const { onSaved } = current;
      closeLoginDialog();
      await onSaved?.(state, item.id);
    } catch (error) { showError(error.message); }
    finally { item = null; $("save").disabled = false; }
  });
  return { preview, meter };
}
let hooks = null;
function showError(text) { const node = dialog.querySelector("#form-error"); node.textContent = text; node.hidden = !text; }
function values() { return ["website", "name", "username", "password", "environment", "notes"].map(id => dialog.querySelector(`#${id}`).value).join("\u0000"); }
function requestClose() {
  if (current && values() !== current.snapshot && !confirm("Discard this login? What you typed will be lost.")) return;
  closeLoginDialog();
}
function reset() {
  if (!dialog) return;
  clearFields(dialog.querySelector("#login-form")); dialog.querySelector("#login-form").reset();
  dialog.querySelector("#password").type = "password"; dialog.querySelector("#reveal").setAttribute("aria-pressed", "false");
  showError(""); current = null;
  document.documentElement.classList.remove("dialog-open");
}
export function closeLoginDialog() { if (dialog?.open) dialog.close(); else reset(); }

// Opens the add/edit dialog. `item` (with its password) edits an existing login; `prefill` seeds a new one.
export function openLoginDialog({ client, item = null, revision, prefill = {}, existing = [], generatorOptions = () => ({ length: 20 }), onSaved, onDelete }) {
  if (!dialog) hooks = build();
  if (dialog.open) dialog.close();
  current = { client, item, revision, existing, generatorOptions, onSaved, onDelete };
  const $ = id => dialog.querySelector(`#${id}`);
  $("editor-title").textContent = item ? "Edit login" : "Add login";
  $("website").value = item?.urls[0] ?? prefill.website ?? "";
  $("name").value = item?.name ?? "";
  $("username").value = item?.username ?? prefill.username ?? "";
  $("password").value = item?.password ?? "";
  $("environment").value = item?.environment ?? prefill.environment ?? "other";
  $("notes").value = item?.notes ?? "";
  $("notes-field").hidden = !item?.notes; $("toggle-notes").hidden = !!item?.notes;
  $("delete").hidden = !item;
  hooks.preview(); hooks.meter();
  current.snapshot = values();
  document.documentElement.classList.add("dialog-open");
  dialog.showModal();
  // Start where typing is needed: the website for a blank login, otherwise the username or name.
  ($("website").value ? (item ? $("name") : $("username")) : $("website")).focus();
}
