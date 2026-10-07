(() => {
  function usable(input) {
    if (input.disabled || input.readOnly || input.matches(":disabled") || !input.isConnected || !input.getClientRects().length) return false;
    for (let node = input; node instanceof Element; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.visibility !== "visible" || style.display === "none" || Number(style.opacity) === 0) return false;
    }
    return true;
  }
  const tokens = input => input.autocomplete.toLowerCase().split(/\s+/);
  function scopeFor(password) {
    if (password.form) return password.form;
    let scope = password.parentElement;
    for (let i = 0; i < 3 && scope?.parentElement && scope !== document.body; i++, scope = scope.parentElement) {
      if ([...scope.querySelectorAll("input")].some(input => ["text", "email"].includes(input.type) && usable(input))) return scope;
    }
    return scope ?? document;
  }
  function usernameFor(password, scope) {
    return [...scope.querySelectorAll("input")].filter(input => ["text", "email", "tel"].includes(input.type) && usable(input) &&
      input.form === password.form && !!(input.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING))
      .map((input, index) => {
        const label = [...(input.labels ?? [])].map(label => label.textContent).join(" ");
        const name = `${input.name} ${input.id} ${label}`;
        const score = tokens(input).includes("username") ? 100 : input.type === "email" ? 80 : /user|e-?mail|login|account|identifier/i.test(name) ? 60 : 10;
        return { input, score, index };
      }).sort((a, b) => b.score - a.score || b.index - a.index)[0]?.input ?? null;
  }
  function find() {
    const passwords = [...document.querySelectorAll('input[type="password" i]')].filter(input => usable(input) && !tokens(input).includes("new-password"));
    return passwords.filter(password => {
      const scope = scopeFor(password);
      const siblings = passwords.filter(input => scope.contains(input));
      const current = siblings.filter(input => tokens(input).includes("current-password"));
      // Multiple unlabelled password fields are usually registration/change-password forms.
      return current.length ? current.includes(password) : siblings.length === 1;
    }).map(password => ({ password, username: usernameFor(password, scopeFor(password)) }));
  }
  // Sign-up and change-password forms: one or two fields for the new password, optionally after the current one.
  function findNew() {
    const groups = new Map();
    for (const input of document.querySelectorAll('input[type="password" i]')) {
      if (!usable(input)) continue;
      const scope = scopeFor(input);
      groups.set(scope, [...(groups.get(scope) ?? []), input]);
    }
    const result = [];
    for (const [scope, fields] of groups) {
      const current = fields.filter(input => tokens(input).includes("current-password"));
      let fresh = fields.filter(input => tokens(input).includes("new-password"));
      if (!fresh.length) {
        // Unlabelled: two fields are new + confirm; three are current + new + confirm.
        if (fields.length === 2 && !current.length) fresh = fields;
        else if (fields.length === 3 && current.length <= 1) fresh = fields.filter(input => input !== (current[0] ?? fields[0]));
      }
      if (!fresh.length || fresh.length > 2 || current.length > 1) continue;
      result.push({ fields: fresh, current: fields.find(input => !fresh.includes(input)) ?? null, username: usernameFor(fields[0], scope) });
    }
    return result;
  }
  const describe = input => `${input.name} ${input.id} ${input.placeholder} ${input.getAttribute("aria-label") ?? ""} ${[...(input.labels ?? [])].map(label => label.textContent).join(" ")}`;
  const IDENTIFIER = /user|e-?mail|login|account|identifier|phone|mobile|member|customer|student/i;
  // The first page of a two-step sign-in: one identifier field and no password field on the page.
  function findUsernameOnly() {
    if ([...document.querySelectorAll('input[type="password" i]')].some(usable)) return [];
    const inputs = /** @type {HTMLInputElement[]} */ ([...document.querySelectorAll('input[type="text" i], input[type="email" i], input[type="tel" i], input:not([type])')]);
    const fields = inputs.filter(input =>
      usable(input) && !input.closest('[role="search"]') && !/search|query|^q$/i.test(`${input.name} ${input.id}`) &&
      (tokens(input).includes("username") || tokens(input).includes("email") || input.type === "email" || IDENTIFIER.test(describe(input))));
    // Prefer a field marked as a username; if it is still ambiguous, offer nothing.
    const marked = fields.filter(input => tokens(input).includes("username"));
    const candidates = marked.length ? marked : fields;
    return candidates.length === 1 ? [{ username: candidates[0] }] : [];
  }
  const OTP = /one.?time|otp|totp|2fa|mfa|two.?factor|verification.?code|security.?code|auth(?:entication|enticator)?.?code|passcode/i;
  // A 2FA code field, or four to eight one-character boxes in one container.
  function findOtp() {
    const inputs = /** @type {HTMLInputElement[]} */ ([...document.querySelectorAll('input[type="text" i], input[type="tel" i], input[type="number" i], input:not([type])')]).filter(usable);
    const marked = inputs.filter(input => tokens(input).includes("one-time-code") || (OTP.test(describe(input)) && input.maxLength !== 1));
    if (marked.length === 1) return [{ fields: marked }];
    const boxes = inputs.filter(input => input.maxLength === 1);
    const container = boxes[0]?.closest("form") ?? boxes[0]?.parentElement?.parentElement;
    if (boxes.length >= 4 && boxes.length <= 8 && boxes.every(box => container?.contains(box))) return [{ fields: boxes }];
    return [];
  }
  globalThis.__keybit = { find, findNew, findUsernameOnly, findOtp, usable };
})();
