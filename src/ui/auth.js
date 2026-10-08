import { element, announce, clearFields, revealButton } from "./common.js";
import { biometricName, unlockWithBiometric } from "./biometric.js";

export function renderAuth(container, client) {
  const state = client.state;
  if (state.unlocked) { clearFields(container); container.replaceChildren(); container.hidden = true; delete container.dataset.mode; return; }
  container.hidden = false;
  const mode = (state.exists ? "unlock" : "create") + (state.exists && state.biometric ? "-biometric" : "");
  if (container.dataset.mode === mode) return;
  container.dataset.mode = mode;
  const input = element("input", { id: "master-password", type: "password", autocomplete: state.exists ? "current-password" : "new-password", required: true, maxlength: 1024, minlength: state.exists ? 1 : 12 });
  const confirm = element("input", { id: "confirm-password", type: "password", autocomplete: "new-password", required: !state.exists, maxlength: 1024 });
  const button = element("button", { className: "primary-button", type: "submit" }, state.exists ? "Unlock vault" : "Create vault");
  const form = element("form", { autocomplete: "off" },
    element("h2", {}, state.exists ? "Unlock your vault" : "Your private vault"),
    element("p", { className: "muted intro" }, state.exists ? "Enter your master password to continue." : "Choose a long, unique passphrase. At least 12 characters."),
    element("label", { for: "master-password" }, "Master password"),
    element("div", { className: "password-field" }, input, element("span", { className: "field-actions" }, revealButton(input))),
    ...(!state.exists ? [element("label", { for: "confirm-password" }, "Confirm master password"),
      element("div", { className: "password-field" }, confirm, element("span", { className: "field-actions" }, revealButton(confirm)))] : []), button,
    element("p", { className: "notice" }, "Your master password cannot be recovered. Keep it somewhere safe."));
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!state.exists && input.value !== confirm.value) { announce("Master passwords do not match.", true); return; }
    button.disabled = true;
    let password = input.value;
    clearFields(form);
    announce(state.exists ? "Unlocking…" : "Creating your encrypted vault…");
    try {
      const next = await client.request(state.exists ? "UNLOCK" : "CREATE", { password });
      client.update(next); announce("");
    } catch (error) { announce(error.message, true); }
    finally { password = ""; button.disabled = false; }
  });
  if (state.exists && state.biometric) {
    const biometric = element("button", { type: "button", className: "secondary-button biometric-button", id: "biometric-unlock" }, `Unlock with ${biometricName()}`);
    biometric.addEventListener("click", async () => {
      biometric.disabled = true;
      try { client.update(await unlockWithBiometric(client)); announce(""); }
      catch (error) { announce(error.message, true); }
      finally { biometric.disabled = false; }
    });
    form.insertBefore(biometric, form.querySelector(".notice"));
  }
  container.replaceChildren(form);
}
