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
  // Per-site rule for this page, resolved by the worker in the PEEK_GET_SETTINGS answer.
  let siteAllowed = true;
  // Cached once so the click handler can decide synchronously; refreshes via worker broadcasts.
  const reload = () => peekSettings.load().then(loaded => { settings = loaded; siteAllowed = loaded.siteAllowed !== false; }).catch(() => {});
  void reload();

  function onRuntimeMessage(message) {
    if (message?.event === "keybit-peek-settings") settings = peekSettings.sanitize(message.settings);
    // A site-rule change for this page's origin asks Peek to re-read its allowance.
    if (message?.event === "keybit-peek-site") void reload();
    if (message?.event === "keybit-context-peek") ns.previewUrl?.(message.url);
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
    enabled: () => settings.peekEnabled === true && siteAllowed,
    trigger: () => settings.peekTrigger,
    open });
  // The command palette's "Peek this link" command: preview the focused link, else the first
  // eligible link on the page. Same eligibility rules and settings as any other Peek trigger.
  ns.previewFocusedLink = () => {
    if (settings.peekEnabled !== true || !siteAllowed) return;
    const utils = ns.utils;
    const focused = utils.findAnchor(document.activeElement);
    const anchor = focused ?? [...document.querySelectorAll("a[href]")]
      .find(candidate => candidate instanceof HTMLAnchorElement && !candidate.hasAttribute("download") &&
        candidate.getBoundingClientRect().height > 0 && utils.anchorUrl(candidate, document.baseURI, location.href));
    if (!anchor) return;
    const url = utils.anchorUrl(anchor, document.baseURI, location.href);
    if (url) open(url, anchor);
  };
  // The context menu's "Preview with KeyBit": the URL comes from the menu click, so find the
  // matching anchor for focus/scroll restore — the preview still opens when the link is gone.
  ns.previewUrl = wanted => {
    if (settings.peekEnabled !== true || !siteAllowed) return;
    const utils = ns.utils;
    const anchor = [...document.querySelectorAll("a[href]")].find(candidate =>
      candidate instanceof HTMLAnchorElement && !candidate.hasAttribute("download") && candidate.href === wanted);
    const url = anchor ? utils.anchorUrl(anchor, document.baseURI, location.href) : utils.peekUrl(wanted, location.href);
    if (url) open(utils.destinationUrl(url).href, anchor ?? null);
  };
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
