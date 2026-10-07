(() => {
  if (window !== window.top) return;
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
  let opening = null;
  let generation = 0;
  let height = 132;
  let visible = false;
  let placing = 0;
  let refocusing = false;
  const supported = input => input instanceof HTMLInputElement &&
    globalThis.__keybit.find().some(fields => fields.username === input || fields.password === input);
  function close({ restoreFocus = false } = {}) {
    generation++; opening = null;
    // After a choice or Escape inside the panel, return focus to the field so Enter submits as usual.
    const restore = restoreFocus && host && document.activeElement === host ? activeInput : null;
    panelEvents?.abort(); panelEvents = null;
    host?.remove(); host = null; frame = null; activeInput = null; visible = false;
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
  async function show(input) {
    if (activeInput === input && (host || opening)) return;
    // Moving between fields of the same form reuses the open panel.
    if (host && !opening) { activeInput = input; place(); return; }
    close(); activeInput = input;
    const request = generation;
    let response;
    try { opening = chrome.runtime.sendMessage({ type: "INLINE_OPEN" }); response = await opening; } catch { response = null; }
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
    Object.assign(frame.style, { width: "100%", height: "100%", border: "0", borderRadius: "12px", boxShadow: "0 12px 32px #0000002e, 0 2px 6px #0000001a", colorScheme: "light dark", background: "transparent" });
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
    if (supported(target)) void show(target); else close();
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
  window.addEventListener("scroll", schedulePlace, { capture: true, passive: true, signal: lifecycle.signal });
  window.addEventListener("resize", schedulePlace, { signal: lifecycle.signal });
  window.addEventListener("pagehide", () => close(), { signal: lifecycle.signal });
  function onRuntimeMessage(message) { if (message?.event === "keybit-site-disabled") close(); }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  if (document.readyState !== "loading" && supported(document.activeElement)) void show(document.activeElement);
})();
