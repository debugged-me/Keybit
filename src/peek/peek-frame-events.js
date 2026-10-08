// Runs in frames only. No vault modules, runtime messages, storage, or page contents are used.
// A preview pairs with its direct parent to report readiness and let Escape close the overlay
// even while keyboard focus is inside a cross-origin document.
(() => {
  if (window === window.top) return;
  let token = null;
  let parentOrigin = null;
  const reply = type => window.parent.postMessage({ type, token }, parentOrigin);
  window.addEventListener("message", event => {
    if (event.source !== window.parent || event.data?.type !== "KEYBIT_PEEK_PROBE" ||
        typeof event.data.token !== "string" || !/^[a-f0-9]{32}$/.test(event.data.token) ||
        !/^https?:\/\//.test(event.origin)) return;
    token = event.data.token;
    parentOrigin = event.origin;
    reply("KEYBIT_PEEK_READY");
  });
  document.addEventListener("keydown", event => {
    if (!token || !event.isTrusted || event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    reply("KEYBIT_PEEK_ESCAPE");
  }, { capture: true });
})();
