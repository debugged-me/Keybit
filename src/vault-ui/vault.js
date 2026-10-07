import { VaultClient } from "../ui/client.js";
import { renderAuth } from "../ui/auth.js";
import { element, announce, clearFields } from "../ui/common.js";
import { loginRow } from "../ui/items.js";
import { generatePassword } from "../generator/password-generator.js";
import { parseWebsite } from "../matching/url-matcher.js";

const $ = selector => document.querySelector(selector);
let editingId = null;
let editRevision = null;
let requestNumber = 0;
const client = new VaultClient((state, previous) => {
  renderAuth($("#auth"), client);
  $("#dashboard").hidden = !state.unlocked; $("#lock").hidden = !state.unlocked;
  if (state.session !== previous.session) { closeEditor(); $("#search").value = ""; }
  $("#items").replaceChildren();
  if (state.unlocked) {
    void refreshList();
    if (location.hash === "#new") { history.replaceState(null, "", location.pathname); openEditor(); }
  } else { closeEditor(); }
});
function closeEditor() {
  clearFields($("#login-form")); $("#login-form").reset(); $("#password").type = "password";
  $("#editor").hidden = true; editingId = null; editRevision = null;
}
async function openEditor(id = null) {
  const session = client.state.session;
  closeEditor();
  if (!client.is(session)) return;
  if (id) {
    const response = await client.request("ITEM", { id });
    if (!client.is(session)) return;
    const item = response.item;
    for (const key of ["name", "username", "password", "environment", "notes"]) $(`#${key}`).value = item[key];
    $("#website").value = item.urls[0]; editingId = id; editRevision = response.state.revision;
  } else { editRevision = client.state.revision; }
  $("#editor-title").textContent = id ? "Edit login" : "Add login";
  $("#delete").hidden = !id; $("#editor").hidden = false;
  $("#name").focus();
}
async function refreshList() {
  const request = ++requestNumber; const session = client.state.session;
  try {
    const items = await client.request("LIST", { query: $("#search").value });
    if (!client.is(session) || request !== requestNumber) return;
    $("#items").replaceChildren(...items.map(item => loginRow(item, client, "Edit", openEditor)));
    if (!items.length) $("#items").append(element("p", { className: "empty" }, $("#search").value ? "No logins match your search." : "Your vault is empty. Add your first login."));
  } catch (error) { announce(error.message, true); }
}
$("#add-login").addEventListener("click", () => { void openEditor().catch(error => announce(error.message, true)); });
$("#cancel").addEventListener("click", closeEditor);
$("#lock").addEventListener("click", () => void client.lock());
$("#search").addEventListener("input", () => void refreshList());
$("#reveal").addEventListener("change", event => { $("#password").type = event.target.checked ? "text" : "password"; });
$("#generate").addEventListener("click", () => {
  try {
    const options = { length: Number($("#length").value) };
    for (const key of ["uppercase", "lowercase", "numbers", "symbols"]) options[key] = $(`#${key}`).checked;
    $("#password").value = generatePassword(options);
    announce("Password generated. Save the login to keep it.");
  } catch (error) { announce(error.message, true); }
});
$("#login-form").addEventListener("submit", async event => {
  event.preventDefault(); $("#save").disabled = true;
  let item = { id: editingId, urls: [$("#website").value] };
  for (const key of ["name", "username", "password", "environment", "notes"]) item[key] = $(`#${key}`).value;
  try {
    parseWebsite(item.urls[0]);
    const state = await client.request("SAVE", { item, revision: editRevision });
    closeEditor(); client.update(state); announce("Login saved and encrypted.");
  } catch (error) { announce(error.message, true); await client.refresh(); }
  finally { item = null; $("#save").disabled = false; }
});
$("#delete").addEventListener("click", async () => {
  if (!editingId || !confirm("Delete this login? This cannot be undone.")) return;
  try {
    const state = await client.request("DELETE", { id: editingId, revision: editRevision });
    closeEditor(); client.update(state); announce("Login deleted.");
  } catch (error) { announce(error.message, true); await client.refresh(); }
});
await client.refresh();
