// Peek's host controller only reads links and Peek settings. The extension page owns the UI,
// navigation, and animations; each opening is authorized by a single-use worker session.
(() => {
  if (window !== window.top || !chrome.runtime?.id) return;
  const ns = (globalThis.__keybitPeek = { ...(globalThis.__keybitPeek ?? {}) });
  ns.dispose?.();
  // Capture this generation: module reinjection replaces properties on the shared namespace.
  const { overlay, link, settings: peekSettings, utils } = ns;
  const lifecycle = new AbortController();
  let settings = peekSettings.defaults();
  let siteAllowed = false;
  let opening = false;
  let openingToken = null;
  let suspended = false;
  let generation = 0;
  let settingsRevision = 0;

  const sendEnd = token => {
    if (!token) return;
    try { chrome.runtime.sendMessage({ type: "PEEK_END", token }).catch(() => {}); } catch { /* Extension invalidated. */ }
  };
  const allowed = () => !lifecycle.signal.aborted && !suspended && !!chrome.runtime?.id && settings.peekEnabled === true && siteAllowed;
  const enabled = () => allowed() && !opening && !overlay.isClosing;
  function applySettings(next) {
    settings = peekSettings.sanitize(next);
    overlay.command("settings", { settings });
    if (!settings.peekEnabled || !siteAllowed) overlay.close();
  }
  async function reload() {
    const revision = ++settingsRevision;
    try {
      const loaded = await peekSettings.load();
      if (lifecycle.signal.aborted || revision !== settingsRevision) return;
      siteAllowed = loaded.siteAllowed !== false;
      applySettings(loaded);
    } catch { /* Keep the last confirmed settings when the worker is temporarily unavailable. */ }
  }
  void reload();

  function sourceRect(anchor) {
    if (anchor?.checkVisibility && !anchor.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return null;
    const rect = anchor?.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
    const right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
    if (right <= left || bottom <= top) return null;
    return { x: left, y: top, left, top, right, bottom, width: right - left, height: bottom - top };
  }
  function open(wanted, anchor = null) {
    if (!enabled()) return false;
    const raw = utils.peekUrl(wanted instanceof URL ? wanted.href : wanted, location.href);
    if (!raw) return false;
    const url = utils.destinationUrl(raw);
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const token = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    const epoch = generation;
    opening = true;
    openingToken = token;
    void (async () => {
      try {
        const response = await chrome.runtime.sendMessage({ type: "PEEK_OPEN", token, url: url.href, source: sourceRect(anchor) });
        if (!response?.ok || response.data?.token !== token) return;
        if (epoch !== generation || !allowed()) { sendEnd(token); return; }
        const recover = () => open(url, anchor);
        const shown = overlay.isOpen ? overlay.switchSession(token, anchor, recover) : overlay.show(token, anchor, recover);
        if (!shown) sendEnd(token);
      } catch { /* An orphaned content script must not leave a host behind. */ }
      finally { opening = false; openingToken = null; }
    })();
    return true;
  }
  link.attach({ signal: lifecycle.signal, enabled, trigger: () => settings.peekTrigger, open });

  function onRuntimeMessage(message, sender) {
    if (sender?.id !== chrome.runtime.id) return;
    if (message?.event === "keybit-peek-settings") { applySettings(message.settings); void reload(); }
    if (message?.event === "keybit-peek-site") void reload();
    if (message?.event === "keybit-context-peek" || message?.event === "keybit-peek-open") ns.previewUrl?.(message.url);
    if (message?.event === "keybit-peek-host" && sender.url?.split("#")[0] === chrome.runtime.getURL("src/peek/peek.html")) {
      overlay.handleMessage(message);
    }
  }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  function focusedElement() {
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    return element;
  }
  ns.previewFocusedLink = () => {
    if (!enabled()) return;
    const focused = utils.findAnchor(focusedElement());
    const anchor = (focused && utils.anchorUrl(focused, document.baseURI, location.href) ? focused : null) ??
      [...document.querySelectorAll("a[href], area[href]")].find(candidate => !candidate.hasAttribute("download") &&
        sourceRect(candidate) && utils.anchorUrl(candidate, document.baseURI, location.href));
    if (!anchor) return;
    const url = utils.anchorUrl(anchor, document.baseURI, location.href);
    if (url) open(url, anchor);
  };
  ns.previewUrl = wanted => {
    if (!enabled()) return;
    const raw = utils.peekUrl(wanted, location.href);
    if (!raw) return;
    const url = utils.destinationUrl(raw);
    const anchor = [...document.querySelectorAll("a[href], area[href]")].find(candidate => !candidate.hasAttribute("download") &&
      utils.anchorUrl(candidate, document.baseURI, location.href)?.href === url.href);
    open(url, anchor ?? null);
  };
  function teardown() {
    ++generation;
    overlay.close({ restoreFocus: false, instant: true });
    // A PEEK_OPEN may still be in flight when navigation hides the host document.
    sendEnd(openingToken);
  }
  window.addEventListener("pagehide", () => { suspended = true; teardown(); }, { signal: lifecycle.signal });
  window.addEventListener("pageshow", () => { suspended = false; void reload(); }, { signal: lifecycle.signal });
  const watchdog = setInterval(() => {
    if (!chrome.runtime?.id) dispose();
  }, 2500);
  function dispose() {
    if (lifecycle.signal.aborted) return;
    clearInterval(watchdog);
    teardown();
    lifecycle.abort();
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch { /* Extension invalidated. */ }
  }
  ns.dispose = dispose;
})();
