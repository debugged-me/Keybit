// Runs inside a page frame (injected by the worker for INSPECT). Reports structure and
// attributes only — it never reads field values, so no credential can appear in a report.
(() => {
  const keybit = globalThis.__keybit;
  if (!keybit?.deepQueryAll) return { origin: location.origin, url: location.href, error: "KeyBit's detector is not available in this frame." };

  const inShadow = node => node.getRootNode() instanceof ShadowRoot;
  const shadowDepth = node => {
    let depth = 0, root = node.getRootNode();
    while (root instanceof ShadowRoot) { depth++; root = root.host.getRootNode(); }
    return depth;
  };
  const labelFor = input => {
    const own = [...(input.labels ?? [])].map(label => label.textContent.trim()).filter(Boolean).join(" ");
    if (own) return own;
    const root = input.getRootNode();
    if (input.id) {
      const label = root.querySelector?.(`label[for="${CSS.escape(input.id)}"]`);
      if (label) return label.textContent.trim();
    }
    return (input.getAttribute("aria-label") ?? input.closest("label")?.textContent ?? "").trim();
  };
  const describe = input => ({
    tag: input.tagName.toLowerCase(),
    type: input instanceof HTMLInputElement ? input.type : input.tagName.toLowerCase(),
    id: input.id || "", name: input.name || "",
    autocomplete: input.getAttribute("autocomplete") ?? "",
    placeholder: input.getAttribute("placeholder") || "",
    label: labelFor(input).slice(0, 140),
    visible: !!input.getClientRects().length,
    disabled: !!input.disabled, readonly: !!input.readOnly, required: !!input.required,
    shadow: inShadow(input), depth: shadowDepth(input),
    inForm: !!input.form, formId: input.form?.id || "",
    usable: keybit.usable(input),
    roles: []
  });

  const elements = keybit.deepQueryAll("input, select");
  const fields = elements.map(describe);
  const claim = (input, role) => {
    const index = elements.indexOf(input);
    if (index >= 0 && !fields[index].roles.includes(role)) fields[index].roles.push(role);
  };
  const groups = { login: 0, newPassword: 0, username: 0, otp: 0, payment: 0, identity: 0 };
  try {
    for (const { username, password } of keybit.find()) { groups.login++; claim(username, "username"); claim(password, "password"); }
    for (const { fields: list, current, username } of keybit.findNew()) {
      groups.newPassword++;
      for (const input of list) claim(input, "new-password");
      claim(current, "current-password"); claim(username, "username");
    }
    for (const { username } of keybit.findUsernameOnly()) { groups.username++; claim(username, "username-step"); }
    for (const { fields: list } of keybit.findOtp()) { groups.otp++; for (const input of list) claim(input, "one-time-code"); }
    for (const fields_ of keybit.findPayment()) {
      groups.payment++;
      for (const part of ["number", "holder", "csc", "expiry", "expMonth", "expYear"]) claim(fields_[part], `card-${part}`);
    }
    for (const { fields: map } of keybit.findIdentity()) { groups.identity++; for (const [type, input] of map) claim(input, `identity-${type}`); }
  } catch { /* A hostile page can break a getter; the report still ships what was found. */ }

  const issues = [], recommendations = [], notes = [];
  const passwords = fields.filter(field => field.tag === "input" && field.type === "password");
  const nameOf = field => field.id ? `#${field.id}` : field.name ? `[name="${field.name}"]` : field.label ? `"${field.label}"` : `${field.tag}[type=${field.type}]`;
  for (const field of passwords) {
    const name = nameOf(field);
    if (!field.usable) {
      const why = field.disabled ? "disabled" : field.readonly ? "readonly" : "hidden";
      issues.push(`Password field ${name} is ${why}, so KeyBit cannot fill it.`);
      if (field.readonly) recommendations.push(`Remove readonly from ${name}, or enable it before the form is used.`);
    } else if (field.autocomplete === "off") {
      issues.push(`Password field ${name} uses autocomplete="off".`);
      recommendations.push(`Replace autocomplete="off" on ${name} with "current-password" or "new-password".`);
    } else if (!field.autocomplete) {
      recommendations.push(`Add autocomplete="current-password" (or "new-password" on a sign-up form) to ${name}.`);
    }
  }
  if (groups.login && !fields.some(field => field.roles.includes("username"))) {
    issues.push("A password field was found, but no username field next to it.");
    recommendations.push('Add a visible text/email input with autocomplete="username" before the password field.');
  }
  const usablePasswords = passwords.filter(field => field.usable);
  if (usablePasswords.length > 1 && !groups.newPassword) {
    issues.push(`${usablePasswords.length} usable password fields share the page — KeyBit may pick the wrong one.`);
    recommendations.push('Mark the sign-in password autocomplete="current-password" and confirmations "new-password".');
  }
  const credentialFields = fields.filter(field => field.roles.length);
  if (credentialFields.length && credentialFields.every(field => !field.inForm)) {
    notes.push("Credential fields are not inside a <form> — submission is handled by JavaScript.");
    recommendations.push("Wrap the fields in a <form> so the browser (and KeyBit's save prompt) sees a real submit.");
  }
  const forms = keybit.deepQueryAll("form");
  for (const form of forms) {
    const hasSubmit = !!form.querySelector('button[type="submit"], input[type="submit"], input[type="image"], button:not([type])');
    if (!hasSubmit && form.querySelector('input[type="password"], input[type="email"], input[autocomplete~="username"]'))
      notes.push(`Form ${form.id ? `#${form.id}` : form.getAttribute("action") || "(unnamed)"} has no submit button — it is probably submitted by JavaScript.`);
  }
  const fieldsInShadow = fields.filter(field => field.shadow);
  if (fieldsInShadow.length) notes.push(`${fieldsInShadow.length} field(s) live inside open Shadow DOM — KeyBit can reach them, and closed roots stay invisible.`);
  if (groups.otp) notes.push("One-time code input detected — KeyBit never fills or stores OTP values.");
  if (groups.newPassword) notes.push("New-password fields detected — treated as a sign-up/change form, not a sign-in.");
  if (groups.username) notes.push("Two-step sign-in detected (username-only step).");
  if (groups.payment) notes.push("Payment fields detected.");
  if (!fields.length) notes.push("No form fields found in this frame.");

  return {
    origin: location.origin, url: location.href, title: document.title,
    shadow: fieldsInShadow.length > 0,
    counts: { fields: fields.length, forms: forms.length, ...groups },
    fields, issues, recommendations, notes
  };
})();
