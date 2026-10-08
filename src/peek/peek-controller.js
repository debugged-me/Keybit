// Peek: bootstrap and orchestration, following the same self-contained pattern as the other
// KeyBit content scripts. Peek shares no objects with the password manager — it only reads the
// page's DOM links and its own settings over namespaced messages.
(() => {
  if (window !== window.top) return;
  // A copy injected before an extension reload/update has no runtime — retire quietly.
  if (!chrome.runtime?.id) return;
  // Re-injection after an install/update replaces the previous instance instead of stacking listeners.
  const ns = (globalThis.__keybitPeek = { ...(globalThis.__keybitPeek ?? {}) });
  ns.dispose?.();
  // Capture this generation's modules: the shared namespace is rebuilt on re-injection, so a
  // lookup through ns at dispose time could hit the newer copies and leak the old overlay.
  const { overlay, link, settings: peekSettings } = ns;
  const lifecycle = new AbortController();
  let settings = { ...(ns.utils?.DEFAULT_SETTINGS ?? {}) };
  // Cached once so the click handler can decide synchronously; refreshes via worker broadcasts.
  void peekSettings.load().then(loaded => { settings = loaded; }).catch(() => {});

  function onRuntimeMessage(message) {
    if (message?.event === "keybit-peek-settings") settings = peekSettings.sanitize(message.settings);
  }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  const open = (url, anchor) => {
    overlay.open(url, anchor, {
      size: settings.peekSize,
      backdropClose: settings.peekBackdropClose,
      loadingIndicator: settings.peekLoadingIndicator
    });
  };
  link.attach({ signal: lifecycle.signal,
    enabled: () => settings.peekEnabled === true,
    trigger: () => settings.peekTrigger,
    open });
  // Instant close on unload: the animation timer may never fire while navigating or entering the
  // back-forward cache, which would leave the page scroll-locked.
  window.addEventListener("pagehide", () => overlay.close({ restoreFocus: false, instant: true }), { signal: lifecycle.signal });
  // If the extension reloads while a preview is open this script is orphaned: chrome.runtime is
  // gone, listeners die, and the page would keep the overlay plus its scroll lock. Free it.
  const watchdog = setInterval(() => {
    if (chrome.runtime?.id) return;
    clearInterval(watchdog);
    overlay.close({ restoreFocus: false, instant: true });
    lifecycle.abort();
  }, 2500);

  ns.dispose = () => {
    clearInterval(watchdog);
    overlay.close({ restoreFocus: false });
    lifecycle.abort();
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch { /* Orphaned after an extension reload. */ }
  };
})();
