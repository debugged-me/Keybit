// Peek: turns the configured trigger into a Peek request. Site navigation, middle/right clicks,
// Cmd/Ctrl+Click, downloads, non-http(s) and hash-only links are all left alone — preventDefault
// is called only when Peek will actually open.
(() => {
  const ns = (globalThis.__keybitPeek = { ...(globalThis.__keybitPeek ?? {}) });
  const LONG_PRESS_MS = 550;
  const MOVE_TOLERANCE = 10;
  // signal: teardown via the controller lifecycle; enabled/trigger: read the cached settings live;
  // open(url, anchor): the controller's entry point.
  ns.link = {
    attach({ signal, enabled, trigger, open }) {
      const utils = ns.utils;
      let pressTimer = null;
      let pressPoint = null;
      let swallowedAnchor = null;
      let swallowTimer = null;

      const pathTarget = event => event.composedPath()[0] ?? event.target;
      // Plain clicks are ambient, so they get the stricter UI-chrome filter; modifier clicks are
      // explicit intent and Peek any eligible link.
      const anchorFor = (event, configured) =>
        (configured === "click" ? utils.clickPeekAnchor(pathTarget(event)) : utils.findAnchor(pathTarget(event)));
      const urlFor = anchor => anchor && utils.anchorUrl(anchor, document.baseURI, location.href);
      const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; pressPoint = null; };

      document.addEventListener("click", event => {
        // A long press that fired still produces a click; consume it so the link doesn't navigate.
        if (swallowedAnchor) {
          const consumed = utils.findAnchor(pathTarget(event)) === swallowedAnchor;
          swallowedAnchor = null;
          if (consumed) { event.preventDefault(); event.stopImmediatePropagation(); return; }
        }
        if (!event.isTrusted || event.defaultPrevented || !enabled()) return;
        const configured = trigger();
        if (configured === "long-press" || !utils.matchesTrigger(configured, event)) return;
        const anchor = anchorFor(event, configured);
        const url = urlFor(anchor);
        if (!url) return;
        if (configured === "click" && !utils.isOutbound(url, location.href)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        open(url, anchor);
      }, { capture: true, signal });

      document.addEventListener("pointerdown", event => {
        cancelPress();
        if (!event.isTrusted || !enabled() || trigger() !== "long-press" || !utils.matchesTrigger("click", event)) return;
        const anchor = anchorFor(event, "click");
        const url = urlFor(anchor);
        if (!url) return;
        pressPoint = { x: event.clientX, y: event.clientY };
        pressTimer = setTimeout(() => {
          pressTimer = null;
          if (!enabled() || trigger() !== "long-press" || !anchor.isConnected) return;
          swallowedAnchor = anchor;
          clearTimeout(swallowTimer);
          swallowTimer = setTimeout(() => { swallowedAnchor = null; }, 800);
          open(url, anchor);
        }, LONG_PRESS_MS);
      }, { capture: true, signal });
      document.addEventListener("pointerup", cancelPress, { capture: true, signal });
      document.addEventListener("pointercancel", cancelPress, { capture: true, signal });
      document.addEventListener("dragstart", cancelPress, { capture: true, signal });
      document.addEventListener("pointermove", event => {
        if (pressPoint && Math.hypot(event.clientX - pressPoint.x, event.clientY - pressPoint.y) > MOVE_TOLERANCE) cancelPress();
      }, { capture: true, passive: true, signal });
      signal.addEventListener("abort", () => { cancelPress(); clearTimeout(swallowTimer); swallowedAnchor = null; }, { once: true });
    }
  };
})();
