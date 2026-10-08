(() => {
  const detector = globalThis.__keybit;
  function setValue(input, value) {
    if (input instanceof HTMLSelectElement) {
      // `value` may be a list of spellings to try, e.g. a month as "04" or "4".
      const wanted = [].concat(value).map(entry => String(entry).toLowerCase());
      const option = [...input.options].find(opt => wanted.includes(opt.value.toLowerCase()) || wanted.includes(opt.textContent.trim().toLowerCase()))
        ?? [...input.options].find(opt => wanted.some(w => w.length > 2 && (opt.value.toLowerCase().includes(w) || opt.textContent.trim().toLowerCase().includes(w))));
      if (!option) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
      setter.call(input, option.value);
    } else {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, value);
    }
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }
  // The context-menu "Generate password" writes straight into the field that was right-clicked
  // (plus its sign-up siblings), so it cannot reuse the form-wide finders above.
  detector.fillInput = (input, value) => {
    if (input instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return;
    }
    setValue(input, value);
  };
  detector.fill = (origin, username, password) => {
    // Runs in whatever document the worker chose — `origin` is always that document's own origin.
    if (location.origin !== origin) return { ok: false, error: "The page changed. Reopen the extension before filling." };
    const candidates = detector.find();
    if (candidates.length !== 1) return { ok: false, error: "There must be one visible, supported login form to fill." };
    const fields = candidates[0];
    if (fields.username) setValue(fields.username, username);
    // Framework handlers can replace a field after the username input event.
    if (location.origin !== origin || !detector.usable(fields.password)) return { ok: false, error: "The form changed. Check the page and click Fill again." };
    setValue(fields.password, password);
    return { ok: true };
  };
  detector.fillUsername = (origin, username) => {
    if (location.origin !== origin) return { ok: false, error: "The page changed. Click the username field again." };
    const steps = detector.findUsernameOnly();
    if (steps.length !== 1) return { ok: false, error: "There must be one visible username field to fill." };
    setValue(steps[0].username, username);
    return { ok: true };
  };
  detector.fillOtp = (origin, code) => {
    if (location.origin !== origin) return { ok: false, error: "The page changed. Click the code field again." };
    const forms = detector.findOtp();
    if (forms.length !== 1) return { ok: false, error: "There must be one visible 2FA code field to fill." };
    const { fields } = forms[0];
    if (fields.length === 1) setValue(fields[0], code);
    else fields.forEach((field, index) => setValue(field, code[index] ?? ""));
    return { ok: true };
  };
  detector.fillNew = (origin, password) => {
    if (location.origin !== origin) return { ok: false, error: "The page changed. Click the password field again." };
    const forms = detector.findNew();
    if (forms.length !== 1) return { ok: false, error: "There must be one visible sign-up or change-password form." };
    for (const field of forms[0].fields) setValue(field, password);
    return { ok: true };
  };
  detector.fillCard = (origin, card) => {
    if (location.origin !== origin) return { ok: false, error: "The page changed. Click the card field again." };
    const forms = detector.findPayment();
    if (forms.length !== 1) return { ok: false, error: "There must be one visible card form to fill." };
    const f = forms[0];
    setValue(f.number, card.number);
    if (f.holder && card.cardholder) setValue(f.holder, card.cardholder);
    if (f.csc && card.cvv) setValue(f.csc, card.cvv);
    const month = String(card.expiryMonth).padStart(2, "0");
    const year = String(card.expiryYear);
    if (f.expMonth) setValue(f.expMonth, [month, String(card.expiryMonth)]);
    if (f.expYear) setValue(f.expYear, [year, year.slice(-2)]);
    if (f.expiry) setValue(f.expiry, Number(f.expiry.maxLength) > 0 && Number(f.expiry.maxLength) <= 5 || /yy([^y]|$)/i.test(String(f.expiry.placeholder)) ? `${month}/${year.slice(-2)}` : `${month}/${year}`);
    return { ok: true };
  };
  detector.fillIdentity = (origin, person) => {
    if (location.origin !== origin) return { ok: false, error: "The page changed. Click the address field again." };
    const forms = detector.findIdentity();
    if (forms.length !== 1) return { ok: false, error: "There must be one visible address or sign-up form to fill." };
    const values = { ...person, fullName: person.fullName || [person.firstName, person.lastName].filter(Boolean).join(" ") };
    for (const [token, input] of forms[0].fields) {
      const key = detector.IDENTITY_MAP[token];
      // Mapped fields fill when empty; selects always update so a preset "Country" placeholder is replaced.
      if (key && values[key] && (input instanceof HTMLSelectElement || !input.value)) setValue(input, values[key]);
    }
    return { ok: true };
  };
})();
