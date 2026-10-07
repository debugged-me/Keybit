import { element, announce, copyText, copySecret, siteTile, iconButton } from "./common.js";

// A compact login row with icon actions. Fill appears only for logins that match the current page.
export function loginRow(item, client, fill = null) {
  const actions = element("div", { className: "row-actions" });
  if (fill) {
    const button = iconButton("fill", fill.disabled ? "Fill needs one login form on this page" : `Fill ${item.username || item.name}`, { "data-action": "fill", disabled: fill.disabled });
    button.addEventListener("click", async () => {
      button.disabled = true;
      try { await fill.action(item.id); } catch (error) { announce(error.message, true); await client.refresh(); }
      finally { button.disabled = fill.disabled; }
    });
    actions.append(button);
  }
  if (item.hasTotp) {
    const button = iconButton("timer", "Copy 2FA code", { "data-action": "copy-totp" });
    button.addEventListener("click", async () => {
      try {
        const armed = await copySecret((await client.request("TOTP", { id: item.id })).code);
        announce(armed ? "2FA code copied. Clears in 30 seconds." : "2FA code copied.");
      }
      catch (error) { announce(error.message, true); }
    });
    actions.append(button);
  }
  for (const field of ["username", "password"]) {
    const button = iconButton(field === "username" ? "user" : "copy", `Copy ${field}`, { "data-action": `copy-${field}` });
    button.addEventListener("click", async () => {
      const session = client.state.session;
      let value = "";
      try {
        value = await client.request("COPY", { id: item.id, field });
        if (!client.is(session)) throw new Error("Vault locked. Unlock it before copying.");
        const armed = field === "password" ? await copySecret(value) : (await copyText(value), false);
        announce(field === "password" ? (armed ? "Password copied. Clears in 30 seconds." : "Password copied. Clipboard is not cleared automatically.") : "Username copied.");
      } catch (error) { announce(error.message, true); await client.refresh(); }
      finally { value = ""; }
    });
    actions.append(button);
  }
  const secondary = [item.username || "No username", item.environment === "production" ? "Production" : null].filter(Boolean).join(" · ");
  // Rows are focusable so the popup can be used from the keyboard (↑ ↓ to move, Enter to fill).
  const row = element("article", { className: "login-item", "data-id": item.id, tabindex: "0", "aria-label": `${item.name}, ${item.username || "no username"}` }, siteTile(item.scope),
    element("div", { className: "details" }, element("span", { className: "primary", title: item.scope }, item.name), element("span", { className: "secondary" }, secondary)),
    actions);
  // Clicking the row itself fills too; the small icon buttons keep their own actions.
  if (fill && !fill.disabled) {
    row.setAttribute("data-fill", "");
    row.addEventListener("click", async event => {
      if (/** @type {Element} */ (event.target).closest("button")) return;
      try { await fill.action(item.id); } catch (error) { announce(error.message, true); await client.refresh(); }
    });
  }
  return row;
}
