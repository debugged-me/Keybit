// Peek: the preview iframe. Created only on user activation, removed on close. The frame is a
// normal cross-origin web page — no CSP/X-Frame-Options tricks, no reading its contents, and no
// password-manager data is ever sent into it.
(() => {
  const ns = (globalThis.__keybitPeek = { ...(globalThis.__keybitPeek ?? {}) });
  const SLOW_MS = 10000;
  // iframe load also fires for blocked embeds. A tiny, separate frame script acknowledges real
  // documents without inspecting their contents. Unconfirmed loads keep the frame visible
  // (including browser PDF viewers) with a helpful notice; they never open a tab/window.
  ns.frame = {
    create(url, events) {
      const lifecycle = new AbortController();
      // getRandomValues also works on ordinary HTTP pages, where randomUUID may be unavailable.
      const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
      const preview = ns.utils.frameUrl(url);
      const frame = document.createElement("iframe");
      frame.className = "kb-peek-frame";
      frame.title = `Preview of ${ns.utils.displayHost(url)}`;
      frame.referrerPolicy = "strict-origin-when-cross-origin";
      // Let the preview work normally, but prevent it from navigating the underlying page.
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox");
      let confirmationTimer = null;
      let blocked = false;
      const timer = setTimeout(() => events.onSlow(), SLOW_MS);
      frame.addEventListener("load", () => {
        clearTimeout(timer);
        clearTimeout(confirmationTimer);
        if (blocked) return;
        events.onLoad();
        confirmationTimer = setTimeout(() => events.onUnconfirmed(), 1800);
        // No content or credentials are sent: this token only pairs readiness/Escape messages.
        frame.contentWindow?.postMessage({ type: "KEYBIT_PEEK_PROBE", token }, "*");
      }, { signal: lifecycle.signal });
      window.addEventListener("message", event => {
        if (event.source !== frame.contentWindow || event.data?.token !== token || blocked) return;
        if (event.data.type === "KEYBIT_PEEK_READY") {
          clearTimeout(timer); clearTimeout(confirmationTimer); events.onLoad();
        }
        if (event.data.type === "KEYBIT_PEEK_ESCAPE") events.onClose();
      }, { signal: lifecycle.signal });
      document.addEventListener("securitypolicyviolation", event => {
        if (event.disposition !== "enforce" || !["frame-src", "child-src"].includes(event.effectiveDirective)) return;
        if (![preview.href, preview.origin].includes(event.blockedURI)) return;
        blocked = true;
        clearTimeout(timer); clearTimeout(confirmationTimer); events.onError();
      }, { signal: lifecycle.signal });
      frame.src = preview.href;
      return {
        element: frame,
        dispose() { lifecycle.abort(); clearTimeout(timer); clearTimeout(confirmationTimer); frame.remove(); }
      };
    }
  };
})();
