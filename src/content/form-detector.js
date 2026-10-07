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
  globalThis.__keybit = { find, usable };
})();
