// Peek listens before page scripts and follows the composed path through open shadow roots.
// A native click is consumed only when the controller accepts the preview request.
(() => {
  const ns = (globalThis.__keybitPeek = { ...(globalThis.__keybitPeek ?? {}) });
  const LONG_PRESS_MS = 550;
  const MOVE_TOLERANCE = 10;
  ns.link = {
    attach({ signal, enabled, trigger, open }) {
      const utils = ns.utils;
      let pressTimer = null;
      let pressPoint = null;
      let swallowedAnchor = null;
      let swallowTimer = null;
      let modifierClick = null;
      const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; pressPoint = null; };
      const urlFor = anchor => anchor && utils.anchorUrl(anchor, document.baseURI, location.href);
      const consume = event => { event.preventDefault(); event.stopImmediatePropagation(); };

      window.addEventListener("click", event => {
        if (!event.isTrusted) return;
        const path = event.composedPath();
        const anchor = utils.anchorFromPath(path);
        if (swallowedAnchor) {
          const consumed = anchor === swallowedAnchor;
          swallowedAnchor = null;
          if (consumed) { consume(event); return; }
        }
        modifierClick = null;
        if (event.defaultPrevented || !enabled()) return;
        const configured = trigger();
        if (!utils.matchesTrigger(configured, event)) return;
        const url = urlFor(anchor);
        if (!url) {
          // Page-controlled buttons sometimes navigate without an anchor. Only an explicit
          // modifier gesture may catch that navigation; ambient clicks never catch redirects.
          if (["shift-click", "alt-click", "ctrl-shift-click"].includes(configured)) {
            modifierClick = { time: performance.now(), trigger: configured };
          }
          return;
        }
        if (configured === "click" && (utils.isControlLink(anchor, path) || !utils.isOutbound(url, location.href))) return;
        if (open(url, anchor)) consume(event);
      }, { capture: true, signal });

      const navigation = /** @type {any} */ (window).navigation;
      navigation?.addEventListener("navigate", event => {
        const intent = modifierClick;
        modifierClick = null;
        if (!intent || performance.now() - intent.time > 1000 || !enabled() || trigger() !== intent.trigger ||
            event.defaultPrevented || !event.cancelable || event.destination.sameDocument || event.hashChange ||
            event.formData || event.downloadRequest != null || !["push", "replace"].includes(event.navigationType)) return;
        const url = utils.peekUrl(event.destination.url);
        if (url && open(utils.destinationUrl(url), null)) event.preventDefault();
      }, { signal });

      window.addEventListener("pointerdown", event => {
        cancelPress();
        if (!event.isTrusted || event.defaultPrevented || !enabled() || trigger() !== "long-press" ||
            !utils.matchesTrigger("click", event)) return;
        const path = event.composedPath();
        const anchor = utils.anchorFromPath(path);
        const url = urlFor(anchor);
        if (!url || utils.isControlLink(anchor, path)) return;
        pressPoint = { x: event.clientX, y: event.clientY };
        pressTimer = setTimeout(() => {
          pressTimer = null;
          if (!enabled() || trigger() !== "long-press" || !anchor.isConnected || !open(url, anchor)) return;
          swallowedAnchor = anchor;
          clearTimeout(swallowTimer);
          swallowTimer = setTimeout(() => { swallowedAnchor = null; }, 800);
        }, LONG_PRESS_MS);
      }, { capture: true, signal });
      for (const name of ["pointerup", "pointercancel", "dragstart", "blur"]) {
        window.addEventListener(name, cancelPress, { capture: true, signal });
      }
      window.addEventListener("pointermove", event => {
        if (pressPoint && Math.hypot(event.clientX - pressPoint.x, event.clientY - pressPoint.y) > MOVE_TOLERANCE) cancelPress();
      }, { capture: true, passive: true, signal });
      signal.addEventListener("abort", () => {
        cancelPress();
        clearTimeout(swallowTimer);
        swallowedAnchor = null;
        modifierClick = null;
      }, { once: true });
    }
  };
})();
