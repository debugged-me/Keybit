// Peek's isolated-world frame agent. It reads only page metadata and link destinations;
// all communication stays within the extension, and none of it involves the vault.
(() => {
  if (window === window.top || !chrome.runtime?.id) return;
  globalThis.__keybitPeekFrame?.dispose?.();
  const utils = globalThis.__keybitPeek?.utils;
  if (!utils) return;
  const lifecycle = new AbortController();
  const { signal } = lifecycle;
  const observers = [];
  const timers = new Set();
  const EXT = new URL(chrome.runtime.getURL("")).origin;
  const appUrl = chrome.runtime.getURL("src/peek/peek.html");
  const ancestors = Array.from(location.ancestorOrigins ?? []);
  const depth = ancestors.indexOf(EXT);
  const navigation = /** @type {any} */ (window).navigation;
  let messageListener = null;
  const dispose = () => {
    lifecycle.abort();
    observers.forEach(observer => observer.disconnect());
    timers.forEach(timer => clearTimeout(timer));
    try { if (messageListener) chrome.runtime?.onMessage?.removeListener(messageListener); } catch {}
  };
  globalThis.__keybitPeekFrame = { dispose };
  function later(callback, delay) {
    const timer = setTimeout(() => { timers.delete(timer); if (!signal.aborted) callback(); }, delay);
    timers.add(timer);
    return timer;
  }
  function send(message) {
    if (signal.aborted) return;
    try {
      if (!chrome.runtime?.id) { dispose(); return; }
      // These messages are broadcasts to the Peek page, which must not claim SW replies.
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch { dispose(); }
  }
  const agent = (kind, data = {}) => send({ type: "PEEK_AGENT", kind, ...data });

  // Ordinary embedded pages load settings only after a real link interaction. The first
  // click remains native when its settings have not arrived yet.
  if (depth < 0) {
    let settings = null;
    let loading = false;
    let revision = 0;
    const loadSettings = () => {
      if (loading || signal.aborted) return;
      loading = true;
      const requestedRevision = revision;
      try {
        chrome.runtime.sendMessage({ type: "PEEK_GET_SETTINGS" }).then(response => {
          if (signal.aborted || requestedRevision !== revision || !response?.ok) return;
          settings = { ...utils.sanitizeSettings(response.data), siteAllowed: response.data?.siteAllowed !== false };
        }).catch(() => {}).finally(() => {
          loading = false;
          if (requestedRevision !== revision) loadSettings();
        });
      } catch { loading = false; dispose(); }
    };
    messageListener = (message, sender) => {
      if (sender.id !== chrome.runtime.id) return;
      if (message?.event === "keybit-peek-settings") {
        revision++;
        if (settings) settings = { ...utils.sanitizeSettings(message.settings), siteAllowed: settings.siteAllowed };
        loadSettings();
      } else if (message?.event === "keybit-peek-site") {
        revision++;
        settings = null;
        loadSettings();
      }
    };
    chrome.runtime.onMessage.addListener(messageListener);
    window.addEventListener("pointerdown", event => {
      if (!event.isTrusted || settings || !utils.anchorFromPath(event.composedPath())) return;
      loadSettings();
    }, { capture: true, signal });
    window.addEventListener("click", event => {
      if (!event.isTrusted || event.defaultPrevented || !settings?.peekEnabled || !settings.siteAllowed ||
          !utils.matchesTrigger(settings.peekTrigger, event)) return;
      const path = event.composedPath();
      const anchor = utils.anchorFromPath(path);
      const url = anchor && utils.anchorUrl(anchor, document.baseURI, location.href);
      if (!url) return;
      if (settings.peekTrigger === "click" &&
          (utils.isControlLink(anchor, path) || !utils.isOutbound(url, ancestors.at(-1)))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      send({ type: "PEEK_FRAME_OPEN", url: url.href });
    }, { capture: true, signal });
    return;
  }

  let covered = false;
  let armed = false;
  let visibilityObserver = null;
  let visibilityRoot = null;
  const setCovered = value => {
    if (covered === value) return;
    covered = value;
    agent("covered", { value });
  };

  if (depth === 0) {
    // Install before page listeners. A cover must not be able to turn visible decoy controls
    // into clicks or keystrokes on the real preview underneath it.
    const gate = event => {
      if (!covered) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu",
      "touchstart", "touchend", "keydown", "keypress", "keyup", "dragstart", "drop"]) {
      window.addEventListener(type, gate, { capture: true, passive: false, signal });
    }
    const rootHasEffects = root => {
      const style = getComputedStyle(root);
      return Number(style.opacity) < 1 || style.filter !== "none" || style.transform !== "none" ||
        style.clipPath !== "none" || style.mixBlendMode !== "normal";
    };
    try {
      visibilityObserver = new IntersectionObserver(entries => {
        if (!armed || signal.aborted) return;
        for (const entry of entries) {
          if (entry.target !== visibilityRoot) continue;
          const visible = /** @type {any} */ (entry).isVisible;
          if (visible === true) setCovered(false);
          else if (visible === false) setCovered(!rootHasEffects(visibilityRoot));
        }
      }, /** @type {any} */ ({ trackVisibility: true, delay: 100, threshold: [0] }));
      observers.push(visibilityObserver);
    } catch { /* IOv2 is unavailable in older browsers; ordinary previews still work. */ }
    messageListener = (message, sender) => {
      if (sender.id !== chrome.runtime.id || typeof sender.url !== "string" ||
          sender.url.split(/[?#]/, 1)[0] !== appUrl || message?.event !== "keybit-peek-agent") return;
      if (message.action === "animating") {
        armed = false;
        setCovered(false);
      } else if (message.action === "settled") {
        armed = true;
        setCovered(false);
        if (visibilityRoot && visibilityObserver) {
          visibilityObserver.takeRecords();
          visibilityObserver.unobserve(visibilityRoot);
          visibilityObserver.observe(visibilityRoot);
        }
      }
      // Do not send a response or claim messages belonging to another extension context.
    };
    chrome.runtime.onMessage.addListener(messageListener);
  }

  const mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  const keyAction = event => {
    const key = event.key.toLowerCase();
    if (!event.shiftKey && ((mac && event.metaKey && !event.ctrlKey && !event.altKey) ||
        (!mac && event.altKey && !event.ctrlKey && !event.metaKey))) {
      if (key === (mac ? "[" : "arrowleft")) return "back";
      if (key === (mac ? "]" : "arrowright")) return "forward";
    }
    if (depth > 0) return null;
    const command = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (command && !event.altKey && !event.shiftKey && (key === "enter" || key === "o")) return "open-tab";
    if (key === "f5" || (command && !event.altKey && key === "r")) return "reload";
    return null;
  };
  window.addEventListener("keydown", event => {
    if (!event.isTrusted) return;
    const action = keyAction(event);
    if (!action) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    agent("key", { action });
  }, { capture: true, signal });
  // Bubble gives a page's own dialog a chance to consume Escape first.
  window.addEventListener("keydown", event => {
    if (!event.isTrusted || event.defaultPrevented || event.key !== "Escape") return;
    event.preventDefault();
    agent("key", { action: "close" });
  }, { signal });
  let pointerBack = null;
  for (const type of ["pointerup", "mouseup"]) {
    window.addEventListener(type, rawEvent => {
      const event = /** @type {MouseEvent} */ (rawEvent);
      if (!event.isTrusted || (event.button !== 3 && event.button !== 4)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (type === "mouseup" && pointerBack?.button === event.button && event.timeStamp - pointerBack.time < 500) return;
      if (type === "pointerup") pointerBack = { button: event.button, time: event.timeStamp };
      agent("key", { action: event.button === 3 ? "back" : "forward" });
    }, { capture: true, signal });
  }

  let pending = null;
  if (navigation) navigation.addEventListener("navigate", event => {
    if (event.destination.sameDocument || event.hashChange || event.formData || event.downloadRequest != null ||
        !event.cancelable || event.navigationType === "traverse") return;
    const url = utils.peekUrl(event.destination.url);
    if (!url) return;
    if (pending === url.href) { pending = null; return; }
    if (depth > 0 && event.navigationType !== "push") return;
    event.preventDefault();
    pending = url.href;
    if (depth === 0) agent("navigate", { url: url.href });
    else {
      try {
        const result = navigation.navigate(url.href, { history: "replace" });
        result.committed.catch(() => {});
        result.finished.catch(() => {});
      } catch { pending = null; }
    }
  }, { signal });
  if (depth > 0) return;

  window.addEventListener("click", event => {
    if (!event.isTrusted || event.defaultPrevented || !utils.matchesTrigger("click", event)) return;
    const anchor = utils.anchorFromPath(event.composedPath());
    const target = anchor?.getAttribute("target")?.toLowerCase();
    if (target !== "_top" && target !== "_parent") return;
    const url = utils.anchorUrl(anchor, document.baseURI, location.href);
    if (!url) return;
    event.preventDefault();
    pending = url.href;
    agent("navigate", { url: url.href });
  }, { signal });

  let pushed = false;
  let lastUrl = location.href;
  document.addEventListener("keybit-peek-push", () => {
    pushed = true;
    // A rejected pushState must not mark a later unrelated navigation as a pushed entry.
    later(() => { pushed = false; }, 0);
  }, { capture: true, signal });
  const reportUrl = () => {
    if (lastUrl === location.href && !pushed) return;
    lastUrl = location.href;
    agent("url", { push: pushed });
    pushed = false;
  };
  if (navigation) {
    navigation.addEventListener("currententrychange", reportUrl, { signal });
    navigation.addEventListener("navigatesuccess", reportUrl, { signal });
  }
  window.addEventListener("hashchange", reportUrl, { signal });
  window.addEventListener("popstate", reportUrl, { signal });

  let stateTimer = null;
  const state = () => {
    stateTimer = null;
    const themeColor = document.querySelector('meta[name="theme-color"]')?.getAttribute("content");
    agent("state", { title: document.title.slice(0, 1024), ...(themeColor ? { themeColor: themeColor.slice(0, 128) } : {}) });
  };
  const scheduleState = () => { if (stateTimer === null) stateTimer = later(state, 150); };
  const metadataObserver = new MutationObserver(scheduleState);
  observers.push(metadataObserver);
  let watchedHead = null;
  const observeDocument = () => {
    if (document.documentElement && visibilityRoot !== document.documentElement) {
      if (visibilityRoot) visibilityObserver?.unobserve(visibilityRoot);
      visibilityRoot = document.documentElement;
      visibilityObserver?.observe(visibilityRoot);
    }
    if (document.head && watchedHead !== document.head) {
      watchedHead = document.head;
      metadataObserver.disconnect();
      metadataObserver.observe(watchedHead, { subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ["name", "content"] });
    }
    return !!(document.documentElement && document.head);
  };
  if (!observeDocument()) {
    const readyObserver = new MutationObserver(() => { if (observeDocument()) readyObserver.disconnect(); });
    observers.push(readyObserver);
    readyObserver.observe(document, { childList: true, subtree: true });
  }

  async function favicon() {
    const MAX_ICON_BYTES = 64 * 1024;
    const icons = Array.from(document.querySelectorAll('link[rel~="icon"]'));
    const score = icon => /svg/i.test(icon.getAttribute("type") ?? "") || /\.svg(?:[?#]|$)/i.test(icon.getAttribute("href") ?? "")
      ? 2 : (icon.getAttribute("sizes") ?? "").split(/\s+/).some(size => size === "any" || Number(size.split("x")[0]) >= 32) ? 1 : 0;
    icons.sort((a, b) => score(b) - score(a));
    const url = utils.peekUrl(icons[0]?.getAttribute("href") ?? "/favicon.ico", document.baseURI);
    if (!url || url.origin !== location.origin) return;
    const request = new AbortController();
    const cancel = () => request.abort();
    signal.addEventListener("abort", cancel, { once: true });
    const timeout = later(cancel, 2000);
    try {
      // Do not let a favicon redirect turn this metadata request into a cross-origin fetch.
      const response = await fetch(url.href, { credentials: "omit", redirect: "error", signal: request.signal });
      const type = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (!response.ok || !type?.startsWith("image/") || Number(response.headers.get("content-length")) > MAX_ICON_BYTES) return;
      const reader = response.body?.getReader();
      if (!reader) return;
      const chunks = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_ICON_BYTES) { await reader.cancel(); return; }
        chunks.push(value);
      }
      if (!bytes || signal.aborted) return;
      const file = new FileReader();
      file.addEventListener("load", () => {
        if (typeof file.result === "string") agent("icon", { dataUrl: file.result });
      }, { once: true });
      file.readAsDataURL(new Blob(chunks, { type }));
    } catch { /* Missing, protected, and cross-origin icons use the Peek page's fallback. */ }
    finally {
      request.abort();
      clearTimeout(timeout);
      timers.delete(timeout);
      signal.removeEventListener("abort", cancel);
    }
  }
  const ready = () => { observeDocument(); state(); void favicon(); };
  agent("hello", { title: document.title.slice(0, 1024) });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true, signal });
  else ready();
  if (document.readyState === "complete") agent("load");
  else window.addEventListener("load", () => agent("load"), { once: true, signal });
})();
