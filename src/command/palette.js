// The command palette's page-side host: a top-frame overlay holding a closed-shadow iframe that
// loads palette.html with a one-time token from the worker. The page can only ever see an opaque
// host element; all keys and choices happen inside the extension frame.
(() => {
  if (window !== window.top) return;
  if (!chrome.runtime?.id) return;
  globalThis.__keybitPalette?.dispose?.();
  const lifecycle = new AbortController();
  let host = null;
  let frame = null;
  let opening = false;
  // An orphaned copy (extension reloaded while open) frees its overlay rather than trapping the page.
  const watchdog = setInterval(() => { if (!chrome.runtime?.id) dispose(); }, 2500);
  globalThis.__keybitPalette = { dispose };

  function close() {
    host?.remove(); host = null; frame = null; opening = false;
  }
  function dispose() {
    clearInterval(watchdog); close(); lifecycle.abort();
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch { /* Orphaned after an extension reload. */ }
  }

  async function open() {
    if (opening) return;
    if (host) { close(); return; }
    opening = true;
    let response;
    try { response = await chrome.runtime.sendMessage({ type: "PALETTE_OPEN" }); }
    catch { response = null; }
    finally { opening = false; }
    if (!response?.ok || !response.data?.token) return;
    const token = response.data.token;
    host = document.createElement("div");
    host.dataset.keybit = "palette";
    Object.assign(host.style, { all: "initial", position: "fixed", inset: "0", zIndex: "2147483647", display: "block" });
    const shadow = host.attachShadow({ mode: "closed" });
    frame = document.createElement("iframe");
    frame.title = "KeyBit command palette";
    frame.src = chrome.runtime.getURL(`src/command/palette.html#${token}`);
    frame.referrerPolicy = "no-referrer";
    Object.assign(frame.style, { width: "100%", height: "100%", border: "0", background: "transparent", colorScheme: "light dark" });
    shadow.append(frame);
    document.documentElement.append(host);
    frame.focus();
    const frameWindow = frame.contentWindow;
    window.addEventListener("message", event => {
      if (event.source !== frameWindow || event.data?.token !== token) return;
      if (event.data.type === "KEYBIT_PALETTE_CLOSE") close();
    }, { signal: lifecycle.signal });
  }

  function onRuntimeMessage(message) {
    if (message?.event === "keybit-palette") void open();
    if (message?.event === "keybit-palette-close") close();
  }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  window.addEventListener("pagehide", close, { signal: lifecycle.signal });
})();
