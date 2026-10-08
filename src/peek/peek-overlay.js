// Peek's host only carries the extension page. All visible UI, preview navigation, and motion
// live at the extension origin so the host page's CSP cannot block the preview.
(() => {
  const ns = (globalThis.__keybitPeek = { ...(globalThis.__keybitPeek ?? {}) });
  const HOST_STYLES = {
    all: "initial", display: "block", position: "fixed", inset: "0", width: "100%", height: "100%",
    "max-width": "none", "max-height": "none", "min-width": "0", "min-height": "0", margin: "0", padding: "0",
    border: "0", background: "transparent", "z-index": "2147483647", "pointer-events": "auto",
    visibility: "visible", opacity: "1", transform: "none", translate: "none", rotate: "none", scale: "none",
    filter: "none", "backdrop-filter": "none", "clip-path": "none", mask: "none", overflow: "visible",
    contain: "none", "color-scheme": "light dark", animation: "none", transition: "none"
  };
  let host = null;
  let frame = null;
  let token = null;
  let source = null;
  let recover = null;
  let mode = "modal";
  let events = null;
  let observer = null;
  let closeTimer = null;
  let raises = [];
  const hasPopover = typeof HTMLElement.prototype.showPopover === "function";

  function send(message) {
    try { chrome.runtime.sendMessage(message).catch(() => {}); } catch { /* Retire quietly after an extension reload. */ }
  }
  function command(action, extra = {}) {
    if (token) send({ type: "PEEK_HOST_CMD", token, action, ...extra });
  }
  function observe() {
    observer?.observe(document, { childList: true, subtree: true });
    if (host) observer?.observe(host, { attributes: true, attributeFilter: ["style", "class", "hidden", "inert", "popover", "id"] });
  }
  function showPopover() {
    if (!hasPopover || !host?.isConnected || host.matches(":popover-open")) return;
    try { host.showPopover(); } catch { /* A detached or inactive document cannot show a popover. */ }
  }
  function repair() {
    if (!host) return;
    // Don't observe our own attribute repairs: setting an unchanged CSS declaration can itself
    // enqueue a mutation and otherwise keep this observer running indefinitely.
    observer?.disconnect();
    host.id = "keybit-peek-host";
    for (const attribute of ["hidden", "inert", "class"]) host.removeAttribute(attribute);
    if (hasPopover) host.setAttribute("popover", "manual");
    else host.removeAttribute("popover");
    host.style.cssText = "";
    for (const [property, value] of Object.entries(HOST_STYLES)) host.style.setProperty(property, value, "important");
    if (mode === "side") {
      for (const [property, value] of Object.entries({ left: "auto", top: "0", right: "0", bottom: "0",
        width: "calc(clamp(400px, 40vw, 720px) + 68px)", height: "auto" })) host.style.setProperty(property, value, "important");
    }
    if (!host.isConnected) document.documentElement?.append(host);
    showPopover();
    observe();
  }
  function raise() {
    if (!hasPopover || !host?.isConnected) return;
    const now = performance.now();
    raises = raises.filter(time => now - time < 1000);
    if (raises.length >= 20) return;
    raises.push(now);
    try {
      if (host.matches(":popover-open")) host.hidePopover();
      host.showPopover();
    } catch { /* The input gate inside Peek still protects a covered preview. */ }
  }
  function teardown({ restoreFocus = true, endSession = true } = {}) {
    if (!host) return;
    const target = source;
    const endingToken = token;
    clearTimeout(closeTimer);
    closeTimer = null;
    events?.abort();
    events = null;
    observer?.disconnect();
    observer = null;
    const previous = host;
    host = null;
    frame = null;
    token = null;
    source = null;
    recover = null;
    mode = "modal";
    raises = [];
    try { if (hasPopover && previous.matches(":popover-open")) previous.hidePopover(); } catch { /* Already detached. */ }
    previous.remove();
    if (endSession) send({ type: "PEEK_END", token: endingToken });
    if (restoreFocus && target?.isConnected) target.focus?.({ preventScroll: true });
  }
  function close({ restoreFocus = true, instant = false } = {}) {
    if (!host) return;
    if (instant) { teardown({ restoreFocus }); return; }
    if (closeTimer !== null) return;
    command("close");
    // Escape must still free the page if the extension page failed to boot or was invalidated.
    closeTimer = setTimeout(() => teardown({ restoreFocus }), 400);
  }
  function show(nextToken, anchor, onDetach) {
    if (host || !/^[0-9a-f]{32}$/.test(nextToken)) return false;
    token = nextToken;
    source = anchor;
    recover = onDetach;
    mode = "modal";
    host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "closed" });
    frame = document.createElement("iframe");
    frame.src = chrome.runtime.getURL(`src/peek/peek.html#${token}`);
    frame.title = "Link preview";
    frame.allow = "fullscreen; autoplay; encrypted-media; picture-in-picture; clipboard-write; web-share";
    frame.referrerPolicy = "no-referrer";
    // Absolute positioning fills the fixed host, including its narrower side-view column.
    Object.assign(frame.style, { position: "absolute", inset: "0", width: "100%", height: "100%", border: "0",
      background: "transparent", colorScheme: "light dark", display: "block" });
    shadow.append(frame);
    events = new AbortController();
    observer = new MutationObserver(records => {
      if (!host) return;
      const removed = !host.isConnected || records.some(record => record.type === "childList" &&
        [...record.removedNodes].some(node => node === host || node.contains(host)));
      if (removed) {
        // Removal destroys the frame's browsing context, even if the page immediately appends
        // it again. Rebuild with a fresh worker session instead of reusing its claimed token.
        const reopen = recover;
        teardown({ restoreFocus: false });
        reopen?.();
      } else if (records.some(record => record.type === "attributes" && record.target === host)) repair();
    });
    repair();
    window.addEventListener("keydown", event => {
      if (!event.isTrusted || event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    }, { capture: true, signal: events.signal });
    document.addEventListener("toggle", event => {
      if (!host) return;
      if (event.target === host) {
        if (event.newState === "closed") raise();
      } else if (mode === "modal" && event.newState === "open") raise();
    }, { capture: true, signal: events.signal });
    frame.focus({ preventScroll: true });
    return true;
  }
  function switchSession(nextToken, anchor, onDetach) {
    if (!host || closeTimer !== null || !/^[0-9a-f]{32}$/.test(nextToken)) return false;
    command("switch", { next: nextToken });
    token = nextToken;
    source = anchor;
    recover = onDetach;
    return true;
  }
  function handleMessage(message) {
    if (!host || message.token !== token) return;
    if (message.action === "closed") teardown({ restoreFocus: message.reason !== "tab", endSession: false });
    if (message.action === "layout" && ["modal", "side"].includes(message.mode)) {
      mode = message.mode;
      repair();
    }
  }
  ns.overlay = { show, switchSession, close, command, handleMessage,
    get isOpen() { return host !== null; }, get isClosing() { return closeTimer !== null; } };
})();
