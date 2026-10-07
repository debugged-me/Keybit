import { VaultClient } from "../ui/client.js";
import { renderAuth } from "../ui/auth.js";
import { announce, clearFields, element } from "../ui/common.js";
import { MAX_BACKUP_BYTES } from "../crypto/encoding.js";

const $ = selector => document.querySelector(selector);
const tabs = [...document.querySelectorAll('[role="tab"]')];
let importToken = null;
const client = new VaultClient((state, previous) => {
  renderAuth($("#auth"), client);
  $("#preferences").hidden = !state.unlocked; $("#lock").hidden = !state.unlocked; $("#export").disabled = !state.exists;
  if (state.unlocked) $("#auto-lock").value = String(state.settings.autoLockMinutes);
  if (!state.unlocked && previous.unlocked) clearFields($("#import-form"));
  updateWarning();
});
function selectTab(id, { focus = false, remember = true } = {}) {
  const tab = tabs.find(candidate => candidate.getAttribute("aria-controls") === id) ?? tabs[0];
  for (const candidate of tabs) {
    const selected = candidate === tab;
    candidate.setAttribute("aria-selected", String(selected));
    candidate.tabIndex = selected ? 0 : -1;
    $(`#${candidate.getAttribute("aria-controls")}`).hidden = !selected;
  }
  if (remember) history.replaceState(null, "", `#${tab.getAttribute("aria-controls")}`);
  if (focus) tab.focus();
}
for (const tab of tabs) {
  tab.addEventListener("click", () => selectTab(tab.getAttribute("aria-controls")));
  tab.addEventListener("keydown", event => {
    const index = tabs.indexOf(tab);
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    selectTab(tabs[(next + tabs.length) % tabs.length].getAttribute("aria-controls"), { focus: true });
  });
}
selectTab(location.hash.slice(1), { remember: false });

function updateWarning() { $("#never-warning").hidden = $("#preferences").hidden || $("#auto-lock").value !== "0"; }
$("#lock").addEventListener("click", () => void client.lock());
$("#auto-lock").addEventListener("change", async () => {
  const select = $("#auto-lock");
  updateWarning(); select.disabled = true;
  try {
    client.update(await client.request("SETTINGS", { settings: { autoLockMinutes: Number(select.value) } }));
    announce(select.value === "0" ? "Auto-lock set to Never." : `KeyBit will lock after ${select.selectedOptions[0].textContent} of inactivity.`);
  } catch (error) {
    announce(error.message, true);
    if (client.state.unlocked) select.value = String(client.state.settings.autoLockMinutes);
    await client.refresh();
  } finally { select.disabled = false; updateWarning(); }
});
$("#export").addEventListener("click", async () => {
  try {
    const data = await client.request("EXPORT");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `keybit-backup-${new Date().toLocaleDateString("en-CA")}.kvault`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    announce("Encrypted backup exported. Keep the backup and its master password safe.");
  } catch (error) { announce(error.message, true); }
});
$("#import-form").addEventListener("submit", async event => {
  event.preventDefault(); importToken = null; $("#import-confirmation").hidden = true;
  $("#validate-import").disabled = true;
  let password = $("#backup-password").value;
  $("#backup-password").value = "";
  try {
    const file = $("#backup-file").files[0];
    if (!file || file.size > MAX_BACKUP_BYTES) throw new Error("Choose an encrypted backup no larger than 6 MB.");
    const preview = await client.request("PREPARE_IMPORT", { text: await file.text(), password });
    importToken = preview.token;
    $("#import-description").textContent = `Backup verified: ${preview.count} login(s). ${preview.replaces ? "This will replace every login in the current vault. Export a backup first if you need to keep them." : "This will become your vault on this device."}`;
    $("#confirm-import").textContent = preview.replaces ? "Replace vault with this backup" : "Restore this vault";
    $("#import-confirmation").hidden = false; announce("Backup verified. Review the replacement before confirming.");
    await client.refresh();
  } catch (error) { announce(error.message, true); await client.refresh(); }
  finally { password = ""; $("#validate-import").disabled = false; }
});
$("#confirm-import").addEventListener("click", async () => {
  if (!importToken) return;
  $("#confirm-import").disabled = true;
  try {
    client.update(await client.request("COMMIT_IMPORT", { token: importToken, confirmed: true }));
    importToken = null; $("#import-confirmation").hidden = true; $("#import-form").reset();
    // The restored vault is locked; its unlock form lives on the Security tab.
    selectTab("security");
    announce("Backup restored. Unlock using the backup's master password.");
  } catch (error) { announce(error.message, true); }
  finally { $("#confirm-import").disabled = false; }
});
$("#cancel-import").addEventListener("click", () => { importToken = null; $("#import-confirmation").hidden = true; void client.lock(); });
$("#version").textContent = `v${chrome.runtime.getManifest().version}`;
await client.refresh();

async function renderDisabledSites() {
  try {
    const sites = await client.request("DISABLED_SITES");
    const container = $("#disabled-sites");
    container.replaceChildren();
    for (const origin of sites) {
      const enable = element("button", { type: "button", className: "text-button" }, "Turn on");
      enable.addEventListener("click", async () => {
        const url = new URL(origin);
        try {
          if (!(await chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] }))) throw new Error("Site access was not allowed.");
          await client.request("SET_SITE_ENABLED", { origin, enabled: true });
          announce(`KeyBit is back on for ${url.host}.`);
          await renderDisabledSites();
        } catch (error) { announce(error.message, true); }
      });
      container.append(element("div", { className: "site-permission" }, element("span", {}, origin), enable));
    }
    if (!sites.length) container.append(element("p", { className: "muted" }, "None. KeyBit is on for every website."));
  } catch (error) { announce(error.message, true); }
}
await renderDisabledSites();
