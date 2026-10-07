(() => {
  const detector = globalThis.__keybit;
  function setValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }
  detector.fill = (origin, username, password) => {
    if (window !== window.top || location.origin !== origin) return { ok: false, error: "The page changed. Reopen the extension before filling." };
    const candidates = detector.find();
    if (candidates.length !== 1) return { ok: false, error: "There must be one visible, supported login form to fill." };
    const fields = candidates[0];
    if (fields.username) setValue(fields.username, username);
    // Framework handlers can replace a field after the username input event.
    if (location.origin !== origin || !detector.usable(fields.password)) return { ok: false, error: "The form changed. Check the page and click Fill again." };
    setValue(fields.password, password);
    return { ok: true };
  };
  detector.fillNew = (origin, password) => {
    if (window !== window.top || location.origin !== origin) return { ok: false, error: "The page changed. Click the password field again." };
    const forms = detector.findNew();
    if (forms.length !== 1) return { ok: false, error: "There must be one visible sign-up or change-password form." };
    for (const field of forms[0].fields) setValue(field, password);
    return { ok: true };
  };
})();
