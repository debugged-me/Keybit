// Isolated-world relay for the MAIN-world passkey interceptor (passkey-page.js). It carries the
// ceremony to the background worker and hosts the prompt card as a trusted extension frame.
(() => {
  if (window !== window.top) return;
  // A copy injected before an extension reload/update has no runtime — retire quietly.
  if (!chrome.runtime?.id) return;
  globalThis.__keybitPasskey?.dispose();
  const lifecycle = new AbortController();
  globalThis.__keybitPasskey = { dispose: () => {
    close();
    lifecycle.abort();
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch { /* Orphaned after an extension reload. */ }
  } };
  let host = null;
  let events = null;
  let current = null; // { id, token }
  function close() { events?.abort(); events = null; host?.remove(); host = null; current = null; }
  function answer(id, result) {
    window.postMessage({ __keybit: "passkey-result", id, ...result }, location.origin);
  }
  function show(id, token) {
    close();
    current = { id, token };
    host = document.createElement("div");
    Object.assign(host.style, { all: "initial", position: "fixed", display: "block", zIndex: "2147483647", top: "12px", right: "12px",
      width: "min(360px, calc(100vw - 24px))", height: "240px", maxHeight: "calc(100vh - 24px)" });
    const shadow = host.attachShadow({ mode: "closed" });
    const frame = document.createElement("iframe");
    frame.title = "KeyBit passkey prompt";
    frame.src = chrome.runtime.getURL(`src/inline/passkey.html#${token}`);
    frame.referrerPolicy = "no-referrer";
    Object.assign(frame.style, { width: "100%", height: "100%", border: "0", borderRadius: "12px", boxShadow: "0 12px 32px #0000002e, 0 2px 6px #0000001a", colorScheme: "light dark" });
    shadow.append(frame); document.documentElement.append(host);
    const frameWindow = frame.contentWindow;
    events = new AbortController();
    window.addEventListener("message", event => {
      if (event.source !== frameWindow || event.data?.token !== current?.token) return;
      if (event.data.type === "KEYBIT_PASSKEY_CLOSE") close();
      if (event.data.type === "KEYBIT_PASSKEY_RESIZE" && Number.isFinite(event.data.height) && host) {
        host.style.height = `${Math.max(160, Math.min(480, event.data.height))}px`;
      }
    }, { signal: events.signal });
  }
  window.addEventListener("message", async event => {
    if (event.source !== window || event.data?.__keybit !== "passkey-request") return;
    const { id, kind, options } = event.data;
    let response = null;
    try { response = await chrome.runtime.sendMessage({ type: kind === "create" ? "PASSKEY_CREATE" : "PASSKEY_GET", options }); } catch { /* Extension reloaded mid-call. */ }
    const data = response?.ok ? response.data : null;
    if (data?.token) { show(id, data.token); return; }
    answer(id, { action: data?.action === "cancel" ? "cancel" : "delegate" });
  }, { signal: lifecycle.signal });
  function onRuntimeMessage(message) {
    if (message?.event === "keybit-site-disabled") close();
    if (message?.event !== "keybit-passkey-result") return;
    const open = current && current.token === message.token ? current : null;
    if (!open) return;
    close();
    answer(open.id, message.result ?? { action: "delegate" });
  }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  window.addEventListener("pagehide", () => close(), { signal: lifecycle.signal });
})();
