(() => {
  if (window !== window.top) return;
  // A copy injected before an extension reload/update has no runtime — retire quietly.
  if (!chrome.runtime?.id) return;
  // Re-injection after an install/update replaces the previous instance instead of stacking listeners.
  globalThis.__keybitSave?.dispose();
  const lifecycle = new AbortController();
  globalThis.__keybitSave = { dispose: () => {
    close(); lifecycle.abort();
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch { /* Orphaned after an extension reload. */ }
  } };
  let host = null;
  let token = null;
  let events = null;
  let disabled = false;
  let generation = 0;
  let last = { key: "", at: 0 };
  function close() { generation++; events?.abort(); events = null; host?.remove(); host = null; token = null; }
  async function show() {
    const current = ++generation;
    let response;
    try { response = await chrome.runtime.sendMessage({ type: "SAVE_PROMPT_OPEN" }); } catch { return; }
    if (current !== generation || !response?.ok) return;
    if (!response.data?.available) { close(); return; }
    if (host && token === response.data.token) return;
    close(); token = response.data.token;
    const currentToken = token;
    host = document.createElement("div");
    Object.assign(host.style, { all: "initial", position: "fixed", display: "block", zIndex: "2147483647", top: "12px", right: "12px",
      width: "min(360px, calc(100vw - 24px))", height: "260px", maxHeight: "calc(100vh - 24px)" });
    const shadow = host.attachShadow({ mode: "closed" });
    const frame = document.createElement("iframe");
    frame.title = "Save login to KeyBit";
    frame.src = chrome.runtime.getURL(`src/inline/save.html#${token}`);
    frame.referrerPolicy = "no-referrer";
    Object.assign(frame.style, { width: "100%", height: "100%", border: "0", borderRadius: "12px", boxShadow: "0 12px 32px #0000002e, 0 2px 6px #0000001a", colorScheme: "light dark" });
    shadow.append(frame); document.documentElement.append(host);
    const frameWindow = frame.contentWindow;
    events = new AbortController();
    window.addEventListener("message", event => {
      if (event.source !== frameWindow || event.data?.token !== currentToken) return;
      if (event.data?.type === "KEYBIT_SAVE_CLOSE") close();
      if (event.data?.type === "KEYBIT_SAVE_RESIZE" && Number.isFinite(event.data.height) && host) {
        host.style.height = `${Math.max(160, Math.min(480, event.data.height))}px`;
      }
    }, { signal: events.signal });
  }
  // Values are read only at the moment of submitting. KeyBit never intercepts, delays, or resubmits the form.
  function send(capture) {
    if (disabled) return;
    const key = JSON.stringify(capture);
    // One action can fire both a click and a submit; report it once. A deliberate resubmission comes later.
    if (key === last.key && Date.now() - last.at < 600) return;
    last = { key, at: Date.now() };
    try {
      if (capture.type === "CAPTURE_USERNAME") { void chrome.runtime.sendMessage(capture).catch(() => {}); return; }
      void chrome.runtime.sendMessage({ type: "CAPTURE_LOGIN", ...capture })
        .then(response => { if (response?.ok && response.data?.available) void show(); else close(); }).catch(() => {});
    } catch { /* Orphaned after an extension reload. */ }
  }
  // What the user is submitting: a sign-up or password change, a sign-in, or the username step of a two-step sign-in.
  function captureFor(belongs) {
    const keybit = globalThis.__keybit;
    const created = keybit.findNew().filter(candidate => belongs(candidate.fields[0]));
    const logins = keybit.find().filter(candidate => belongs(candidate.password));
    let capture;
    if (created.length === 1) {
      // Sign-up or password change: the new password, only when its confirmation matches.
      const { fields, current, username } = created[0];
      if (fields.length === 2 && fields[0].value !== fields[1].value) return;
      capture = { kind: current ? "change" : "signup", username: username?.value ?? "", password: fields[0].value };
    } else if (logins.length === 1 && !created.length) {
      capture = { kind: "login", username: logins[0].username?.value ?? "", password: logins[0].password.value };
    } else {
      const step = keybit.findUsernameOnly().filter(candidate => belongs(candidate.username));
      if (step.length === 1 && step[0].username.value.trim() && step[0].username.value.length <= 1024) send({ type: "CAPTURE_USERNAME", username: step[0].username.value });
      return;
    }
    if (!capture.password || capture.password.length > 4096 || capture.username.length > 1024) return;
    send(capture);
  }
  document.addEventListener("submit", event => {
    if (!event.isTrusted || !(event.target instanceof HTMLFormElement)) return;
    const form = event.target;
    const submitter = /** @type {HTMLButtonElement | null} */ (event.submitter);
    const action = submitter?.hasAttribute("formaction") ? submitter.formAction : form.action;
    try { if (new URL(action, location.href).origin !== location.origin) return; } catch { return; }
    if (form.method === "dialog" || !["", "_self", "_top"].includes(event.submitter?.getAttribute("formtarget") ?? form.target)) return;
    captureFor(input => input.form === form);
  }, { capture: true, signal: lifecycle.signal });
  // Many sites sign in with a script on a button or the Enter key and never submit a form.
  const SUBMIT_WORDS = /\b(log\s*-?\s*in|sign\s*-?\s*in|sign\s*-?\s*up|register|create|continue|next|submit|verify|enter|proceed|save|change|update)\b/i;
  function submitControl(target) {
    /** @type {any} A button, an input button, or an element acting as one. */
    const control = target instanceof Element ? target.closest('button, input[type="submit" i], input[type="image" i], input[type="button" i], [role="button"]') : null;
    if (!control) return null;
    if (control.matches('input[type="submit" i], input[type="image" i], button[type="submit" i]') || (control.tagName === "BUTTON" && !control.getAttribute("type") && control.form)) return control;
    return SUBMIT_WORDS.test(`${control.textContent} ${control.value ?? ""} ${control.getAttribute("aria-label") ?? ""}`) ? control : null;
  }
  // A field belongs to a control when they share a form, or sit together in a small container.
  function near(control) {
    return input => {
      if (input.form || control.form) return input.form === control.form;
      for (let node = control.parentElement, depth = 0; node && depth < 6; node = node.parentElement, depth++) if (node.contains(input)) return true;
      return false;
    };
  }
  document.addEventListener("click", event => {
    if (!event.isTrusted) return;
    /** @type {any} */
    const control = submitControl(event.target);
    // Real form submissions are handled by the submit listener.
    if (control && !(control.form && control.matches('[type="submit" i], [type="image" i], button:not([type])'))) captureFor(near(control));
  }, { capture: true, signal: lifecycle.signal });
  document.addEventListener("keydown", event => {
    if (!event.isTrusted || event.key !== "Enter" || !(event.target instanceof HTMLInputElement) || event.target.form) return;
    captureFor(near(event.target));
  }, { capture: true, signal: lifecycle.signal });
  window.addEventListener("pageshow", event => { if (event.persisted) void show(); }, { signal: lifecycle.signal });
  window.addEventListener("pagehide", close, { signal: lifecycle.signal });
  function onRuntimeMessage(message) {
    if (message?.event === "keybit-site-disabled") { disabled = true; close(); }
    // Sent by KeyBit when this tab finishes loading while a save prompt is waiting (for example after a login redirect).
    if (message?.event === "keybit-save-prompt") void show();
  }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
})();
