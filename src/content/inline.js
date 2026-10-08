(() => {
  if (window !== window.top) return;
  // A copy injected before an extension reload/update has no runtime — retire quietly.
  if (!chrome.runtime?.id) return;
  // Re-injection after an install/update replaces the previous instance instead of stacking listeners.
  globalThis.__keybitInline?.dispose();
  const lifecycle = new AbortController();
  globalThis.__keybitInline = { dispose: () => {
    close(); lifecycle.abort();
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch { /* Orphaned after an extension reload. */ }
  } };
  let host = null;
  let panelEvents = null;
  let frame = null;
  let activeInput = null;
  let activeMode = null;
  let opening = null;
  let generation = 0;
  let height = 132;
  let visible = false;
  let placing = 0;
  let refocusing = false;
  // "login" fields get saved accounts; new-password fields on sign-up and change forms get a generated password.
  // Also: the username step of a two-step sign-in, and 2FA code fields. Only field types that can match are scanned.
  const CANDIDATE_TYPES = ["text", "email", "tel", "password", "number"];
  function modeFor(input) {
    if (!(input instanceof HTMLInputElement) || !CANDIDATE_TYPES.includes(input.type)) return null;
    const keybit = globalThis.__keybit;
    if (keybit.find().some(fields => fields.username === input || fields.password === input)) return "login";
    if (input.type === "password") return keybit.findNew().some(form => form.fields.includes(input)) ? "new" : null;
    if (keybit.findOtp().some(form => form.fields.includes(input))) return "otp";
    if (keybit.findUsernameOnly().some(step => step.username === input)) return "username";
    if (keybit.findPayment().some(form => [form.number, form.holder, form.csc, form.expiry, form.expMonth, form.expYear].includes(input))) return "card";
    if (keybit.findIdentity().some(entry => [...entry.fields.values()].includes(input))) return "identity";
    return null;
  }
  const supported = input => modeFor(input) !== null;
  function close({ restoreFocus = false } = {}) {
    generation++; opening = null;
    // After a choice or Escape inside the panel, return focus to the field so Enter submits as usual.
    const restore = restoreFocus && host && document.activeElement === host ? activeInput : null;
    panelEvents?.abort(); panelEvents = null;
    host?.remove(); host = null; frame = null; activeInput = null; activeMode = null; visible = false;
    if (restore?.isConnected) { refocusing = true; restore.focus({ preventScroll: true }); refocusing = false; }
  }
  function place() {
    placing = 0;
    if (!host || !activeInput) return;
    const rect = activeInput.getBoundingClientRect();
    if (!activeInput.isConnected || !rect.width || rect.bottom < 0 || rect.top > innerHeight) { close(); return; }
    const width = Math.min(Math.max(rect.width, 300), 380, innerWidth - 16);
    const size = Math.min(height, innerHeight - 16);
    const below = rect.bottom + 6;
    const top = below + size <= innerHeight - 8 || rect.top - size - 6 < 8 ? below : rect.top - size - 6;
    Object.assign(host.style, { width: `${width}px`, height: `${size}px`, top: `${Math.max(8, top)}px`,
      left: `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`, opacity: visible ? "1" : "0" });
  }
  const schedulePlace = () => { if (host && !placing) placing = requestAnimationFrame(place); };
  async function show(input, mode = modeFor(input)) {
    if (!mode || (activeInput === input && (host || opening))) return;
    // Moving between fields of the same kind reuses the open panel.
    if (host && !opening && activeMode === mode) { activeInput = input; place(); return; }
    close(); activeInput = input; activeMode = mode;
    const request = generation;
    let response;
    try { opening = chrome.runtime.sendMessage({ type: "INLINE_OPEN", mode }); response = await opening; } catch { response = null; }
    if (request !== generation) return;
    opening = null;
    if (!response?.ok || !response.data?.enabled || !input.isConnected) { activeInput = null; return; }
    const token = response.data.token;
    host = document.createElement("div");
    Object.assign(host.style, { all: "initial", position: "fixed", zIndex: "2147483647", display: "block", opacity: "0", transition: "opacity .12s ease-out" });
    const shadow = host.attachShadow({ mode: "closed" });
    frame = document.createElement("iframe");
    frame.title = "KeyBit login suggestions";
    frame.src = chrome.runtime.getURL(`src/inline/panel.html#${token}`);
    frame.referrerPolicy = "no-referrer";
    Object.assign(frame.style, { width: "100%", height: "100%", border: "0", borderRadius: "14px", boxShadow: "0 16px 44px #00000038, 0 3px 8px #00000021", colorScheme: "light dark", background: "transparent" });
    shadow.append(frame); document.documentElement.append(host);
    place();
    const frameWindow = frame.contentWindow;
    // Reveal after the first render, or after a short wait if the site blocks the frame from reporting.
    const reveal = () => { if (request === generation && host && !visible) { visible = true; place(); } };
    setTimeout(reveal, 400);
    panelEvents = new AbortController();
    window.addEventListener("message", event => {
      if (event.source !== frameWindow || event.data?.token !== token) return;
      if (event.data.type === "KEYBIT_RESIZE" && Number.isFinite(event.data.height)) {
        height = Math.max(64, Math.min(360, event.data.height)); reveal(); place();
      }
      if (event.data.type === "KEYBIT_CLOSE") close({ restoreFocus: true });
    }, { signal: panelEvents.signal });
  }
  document.addEventListener("focusin", event => {
    const target = event.target;
    if (target === host || refocusing) return;
    const mode = modeFor(target);
    if (mode) void show(target, mode); else close();
  }, { signal: lifecycle.signal });
  // Clicking a field that already has focus does not fire focusin, so reopen on click too.
  document.addEventListener("click", event => {
    if (event.isTrusted && !(activeInput === event.target && host) && supported(event.target)) void show(event.target);
  }, { capture: true, signal: lifecycle.signal });
  document.addEventListener("pointerdown", event => {
    if ((host || opening) && event.target !== activeInput && !event.composedPath().includes(host) && !supported(event.target)) close();
  }, { capture: true, signal: lifecycle.signal });
  document.addEventListener("keydown", event => {
    if (!host || event.target !== activeInput) return;
    if (event.key === "Escape") close();
    else if (event.key === "ArrowDown" && event.isTrusted && visible) {
      // Keyboard choice happens inside the extension frame, where the page cannot synthesize keys.
      event.preventDefault(); frame.focus();
      frame.contentWindow.postMessage({ type: "KEYBIT_KEYBOARD" }, new URL(frame.src).origin);
    }
  }, { capture: true, signal: lifecycle.signal });
  // Typing in the username field narrows the account list. Password values are never sent.
  document.addEventListener("input", event => {
    if (!host || event.target !== activeInput || activeInput.type === "password" || !["login", "username"].includes(activeMode)) return;
    frame?.contentWindow?.postMessage({ type: "KEYBIT_FILTER", text: activeInput.value.slice(0, 200) }, new URL(frame.src).origin);
  }, { capture: true, signal: lifecycle.signal });
  window.addEventListener("scroll", schedulePlace, { capture: true, passive: true, signal: lifecycle.signal });
  window.addEventListener("resize", schedulePlace, { signal: lifecycle.signal });
  window.addEventListener("pagehide", () => close(), { signal: lifecycle.signal });
  function onRuntimeMessage(message) {
    if (message?.event === "keybit-site-disabled") close();
    if (message?.event === "keybit-show") {
      // Keyboard shortcut: open on the focused field, or focus the page's login field (which opens it).
      if (supported(document.activeElement)) { void show(document.activeElement); return; }
      const login = globalThis.__keybit.find()[0];
      (login?.username ?? login?.password ?? globalThis.__keybit.findNew()[0]?.fields[0])?.focus();
    }
  }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  if (document.readyState !== "loading" && supported(document.activeElement)) void show(document.activeElement);
})();
