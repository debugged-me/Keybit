import { element, announce, copyText } from "./common.js";

export function loginRow(item, client, actionLabel, action, disabled = false) {
  const heading = element("div", { className: "item-heading" }, element("h3", {}, item.name));
  if (item.environment === "production") heading.append(element("span", { className: "production" }, "⚠ Production"));
  const actions = element("div", { className: "item-actions" });
  const main = element("button", { type: "button", className: "small-button", disabled }, actionLabel);
  main.addEventListener("click", async () => {
    main.disabled = true;
    try { await action(item.id); } catch (error) { announce(error.message, true); await client.refresh(); }
    finally { main.disabled = disabled; }
  });
  actions.append(main);
  for (const field of ["username", "password"]) {
    const button = element("button", { type: "button", className: "text-button", "aria-label": `Copy ${field} for ${item.name}` }, field === "username" ? "Copy user" : "Copy password");
    button.addEventListener("click", async () => {
      const session = client.state.session;
      let value = "";
      try {
        value = await client.request("COPY", { id: item.id, field });
        if (!client.is(session)) throw new Error("Vault locked. Unlock it before copying.");
        await copyText(value);
        announce(field === "password" ? "Password copied. Clipboard is not cleared automatically." : "Username copied.");
      } catch (error) { announce(error.message, true); await client.refresh(); }
      finally { value = ""; }
    });
    actions.append(button);
  }
  const initial = [...item.name.trim()][0]?.toLocaleUpperCase() || "•";
  return element("article", { className: "login-item" }, element("span", { className: "item-avatar", "aria-hidden": "true" }, initial),
    element("div", { className: "item-body" }, heading, element("p", { className: "muted item-username" }, item.username || "No username"), actions));
}
