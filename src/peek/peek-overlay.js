// Peek: the floating preview window. One host element with a closed shadow root keeps the page's
// CSS out and ours in. Layout-critical styles are inline so the dialog still works if the host
// page's CSP blocks peek.css; the stylesheet handles theme, states, and animation.
(() => {
  const ns = (globalThis.__keybitPeek = { ...(globalThis.__keybitPeek ?? {}) });
  const SIZES = {
    compact: { width: "860px", height: "640px" },
    default: { width: "1440px", height: "calc(100dvh - 88px)" },
    large: { width: "1800px", height: "calc(100dvh - 72px)" }
  };
  let host = null;
  let shadow = null;
  let nodes = null;        // toolbar/body/loading/fallback pieces, rebuilt with the DOM
  let events = null;       // AbortController covering this open session
  let frameCtl = null;
  let source = null;       // the link Peek came from, refocused on close
  let currentUrl = null;
  let backdropClose = true;
  let previousOverflow = null;
  let previousGutter = null;
  let removing = null;     // close-animation timer
  let previewSize = SIZES.default;
  let expanded = false;
  let sizeAnimation = null;

  function lockScroll() {
    if (previousOverflow !== null) return;
    const root = document.documentElement;
    previousOverflow = root.style.overflow;
    previousGutter = root.style.scrollbarGutter;
    if (window.innerWidth > root.clientWidth) root.style.scrollbarGutter = "stable";
    root.style.overflow = "hidden";
  }
  function unlockScroll() {
    if (previousOverflow === null) return;
    document.documentElement.style.overflow = previousOverflow;
    document.documentElement.style.scrollbarGutter = previousGutter;
    previousOverflow = null;
    previousGutter = null;
  }
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function button(className, text, label) {
    const node = el("button", `kb-peek-button ${className}`, text);
    node.type = "button";
    if (label) node.setAttribute("aria-label", label);
    if (label) node.title = label;
    return node;
  }
  function svg(path) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    node.setAttribute("viewBox", "0 0 24 24");
    node.setAttribute("aria-hidden", "true");
    const part = document.createElementNS("http://www.w3.org/2000/svg", "path");
    part.setAttribute("d", path);
    node.append(part);
    return node;
  }

  function build() {
    host = el("div");
    host.id = "keybit-peek-host";
    Object.assign(host.style, { all: "initial", position: "fixed", inset: "0", zIndex: "2147483647" });
    shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("link");
    style.rel = "stylesheet";
    style.href = chrome.runtime.getURL("src/peek/peek.css");
    const backdrop = el("div", "kb-peek-backdrop");
    Object.assign(backdrop.style, { position: "fixed", inset: "0" });
    const win = el("div", "kb-peek-window");
    win.setAttribute("role", "dialog");
    win.setAttribute("aria-modal", "true");
    win.setAttribute("aria-label", "Link preview");
    Object.assign(win.style, { position: "fixed", left: "50%", top: "50%", translate: "-50% -50%",
      display: "flex", flexDirection: "column", width: "min(var(--peek-width), calc(100vw - var(--peek-gutter, 144px)))",
      height: "min(var(--peek-height), calc(100dvh - var(--peek-vertical-gutter, 88px)))" });
    const toolbar = el("div", "kb-peek-toolbar");
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Preview controls");
    const site = el("span", "kb-peek-site");
    site.append(svg("M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0c2.5 2.2 3.9 5.4 3.9 9s-1.4 6.8-3.9 9c-2.5-2.2-3.9-5.4-3.9-9s1.4-6.8 3.9-9ZM3.6 9h16.8M3.6 15h16.8"));
    const siteText = el("span", "kb-peek-site-text");
    site.append(siteText);
    const expand = button("kb-peek-expand", "", "Expand preview");
    expand.title = "Expand preview";
    expand.setAttribute("aria-pressed", "false");
    expand.append(svg("M8 3H3v5m0-5 7 7m6 11h5v-5m0 5-7-7"));
    const openTab = button("kb-peek-open-tab", "", "Open in tab");
    openTab.append(svg("M14 4h6v6m0-6L10 14m0-9H5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-5"));
    const close = button("kb-peek-close", "", "Close preview");
    close.append(svg("M6 6l12 12M18 6 6 18"));
    toolbar.append(close, expand, openTab);
    // CSS tooltips work for hover and keyboard focus without also showing a native tooltip.
    for (const control of [close, expand, openTab]) control.removeAttribute("title");
    const surface = el("div", "kb-peek-surface");
    Object.assign(surface.style, { display: "flex", flexDirection: "column", flex: "1", minHeight: "0", overflow: "hidden" });
    const body = el("div", "kb-peek-body");
    Object.assign(body.style, { position: "relative", flex: "1" });
    const loading = el("div", "kb-peek-loading");
    loading.setAttribute("role", "status");
    Object.assign(loading.style, { position: "absolute", inset: "0", display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", gap: "12px" });
    const spinner = el("span", "kb-peek-spinner");
    spinner.setAttribute("aria-hidden", "true");
    spinner.append(svg("M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3M14 3h7v7m0-7L10 14"));
    const loadingText = el("span", "kb-peek-loading-text");
    const still = button("kb-peek-still", "Open in tab");
    still.hidden = true;
    loading.append(spinner, loadingText, still);
    const fallback = el("div", "kb-peek-fallback");
    fallback.hidden = true;
    Object.assign(fallback.style, { position: "absolute", inset: "0", display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", gap: "10px", textAlign: "center" });
    const fallbackOpen = button("kb-peek-fallback-open", "Open in tab");
    const fallbackClose = button("kb-peek-fallback-close", "Close");
    const fallbackActions = el("div", "kb-peek-fallback-actions");
    fallbackActions.append(fallbackOpen, fallbackClose);
    const fallbackIcon = el("span", "kb-peek-fallback-icon");
    fallbackIcon.append(svg("M14 4h6v6m0-6L10 14m0-9H5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-5"));
    fallback.append(fallbackIcon, el("p", "kb-peek-fallback-title", "Open this page in a tab"),
      el("p", "kb-peek-fallback-text", "This page can’t be shown here. Your place on the original page is saved."),
      fallbackActions);
    const notice = el("div", "kb-peek-notice");
    const noticeOpen = button("kb-peek-notice-open", "Open in tab ↗");
    notice.append(el("span", "", "Not seeing the page?"), noticeOpen);
    notice.hidden = true;
    notice.setAttribute("role", "status");
    body.append(loading, fallback);
    surface.append(body, notice);
    win.append(site, toolbar, surface);
    shadow.append(style, backdrop, win);
    nodes = { backdrop, win, site, siteText, expand, openTab, close, body, loading, spinner, loadingText, still,
      fallback, fallbackOpen, fallbackClose, notice, noticeOpen };
    backdrop.addEventListener("click", () => { if (backdropClose) closePeek(); });
    close.addEventListener("click", () => closePeek());
    fallbackClose.addEventListener("click", () => closePeek());
    openTab.addEventListener("click", () => void openInTab());
    still.addEventListener("click", () => void openInTab());
    fallbackOpen.addEventListener("click", () => void openInTab());
    noticeOpen.addEventListener("click", () => void openInTab());
    expand.addEventListener("click", () => {
      sizeAnimation?.cancel();
      const before = win.getBoundingClientRect();
      expanded = !expanded;
      // Lay out the iframe once at the final size; animate the shell with a compositor transform
      // instead of forcing the embedded website to reflow on every animation frame.
      applySize(expanded ? { width: "100vw", height: "100dvh" } : previewSize);
      win.classList.toggle("kb-peek-expanded", expanded);
      const after = win.getBoundingClientRect();
      if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
        win.style.transformOrigin = "50% 50%";
        sizeAnimation = win.animate([
          { transform: `scale(${before.width / after.width}, ${before.height / after.height})` },
          { transform: "scale(1)" }
        ], { duration: 240, easing: "cubic-bezier(.2, .8, .2, 1)" });
      }
      expand.setAttribute("aria-pressed", String(expanded));
      expand.setAttribute("aria-label", expanded ? "Restore preview size" : "Expand preview");
      expand.querySelector("path").setAttribute("d", expanded ? "M3 8h5V3M8 8 2 2m19 14h-5v5m0-5 6 6" : "M8 3H3v5m0-5 7 7m6 11h5v-5m0 5-7-7");
    });
    // Tab order: toolbar buttons, then the frame, then any visible body buttons. Only the edges
    // wrap — between them the natural order applies, and inside the frame the page owns the keys.
    win.addEventListener("keydown", event => {
      if (event.key !== "Tab") return;
      const focusables = [close, expand, openTab, frameCtl?.element, still, fallbackOpen, fallbackClose, noticeOpen]
        .filter(node => node && !node.hidden && !node.disabled && node.offsetParent !== null);
      if (!focusables.length) return;
      const index = focusables.indexOf(shadow.activeElement);
      const next = event.shiftKey ? (index <= 0 ? focusables[focusables.length - 1] : focusables[index - 1])
        : (index === -1 || index === focusables.length - 1 ? focusables[0] : focusables[index + 1]);
      event.preventDefault();
      next.focus({ preventScroll: true });
    });
  }

  function applySize(size) {
    nodes.win.style.setProperty("--peek-width", size.width);
    nodes.win.style.setProperty("--peek-height", size.height);
  }

  async function openInTab() {
    if (!currentUrl) return;
    try {
      const response = await chrome.runtime.sendMessage({ type: "PEEK_OPEN_TAB", url: currentUrl.href });
      if (response?.ok) closePeek({ restoreFocus: false });
    } catch { /* Orphaned after an extension reload; leave Peek open so it stays usable. */ }
  }
  function showState(state, url, options) {
    if (!nodes || removing) return;
    nodes.body.dataset.state = state;
    nodes.body.dataset.loading = String(options.loadingIndicator !== false);
    nodes.body.setAttribute("aria-busy", String(state === "loading"));
    nodes.siteText.textContent = ns.utils.displayHost(url);
    nodes.site.title = url.href;
    nodes.loading.hidden = state === "ready" || state === "unconfirmed" || state === "error" || !options.loadingIndicator;
    nodes.fallback.hidden = state !== "error";
    nodes.still.hidden = state !== "slow";
    nodes.spinner.hidden = state === "slow";
    nodes.notice.hidden = state !== "unconfirmed";
    // Inline display:flex overrides the browser's default [hidden] rule, even when peek.css is
    // blocked. Hide the layers explicitly so they cannot cover a successfully loaded frame.
    for (const node of [nodes.loading, nodes.fallback]) node.style.display = node.hidden ? "none" : "flex";
    nodes.spinner.style.display = nodes.spinner.hidden ? "none" : "grid";
    nodes.still.style.display = nodes.still.hidden ? "none" : "inline-flex";
    nodes.loadingText.textContent = state === "slow" ? "Taking a little longer…" : `Opening ${ns.utils.displayHost(url)}…`;
  }

  function loadFrame(url, options) {
    frameCtl?.dispose();
    frameCtl = ns.frame.create(url, {
      onLoad: () => { if (nodes) showState("ready", url, options); },
      onSlow: () => { if (nodes) showState("slow", url, options); },
      onError: () => { if (nodes) showState("error", url, options); },
      onUnconfirmed: () => { if (nodes) showState("unconfirmed", url, options); },
      onClose: () => closePeek()
    });
    Object.assign(frameCtl.element.style, { position: "absolute", inset: "0", width: "100%", height: "100%", border: "0", display: "block" });
    // First child keeps loading/fallback on top of the frame even without the stylesheet.
    nodes.body.prepend(frameCtl.element);
  }

  // The window grows out of the clicked link (clamped to its edges for off-screen links).
  function growOrigin() {
    const rect = nodes.win.getBoundingClientRect();
    const link = source?.getBoundingClientRect?.();
    if (!link || (!link.width && !link.height)) return "50% 50%";
    const x = Math.min(Math.max(link.left + link.width / 2 - rect.left, 0), rect.width);
    const y = Math.min(Math.max(link.top + link.height / 2 - rect.top, 0), rect.height);
    return `${x}px ${y}px`;
  }

  function open(url, anchor, options = {}) {
    if (removing) finishClose();
    if (anchor) source = anchor;
    previewSize = SIZES[options.size] ?? SIZES.default;
    expanded = false;
    backdropClose = options.backdropClose !== false;
    if (!host) {
      events = new AbortController();
      build();
      wire();
      document.documentElement.append(host);
      lockScroll();
      nodes.close.focus({ preventScroll: true });
    }
    // A hostile or heavy-handed page can remove our host; put it back.
    if (!host.isConnected) document.documentElement.append(host);
    host.classList.remove("kb-peek-closing");
    currentUrl = url;
    nodes.win.className = `kb-peek-window kb-peek-size-${options.size ?? "default"}`;
    nodes.expand.setAttribute("aria-pressed", "false");
    nodes.expand.setAttribute("aria-label", "Expand preview");
    applySize(previewSize);
    nodes.win.style.transformOrigin = growOrigin();
    showState("loading", url, options);
    loadFrame(url, options);
  }

  function wire() {
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closePeek();
    }, { capture: true, signal: events.signal });
  }

  function finishClose() {
    clearTimeout(removing);
    removing = null;
    sizeAnimation?.cancel(); sizeAnimation = null;
    frameCtl?.dispose(); frameCtl = null;
    host?.remove();
    host = null; shadow = null; nodes = null;
    unlockScroll();
  }

  // instant: skip the close animation — used on pagehide/orphaning, where a delayed timer may
  // never run and the page would be left scroll-locked (unresponsive).
  function closePeek({ restoreFocus = true, instant = false } = {}) {
    if (removing) { if (instant) finishClose(); return; }
    const target = restoreFocus && source?.isConnected ? source : null;
    source = null;
    currentUrl = null;
    events?.abort(); events = null;
    if (!host) { target?.focus({ preventScroll: true }); return; }
    if (instant || matchMedia("(prefers-reduced-motion: reduce)").matches) finishClose();
    else {
      sizeAnimation?.cancel();
      host.classList.add("kb-peek-closing");
      host.style.pointerEvents = "none";
      host.inert = true;
      // Keep the rendered frame until the fade finishes, so closing never flashes a blank card.
      removing = setTimeout(finishClose, 190);
    }
    target?.focus({ preventScroll: true });
  }

  ns.overlay = {
    open,
    close: closePeek,
    isOpen: () => !!host
  };
})();
