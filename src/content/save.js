(() => {
  if (window !== window.top) return;
  // Re-injection after an install/update replaces the previous instance instead of stacking listeners.
  globalThis.__keybitSave?.dispose();
  const lifecycle = new AbortController();
  globalThis.__keybitSave = { dispose: () => {
    close(); lifecycle.abort();
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch { /* Orphaned after an extension reload. */ }
  } };
  let host = null;
  let token = null;
  let events = null;
  let enabled = false;
  let generation = 0;
  function close() { generation++; events?.abort(); events = null; host?.remove(); host = null; token = null; }
  async function show() {
    const current = ++generation;
    let response;
    try { response = await chrome.runtime.sendMessage({ type: "SAVE_PROMPT_OPEN" }); } catch { return; }
    if (current !== generation || !response?.ok) return;
    enabled = response.data?.enabled === true;
    if (!response.data?.available) { close(); return; }
    if (host && token === response.data.token) return;
    close(); token = response.data.token;
    const currentToken = token;
    host = document.createElement("div");
    Object.assign(host.style, { all: "initial", position: "fixed", display: "block", zIndex: "2147483647", top: "12px", right: "12px",
      width: "min(360px, calc(100vw - 24px))", height: "260px", maxHeight: "calc(100vh - 24px)" });
    const shadow = host.attachShadow({ mode: "closed" });
    const frame = document.createElement("iframe");
    frame.title = "Save login to KeyBit";
    frame.src = chrome.runtime.getURL(`src/inline/save.html#${token}`);
    frame.referrerPolicy = "no-referrer";
    Object.assign(frame.style, { width: "100%", height: "100%", border: "0", borderRadius: "12px", boxShadow: "0 12px 32px #0000002e, 0 2px 6px #0000001a", colorScheme: "light dark" });
    shadow.append(frame); document.documentElement.append(host);
    const frameWindow = frame.contentWindow;
    events = new AbortController();
    window.addEventListener("message", event => {
      if (event.source !== frameWindow || event.data?.token !== currentToken) return;
      if (event.data?.type === "KEYBIT_SAVE_CLOSE") close();
      if (event.data?.type === "KEYBIT_SAVE_RESIZE" && Number.isFinite(event.data.height) && host) {
        host.style.height = `${Math.max(160, Math.min(480, event.data.height))}px`;
      }
    }, { signal: events.signal });
  }
  document.addEventListener("submit", event => {
    if (!enabled || !event.isTrusted || !(event.target instanceof HTMLFormElement)) return;
    const form = event.target;
    const action = event.submitter?.hasAttribute("formaction") ? event.submitter.formAction : form.action;
    try { if (new URL(action, location.href).origin !== location.origin) return; } catch { return; }
    if (form.method === "dialog" || !["", "_self", "_top"].includes(event.submitter?.getAttribute("formtarget") ?? form.target)) return;
    const created = globalThis.__keybit.findNew().filter(candidate => candidate.fields[0].form === form);
    const logins = globalThis.__keybit.find().filter(candidate => candidate.password.form === form);
    let capture;
    if (created.length === 1) {
      // Sign-up or password change: the new password, only when its confirmation matches.
      const { fields, current, username } = created[0];
      if (fields.length === 2 && fields[0].value !== fields[1].value) return;
      capture = { kind: current ? "change" : "signup", username: username?.value ?? "", password: fields[0].value };
    } else if (logins.length === 1 && !created.length) {
      capture = { kind: "login", username: logins[0].username?.value ?? "", password: logins[0].password.value };
    } else return;
    if (!capture.password || capture.password.length > 4096 || capture.username.length > 1024) return;
    // Read only at submission. Do not intercept, delay, or resubmit the site's form.
    try {
      void chrome.runtime.sendMessage({ type: "CAPTURE_LOGIN", ...capture })
        .then(response => { if (response?.ok && response.data?.available) void show(); else close(); }).catch(() => {});
    } catch { /* Orphaned after an extension reload. */ }
  }, { capture: true, signal: lifecycle.signal });
  // The worker retains pending submissions through same-origin redirects only in memory.
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void show(), { once: true, signal: lifecycle.signal });
  else void show();
  window.addEventListener("pageshow", event => { if (event.persisted) void show(); }, { signal: lifecycle.signal });
  window.addEventListener("pagehide", close, { signal: lifecycle.signal });
  function onRuntimeMessage(message) { if (message?.event === "keybit-site-disabled") { enabled = false; close(); } }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
})();
