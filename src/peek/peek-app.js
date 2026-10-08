// The preview UI runs at the extension origin, isolated from the host page's CSS and CSP.
// Only the worker can grant a session; page metadata always comes from a trusted runtime sender.
(() => {
  const utils = globalThis.__keybitPeek?.utils;
  let token = location.hash.slice(1);
  if (!utils || !/^[0-9a-f]{32}$/.test(token)) return;

  const root = document.documentElement;
  const node = id => /** @type {HTMLElement} */ (document.getElementById(id));
  const button = id => /** @type {HTMLButtonElement} */ (document.getElementById(id));
  const backdrop = node("backdrop"), dialog = node("peek-window"), card = node("card");
  const pill = node("site-pill"), controls = node("controls"), progress = node("progress");
  const progressBar = /** @type {HTMLElement} */ (progress.firstElementChild);
  const site = button("site"), siteHost = node("site-host"), siteTitle = node("site-title");
  const icon = /** @type {HTMLImageElement} */ (node("site-icon"));
  const letter = node("site-letter"), stateLayer = node("state-layer"), toast = node("toast");
  const tooltip = node("tooltip"), slow = node("slow-loading"), status = node("preview-status");
  const back = button("back"), forward = button("forward"), split = button("split");
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  button("expand").setAttribute("aria-label", `Open in new tab (${mac ? "⌘↩" : "Ctrl+Enter"})`);
  const abort = new AbortController();
  const listen = (target, type, handler, options = {}) => target.addEventListener(type, handler, { ...options, signal: abort.signal });
  /** @type {any} */
  let session = null;
  let settings = utils.sanitizeSettings({});
  /** @type {HTMLIFrameElement | null} */
  let inner = null;
  /** @type {number | null} */
  let innerFrameId = null;
  let documentId = null;
  let expectingHello = false, hasHello = false, initialFocus = true, loading = false, disposed = false;
  let entries = [], index = 0, phase = "boot", mode = "modal";
  let sideRegion = false, awaitingSideResize = false, fullWidth = innerWidth;
  let navigationVersion = 0, switchVersion = 0;
  let slowTimer = 0, blockedTimer = 0, progressTimer = 0, toastTimer = 0, tooltipTimer = 0, resizeTimer = 0;
  let progressAnimation = null;
  const animations = new Set();
  let rect = { x: 0, y: 0, width: 1, height: 1 };
  let currentTitle = "", iconURL = "", fallbackIcon = "";
  let backdropDown = false;

  async function request(type, payload = {}) {
    const result = await chrome.runtime.sendMessage({ type, ...payload });
    if (!result?.ok) throw new Error(typeof result?.error === "string" ? result.error : "Couldn't complete that preview action.");
    return result.data;
  }
  function host(action, payload = {}) {
    if (!session?.tabId && session?.tabId !== 0) return Promise.resolve();
    return chrome.tabs.sendMessage(session.tabId, { event: "keybit-peek-host", token, action, ...payload }, { frameId: 0 }).catch(() => {});
  }
  function agent(action) {
    if (innerFrameId === null || !session) return;
    chrome.tabs.sendMessage(session.tabId, { event: "keybit-peek-agent", action }, { frameId: innerFrameId }).catch(() => {});
  }
  const currentURL = () => entries[index]?.url ?? session?.frameUrl;
  const shareURL = () => currentURL() === session?.frameUrl ? session.url : currentURL();
  const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function spring({ stiffness = 320, damping = 28, mass = 1 } = {}) {
    const w0 = Math.sqrt(stiffness / mass), z = damping / (2 * Math.sqrt(stiffness * mass));
    const x = t => z < 1
      ? 1 - Math.exp(-z * w0 * t) * (Math.cos(w0 * Math.sqrt(1 - z * z) * t) + (z / Math.sqrt(1 - z * z)) * Math.sin(w0 * Math.sqrt(1 - z * z) * t))
      : 1 - Math.exp(-w0 * t) * (1 + w0 * t);
    let end = 0;
    for (let t = 0; t < 2; t += 1 / 240) if (Math.abs(1 - x(t)) > .0015) end = t;
    const points = [];
    for (let i = 0; i <= 60; i++) points.push(+x(end * i / 60).toFixed(4));
    points[60] = 1;
    return { easing: `linear(${points.join(",")})`, duration: Math.round(end * 1000) };
  }
  function animate(element, frames, options = {}) {
    if (motion.matches) {
      frames = frames.map(frame => ({ ...frame, ...(frame.transform === undefined ? {} : { transform: "none" }) }));
      options = { ...options, duration: 120, delay: 0, easing: "linear" };
    }
    const animation = element.animate(frames, { duration: 220, fill: "both", ...options });
    animations.add(animation);
    return animation.finished.then(() => {
      const last = frames[frames.length - 1];
      for (const [key, value] of Object.entries(last)) {
        if (!["offset", "easing", "composite"].includes(key)) element.style[key] = value;
      }
    }).catch(() => {}).finally(() => { animations.delete(animation); animation.cancel(); });
  }
  function cancelAnimations() {
    for (const animation of animations) animation.cancel();
    animations.clear();
  }
  function disarm() {
    card.dataset.animating = "true";
    card.style.willChange = "transform, opacity";
    agent("animating");
    hideTooltip();
  }
  function settle() {
    if (disposed || phase === "closing" || phase === "expanding") return;
    phase = "idle";
    card.dataset.animating = "false";
    card.style.willChange = "auto";
    agent("settled");
  }

  function layout() {
    const width = innerWidth, height = innerHeight;
    const narrow = mode === "modal" && width < 700;
    root.dataset.mode = mode;
    root.dataset.narrow = String(narrow);
    dialog.setAttribute("aria-modal", String(mode === "modal"));
    split.hidden = mode === "modal" && width < 900;
    split.setAttribute("aria-pressed", String(mode === "side"));
    split.setAttribute("aria-label", mode === "side" ? "Return to centered preview" : "Use side view");
    if (mode === "side") {
      const cardWidth = sideRegion ? width - 68 : clamp(width * .4, 400, 720);
      // A header above the page keeps the site pill out of the agent's visibility rectangle.
      rect = { x: width - cardWidth - 12, y: 50, width: Math.max(1, cardWidth), height: Math.max(1, height - 62) };
      card.style.left = "auto";
      card.style.right = "12px";
    } else {
      fullWidth = width;
      const gutter = narrow ? 10 : settings.peekSize === "large" ? 52 : 64;
      const availableWidth = Math.max(1, width - gutter * 2);
      const cardWidth = settings.peekSize === "compact" ? Math.min(960, availableWidth)
        : settings.peekSize === "large" ? availableWidth : Math.min(1280, availableWidth);
      const top = narrow ? 56 : 54, bottom = narrow ? 26 : 26;
      const availableHeight = Math.max(1, height - top - bottom);
      const cardHeight = settings.peekSize === "compact" ? Math.min(760, availableHeight) : availableHeight;
      rect = { x: (width - cardWidth) / 2, y: top + (availableHeight - cardHeight) / 2, width: cardWidth, height: cardHeight };
      card.style.left = `${rect.x}px`;
      card.style.right = "auto";
    }
    Object.assign(card.style, { top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    Object.assign(pill.style, { left: `${rect.x}px`, top: `${rect.y - 38}px`, maxWidth: `${Math.max(68, rect.width - (narrow ? 92 : 40))}px` });
    Object.assign(controls.style, {
      left: `${mode === "side" ? rect.x - 44 : narrow ? rect.x + rect.width - 72 : rect.x + rect.width + 12}px`,
      top: `${narrow ? rect.y - 40 : rect.y}px`
    });
    Object.assign(toast.style, { left: `${rect.x + rect.width / 2}px`, top: `${mode === "side" ? 13 : rect.y + rect.height + 4}px` });
  }
  function sourceTransform(closing = false) {
    const source = session?.source;
    const x = source?.x ?? source?.left, y = source?.y ?? source?.top;
    if (mode === "side" || !source || ![x, y, source.width, source.height].every(Number.isFinite)) return `scale(${closing ? .94 : .92})`;
    const scale = clamp(Math.max(source.width / rect.width, source.height / rect.height), .2, .6) * (closing ? .9 : 1);
    return `translate(${x + source.width / 2 - rect.x - rect.width / 2}px, ${y + source.height / 2 - rect.y - rect.height / 2}px) scale(${scale})`;
  }
  async function openMotion() {
    phase = "opening";
    disarm();
    const jobs = [
      animate(card, [{ transform: sourceTransform() }, { transform: "none" }], spring()),
      animate(card, [{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing: "linear" }),
      animate(backdrop, [{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: "cubic-bezier(.2,0,0,1)" }),
      animate(pill, [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 260, delay: 110, easing: "cubic-bezier(.2,0,0,1)" })
    ];
    [...controls.children].forEach((control, i) => jobs.push(animate(control,
      [{ opacity: 0, transform: "translateX(-8px) scale(.8)" }, { opacity: 1, transform: "none" }],
      { duration: 280, delay: 90 + 45 * i, easing: "cubic-bezier(.16,1,.3,1)" })));
    await Promise.all(jobs);
    if (phase === "opening") settle();
  }
  function clearLoadTimers() {
    clearTimeout(slowTimer); clearTimeout(blockedTimer); clearTimeout(progressTimer);
  }
  function startLoading() {
    navigationVersion++;
    expectingHello = true;
    hasHello = false;
    documentId = null;
    loading = true;
    clearLoadTimers();
    slow.hidden = true;
    stateLayer.hidden = true;
    if (inner) { inner.style.visibility = "visible"; inner.removeAttribute("aria-hidden"); }
    progress.hidden = !settings.peekLoadingIndicator;
    progress.dataset.loading = "true";
    progressAnimation?.cancel();
    progressBar.style.transform = "scaleX(.02)";
    progressAnimation = progressBar.animate([{ transform: "scaleX(.02)" }, { transform: "scaleX(.7)" }], { duration: motion.matches ? 120 : 2000, easing: "cubic-bezier(.1,.7,.2,1)", fill: "forwards" });
    status.textContent = "Loading preview";
    const version = navigationVersion;
    slowTimer = window.setTimeout(() => { if (version === navigationVersion && loading) slow.hidden = false; }, 12000);
  }
  function advanceProgress(value) {
    const from = getComputedStyle(progressBar).transform;
    progressAnimation?.cancel();
    progressAnimation = progressBar.animate([{ transform: from }, { transform: `scaleX(${value})` }], { duration: 180, easing: "ease-out", fill: "forwards" });
  }
  function loaded() {
    if (disposed || !inner) return;
    loading = false;
    clearTimeout(slowTimer);
    clearTimeout(progressTimer);
    slow.hidden = true;
    advanceProgress(1);
    progressTimer = window.setTimeout(() => { progress.dataset.loading = "false"; }, 200);
    status.textContent = "Preview loaded";
    clearTimeout(blockedTimer);
    const version = navigationVersion;
    blockedTimer = window.setTimeout(() => {
      if (version !== navigationVersion || hasHello || session.unblock || disposed) return;
      stateLayer.hidden = false;
      inner.style.visibility = "hidden";
      inner.setAttribute("aria-hidden", "true");
      status.textContent = "This site doesn't allow previews";
      if (document.activeElement === inner || document.activeElement === card) button("unblock").focus();
    }, 1500);
  }
  function updateHistory() {
    const controls = /** @type {Array<[HTMLButtonElement, HTMLElement, boolean]>} */ ([[back, node("back-slot"), index > 0], [forward, node("forward-slot"), index < entries.length - 1]]);
    for (const [control, slot, available] of controls) {
      control.disabled = !available;
      control.tabIndex = available ? 0 : -1;
      slot.dataset.available = String(available);
    }
  }
  function useIcon(url) {
    iconURL = url;
    icon.hidden = true;
    letter.hidden = false;
    icon.src = url;
  }
  function updateSite(reset = false) {
    const url = utils.peekUrl(shareURL());
    if (!url) return;
    siteHost.textContent = utils.displayHost(url);
    siteTitle.textContent = currentTitle;
    site.setAttribute("aria-label", `Copy link to ${utils.displayHost(url)}`);
    site.title = currentTitle ? `${currentTitle}\n${url.href}` : url.href;
    letter.textContent = utils.displayHost(url).slice(0, 1).toUpperCase();
    if (inner) inner.title = `Preview of ${utils.displayHost(url)}`;
    if (reset || !fallbackIcon) {
      fallbackIcon = chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url.href)}&size=32`);
      useIcon(fallbackIcon);
    }
    updateHistory();
  }
  function pushURL(url) {
    entries = entries.slice(0, index + 1);
    entries.push({ url });
    index = entries.length - 1;
    // A long-lived side preview should not accumulate unbounded in-memory navigation state.
    if (entries.length > 500) { entries.shift(); index--; }
  }
  function replaceLocation(url) {
    try { inner.contentWindow.location.replace(url); }
    catch { loading = false; clearLoadTimers(); progress.dataset.loading = "false"; showToast("Couldn't load that page. Try opening it in a tab."); }
  }
  function navigate(url, push = true) {
    const target = utils.peekUrl(url);
    if (!target || disposed || phase === "closing" || phase === "expanding") return;
    if (push) pushURL(target.href);
    else entries[index].url = target.href;
    currentTitle = "";
    startLoading();
    updateSite(true);
    replaceLocation(target.href);
  }
  function traverse(direction) {
    const next = index + direction;
    if (next < 0 || next >= entries.length || phase === "closing" || phase === "expanding") return;
    index = next;
    navigate(entries[index].url, false);
  }

  function showToast(message) {
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { toast.hidden = true; }, 2600);
  }
  async function copyLink() {
    const url = shareURL();
    try {
      try { await navigator.clipboard.writeText(url); }
      catch {
        const input = document.createElement("textarea");
        input.value = url;
        input.setAttribute("aria-hidden", "true");
        Object.assign(input.style, { position: "fixed", top: "-9999px", opacity: "0" });
        document.body.append(input);
        input.select();
        let copied = false;
        try { copied = document.execCommand("copy"); } finally { input.remove(); site.focus({ preventScroll: true }); }
        if (!copied) throw new Error("Copy failed");
      }
      showToast("Link copied");
    } catch { showToast("Couldn't copy the link"); }
  }
  function finish(reason) {
    if (disposed) return;
    disposed = true;
    phase = "closed";
    clearLoadTimers();
    clearTimeout(resizeTimer); clearTimeout(toastTimer); clearTimeout(tooltipTimer);
    progressAnimation?.cancel();
    cancelAnimations();
    abort.abort();
    chrome.runtime.onMessage.removeListener(onMessage);
    // Start cleanup before the host destroys this extension frame.
    request("PEEK_END").catch(() => {});
    host("closed", { reason });
  }
  async function close() {
    if (disposed || phase === "closing" || phase === "expanding") return;
    const live = getComputedStyle(card), transform = live.transform, opacity = live.opacity;
    const dim = getComputedStyle(backdrop).opacity;
    cancelAnimations();
    phase = "closing";
    disarm();
    await Promise.all([
      animate(card, [{ transform }, { transform: sourceTransform(true) }], { duration: 220, easing: "cubic-bezier(.4,0,1,1)" }),
      animate(card, [{ opacity }, { opacity: 0 }], { duration: 180, delay: 40, easing: "linear" }),
      animate(backdrop, [{ opacity: dim }, { opacity: 0 }], { duration: 200 }),
      animate(pill, [{ opacity: getComputedStyle(pill).opacity }, { opacity: 0 }], { duration: 120 }),
      animate(controls, [{ opacity: 1 }, { opacity: 0 }], { duration: 120 })
    ]);
    finish("close");
  }
  async function openTab() {
    if (disposed || phase === "closing" || phase === "expanding") return;
    const url = shareURL();
    const transform = getComputedStyle(card).transform, opacity = getComputedStyle(card).opacity;
    cancelAnimations();
    phase = "expanding";
    disarm();
    const expand = `translate(${innerWidth / 2 - rect.x - rect.width / 2}px, ${innerHeight / 2 - rect.y - rect.height / 2}px) scale(${innerWidth / rect.width}, ${innerHeight / rect.height})`;
    await Promise.all([
      animate(card, [{ transform, opacity, borderRadius: "12px" }, { transform: expand, opacity: 1, borderRadius: "0px" }], { duration: 300, easing: "cubic-bezier(.3,0,0,1)" }),
      animate(pill, [{ opacity: 1 }, { opacity: 0 }], { duration: 120 }),
      animate(controls, [{ opacity: 1 }, { opacity: 0 }], { duration: 120 }),
      animate(backdrop, [{ opacity: mode === "side" ? 0 : 1 }, { opacity: 1 }], { duration: 220 })
    ]);
    if (disposed) return;
    try { await request("PEEK_OPEN_TAB", { url }); finish("tab"); }
    catch (error) {
      phase = "restoring";
      await Promise.all([
        animate(card, [{ transform: expand, borderRadius: "0px" }, { transform: "none", borderRadius: "12px" }], { duration: 240, easing: "cubic-bezier(.2,0,0,1)" }),
        animate(pill, [{ opacity: 0 }, { opacity: 1 }], { duration: 120 }),
        animate(controls, [{ opacity: 0 }, { opacity: 1 }], { duration: 120 }),
        animate(backdrop, [{ opacity: 1 }, { opacity: mode === "side" ? 0 : 1 }], { duration: 160 })
      ]);
      if (phase === "restoring") { settle(); showToast(error.message || "Couldn't open a new tab"); }
    }
  }
  async function toggleSide() {
    if (disposed || phase !== "idle") return;
    phase = "layout";
    disarm();
    await Promise.all([
      animate(card, [{ transform: "none", opacity: 1 }, { transform: "scale(.97)", opacity: 0 }], { duration: 120 }),
      animate(pill, [{ opacity: 1 }, { opacity: 0 }], { duration: 120 }),
      animate(controls, [{ opacity: 1 }, { opacity: 0 }], { duration: 120 })
    ]);
    if (phase !== "layout") return;
    if (mode === "modal") {
      mode = "side";
      sideRegion = false;
      layout();
      await Promise.all([
        animate(card, [{ transform: "translateX(24px)", opacity: 0 }, { transform: "none", opacity: 1 }], { ...spring({ damping: 36 }), duration: 360 }),
        animate(backdrop, [{ opacity: 1 }, { opacity: 0 }], { duration: 200 }),
        animate(pill, [{ opacity: 0 }, { opacity: 1 }], { duration: 160 }),
        animate(controls, [{ opacity: 0 }, { opacity: 1 }], { duration: 160 })
      ]);
      if (phase !== "layout") return;
      awaitingSideResize = true;
      await host("layout", { mode: "side" });
      backdrop.hidden = true;
    } else {
      // Expand the containing region while the card is faded, then compute against the host viewport.
      await host("layout", { mode: "modal" });
      await nextFrame(); await nextFrame();
      if (phase !== "layout") return;
      mode = "modal";
      sideRegion = false;
      awaitingSideResize = false;
      backdrop.hidden = false;
      layout();
      await Promise.all([
        animate(card, [{ transform: "scale(.97)", opacity: 0 }, { transform: "none", opacity: 1 }], { ...spring(), duration: 360 }),
        animate(backdrop, [{ opacity: 0 }, { opacity: 1 }], { duration: 220 }),
        animate(pill, [{ opacity: 0 }, { opacity: 1 }], { duration: 160 }),
        animate(controls, [{ opacity: 0 }, { opacity: 1 }], { duration: 160 })
      ]);
    }
    if (phase === "layout") settle();
  }
  async function switchSession(next) {
    if (!/^[0-9a-f]{32}$/.test(next) || disposed || phase === "closing" || phase === "expanding") return;
    // The host adopts the next token as soon as it sends switch; use it even if the claim fails.
    token = next;
    const version = ++switchVersion;
    try {
      const nextSession = await request("PEEK_SESSION", { token: next });
      if (version !== switchVersion || disposed || phase === "closing" || phase === "expanding") return;
      if (nextSession.tabId !== session.tabId || !utils.peekUrl(nextSession.url) || !utils.peekUrl(nextSession.frameUrl)) throw new Error("Invalid preview session");
      session = nextSession;
      settings = utils.sanitizeSettings(session.settings);
      entries = [{ url: session.frameUrl }]; index = 0;
      currentTitle = "";
      layout();
      disarm();
      const previousPhase = phase;
      phase = "switching";
      startLoading(); updateSite(true); replaceLocation(session.frameUrl);
      await animate(card, [{ opacity: .6 }, { opacity: 1 }], { duration: 180, easing: "ease-out" });
      if (phase === "switching") {
        // An in-flight opening animation can finish harmlessly; the new session keeps the same frame.
        if (previousPhase !== "idle") card.style.transform = "none";
        settle();
      }
    } catch (error) { if (version === switchVersion && !disposed) showToast(error.message || "Couldn't load that preview"); }
  }

  function shortcut(event) {
    const command = mac ? event.metaKey : event.ctrlKey;
    if (event.key === "Escape" && !event.defaultPrevented) return "close";
    if (command && (event.key === "Enter" || event.key.toLowerCase() === "o")) return "open-tab";
    if (command && event.key.toLowerCase() === "r" || event.key === "F5") return "reload";
    if (mac && event.metaKey && event.key === "[" || !mac && event.altKey && event.key === "ArrowLeft") return "back";
    if (mac && event.metaKey && event.key === "]" || !mac && event.altKey && event.key === "ArrowRight") return "forward";
    return null;
  }
  function act(action) {
    if (action === "close") close();
    else if (action === "open-tab") openTab();
    else if (action === "back") traverse(-1);
    else if (action === "forward") traverse(1);
    else if (action === "reload") navigate(currentURL(), false);
  }
  function focusables() {
    return [...dialog.querySelectorAll("button, iframe")].filter(element => {
      const control = /** @type {HTMLButtonElement} */ (element);
      return !control.disabled && control.tabIndex !== -1 && !control.closest("[hidden]") && getComputedStyle(control).visibility !== "hidden";
    });
  }
  function onKey(event) {
    if (!event.isTrusted) return;
    const action = shortcut(event);
    if (action) { event.preventDefault(); act(action); return; }
    if (event.key === "Tab") {
      const available = focusables(), at = available.indexOf(document.activeElement);
      if (available.length && (event.shiftKey && at <= 0 || !event.shiftKey && (at < 0 || at === available.length - 1))) {
        event.preventDefault();
        /** @type {HTMLElement} */ (available[event.shiftKey ? available.length - 1 : 0]).focus();
      }
    }
    if ((event.target === document.body || event.target === card || event.target === root) && [" ", "PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault(); inner?.focus();
    }
  }
  function hideTooltip() { clearTimeout(tooltipTimer); tooltip.hidden = true; }
  function showTooltip(control) {
    if (disposed || phase !== "idle") return;
    tooltip.textContent = control.getAttribute("aria-label");
    tooltip.hidden = false;
    const bounds = control.getBoundingClientRect();
    const tip = tooltip.getBoundingClientRect();
    let x = bounds.right + 8, y = bounds.top + (bounds.height - tip.height) / 2;
    // When the viewport ends in the controls' gutter, put the tooltip in the header, never over the page.
    if (x + tip.width > innerWidth - 8 || mode === "side" || root.dataset.narrow === "true") {
      x = clamp(bounds.right - tip.width, 8, innerWidth - tip.width - 8);
      y = Math.max(2, rect.y - tip.height - 8);
    }
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
  }

  // This listener observes broadcasts only: never respond or return true, which steals worker replies.
  function onMessage(message, sender) {
    if (disposed || !session || sender.id !== chrome.runtime.id || sender.tab?.id !== session.tabId) return;
    if (message?.type === "PEEK_HOST_CMD") {
      if (sender.frameId !== 0 || message.token !== token) return;
      if (message.action === "close") close();
      else if (message.action === "switch") switchSession(message.next);
      else if (message.action === "settings") {
        settings = utils.sanitizeSettings(message.settings);
        progress.hidden = !settings.peekLoadingIndicator;
        disarm(); layout();
        clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => { if (phase === "idle") settle(); }, 150);
      }
      return;
    }
    if (message?.type !== "PEEK_AGENT" || !(sender.frameId > 0)) return;
    const senderURL = utils.peekUrl(sender.url);
    if (!senderURL) return;
    if (message.kind === "hello" && expectingHello && innerFrameId === null) innerFrameId = sender.frameId;
    if (sender.frameId !== innerFrameId) {
      // Nested Peek agents only relay keyboard actions; their URLs can never change the site pill.
      if (message.kind === "key") act(message.action);
      return;
    }
    if (message.kind === "hello") {
      documentId = sender.documentId ?? null;
      expectingHello = false;
      hasHello = true;
      entries[index].url = senderURL.href;
      currentTitle = typeof message.title === "string" ? message.title.slice(0, 512) : "";
      clearTimeout(blockedTimer);
      stateLayer.hidden = true;
      inner.style.visibility = "visible";
      inner.removeAttribute("aria-hidden");
      updateSite(true);
      if (loading) advanceProgress(.8);
      agent(phase === "idle" ? "settled" : "animating");
      if (initialFocus) { initialFocus = false; inner.focus({ preventScroll: true }); }
      return;
    }
    if (!hasHello || documentId && sender.documentId !== documentId) return;
    if (message.kind === "state") {
      currentTitle = typeof message.title === "string" ? message.title.slice(0, 512) : "";
      entries[index].url = senderURL.href;
      updateSite();
    } else if (message.kind === "url") {
      if (message.push === true && currentURL() !== senderURL.href) pushURL(senderURL.href);
      else entries[index].url = senderURL.href;
      updateSite();
    } else if (message.kind === "icon") {
      if (typeof message.dataUrl === "string" && message.dataUrl.length <= 90000 && /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+$/i.test(message.dataUrl)) useIcon(message.dataUrl);
    } else if (message.kind === "navigate") navigate(message.url);
    else if (message.kind === "load") loaded();
    else if (message.kind === "key") act(message.action);
    else if (message.kind === "covered") {
      status.textContent = message.value === true ? "Preview interaction paused while the page is covered" : "Preview interaction resumed";
    }
  }

  async function boot() {
    try {
      session = await request("PEEK_SESSION", { token });
      if (!Number.isInteger(session?.tabId) || !utils.peekUrl(session.url) || !utils.peekUrl(session.frameUrl)) throw new Error("Invalid preview session");
      settings = utils.sanitizeSettings(session.settings);
    } catch {
      if (!session) {
        try { const tab = await chrome.tabs.getCurrent(); if (tab?.id !== undefined) session = { tabId: tab.id }; } catch {}
      }
      host("closed", { reason: "error" });
      return;
    }
    entries = [{ url: session.frameUrl }];
    chrome.runtime.onMessage.addListener(onMessage);
    listen(window, "keydown", onKey);
    listen(window, "resize", () => {
      if (disposed) return;
      if (awaitingSideResize && mode === "side" && innerWidth < fullWidth) { sideRegion = true; awaitingSideResize = false; }
      disarm(); layout();
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => { if (phase === "idle") settle(); }, 150);
    });
    listen(window, "pagehide", () => { if (!disposed) finish("error"); });
    listen(window, "focus", () => {
      // Tab exiting a cross-origin frame returns to this document: keep modal focus in its controls.
      if (mode === "modal" && phase === "idle" && document.activeElement === document.body) site.focus({ preventScroll: true });
    });
    listen(backdrop, "pointerdown", event => { backdropDown = event.target === backdrop && event.button === 0; });
    listen(window, "pointerdown", event => { if (event.target !== backdrop) backdropDown = false; }, { capture: true });
    listen(backdrop, "click", event => { if (backdropDown && event.target === backdrop && settings.peekBackdropClose) close(); backdropDown = false; });
    listen(backdrop, "pointercancel", () => { backdropDown = false; });
    listen(button("close"), "click", close);
    for (const id of ["expand", "slow-open", "blocked-open"]) listen(button(id), "click", openTab);
    listen(split, "click", toggleSide);
    listen(back, "click", () => traverse(-1));
    listen(forward, "click", () => traverse(1));
    listen(site, "click", copyLink);
    listen(icon, "load", () => { if (icon.src === iconURL) { icon.hidden = false; letter.hidden = true; } });
    listen(icon, "error", () => { if (iconURL !== fallbackIcon) useIcon(fallbackIcon); else { icon.hidden = true; letter.hidden = false; } });
    listen(button("unblock"), "click", async () => {
      button("unblock").disabled = true;
      try {
        await request("PEEK_UNBLOCK");
        session.unblock = true;
        // A fresh src assignment is initiated by this page, so the just-added session rule always
        // applies — location.replace on the refused document can outrun or miss it. Session rules
        // also reach the network stack a moment after the worker answers, so retry once shortly
        // after in case the first attempt still saw the site's own headers.
        const target = utils.peekUrl(currentURL());
        if (target && !disposed && phase !== "closing" && phase !== "expanding") {
          entries[index].url = target.href;
          currentTitle = "";
          startLoading();
          updateSite(true);
          inner.src = target.href;
          window.setTimeout(() => { if (!disposed && !hasHello && phase !== "closing" && session.unblock) inner.src = target.href; }, 800);
        }
      }
      catch (error) { showToast(error.message || "Couldn't allow this preview"); }
      finally { button("unblock").disabled = false; }
    });
    for (const control of controls.children) {
      listen(control, "pointerenter", () => { hideTooltip(); tooltipTimer = window.setTimeout(() => showTooltip(control), 300); });
      listen(control, "pointerleave", hideTooltip);
      listen(control, "focus", () => { if (control.matches(":focus-visible")) showTooltip(control); });
      listen(control, "blur", hideTooltip);
    }
    for (const eventName of ["pointerup", "mouseup", "auxclick"]) listen(window, eventName, event => {
      if (!event.isTrusted || ![3, 4].includes(event.button)) return;
      event.preventDefault();
      if (eventName === "pointerup") traverse(event.button === 3 ? -1 : 1);
    }, { capture: true });

    inner = document.createElement("iframe");
    inner.id = "preview-frame";
    inner.name = utils.PEEK_FRAME_NAME;
    inner.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-presentation allow-pointer-lock allow-storage-access-by-user-activation allow-top-navigation-to-custom-protocols");
    inner.allow = "fullscreen; autoplay; encrypted-media; picture-in-picture; clipboard-write; web-share";
    inner.referrerPolicy = "no-referrer";
    inner.title = `Preview of ${utils.displayHost(new URL(session.url))}`;
    // Only the first load sets src. Later navigations replace to keep the host tab's history clean.
    inner.src = session.frameUrl;
    listen(inner, "load", loaded);
    phase = "opening";
    layout();
    startLoading();
    updateSite(true);
    dialog.hidden = false;
    backdrop.hidden = false;
    card.append(inner);
    card.focus({ preventScroll: true });
    openMotion();
    requestAnimationFrame(() => { if (!disposed) host("ready"); });
  }
  boot();
})();
