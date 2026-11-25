// PeekBit — Shift+Click a link to preview it in a floating card.
(() => {
  "use strict";

  // Guard against double injection (install-time scripting.executeScript + manifest).
  if (globalThis.__peekbitActive) return;
  globalThis.__peekbitActive = true;

  // Chrome supports both callback and Promise forms of runtime.sendMessage,
  // but the return value differs across Chromium builds. Resolve whichever
  // form answers first so a valid callback response is never mistaken for an
  // unavailable background worker.
  function runtimeMessage(message) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value || { ok: false });
      };
      try {
        const possiblePromise = chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError;
          finish(error ? { ok: false, error: error.message } : response);
        });
        if (possiblePromise && typeof possiblePromise.then === "function") {
          possiblePromise.then(finish).catch((error) => finish({ ok: false, error: error && error.message }));
        }
      } catch (error) {
        finish({ ok: false, error: error && error.message });
      }
      setTimeout(() => finish({ ok: false, error: "message-timeout" }), 3000);
    });
  }

  // Every frame gets this script so the active Peek frame can prepare a
  // destination-scoped DNR rule before an ordinary cross-site link navigates.
  // Inactive page iframes only perform the status check and otherwise stay inert.
  if (window.top !== window) {
    initFrameBridge();
    return;
  }

  function initFrameBridge() {
    let owned = false;

    runtimeMessage({ type: "peek:frame-status", url: location.href }).then((result) => {
      owned = Boolean(result && result.owned);
    });
    chrome.runtime.onMessage.addListener((message) => {
      if (message && message.type === "peek:frame-owned") owned = true;
    });

    window.addEventListener("click", (event) => {
      if (!owned || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
      const anchor = path.find((node) => node instanceof Element && typeof node.matches === "function" && node.matches("a[href]"));
      if (!anchor || anchor.hasAttribute("download")) return;
      const target = (anchor.getAttribute("target") || "").toLowerCase();
      if (target && target !== "_self") return;
      let destination;
      try {
        destination = new URL(anchor.href);
        if (!/^https?:$/.test(destination.protocol) || destination.origin === location.origin) return;
      } catch {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      runtimeMessage({ type: "peek:prepare-navigation", url: destination.href }).then((result) => {
        if (result && result.owned && result.previewable === false) return;
        // If the frame lost ownership while the message was in flight, preserve
        // the link's normal behavior instead of swallowing the click.
        location.assign(destination.href);
      });
    }, true);
  }

  const LOAD_TIMEOUT_MS = 12000;
  const CLOSE_ANIM_MS = 190;
  const MIN_W = 340;
  const MIN_H = 240;
  const SANDBOX =
    "allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";

  const ICON = {
    back:
      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m12.5 4.5-5.5 5.5 5.5 5.5"/></svg>',
    forward:
      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m7.5 4.5 5.5 5.5-5.5 5.5"/></svg>',
    reload:
      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><path d="M15.7 7.3A6.2 6.2 0 1 0 16 12"/><path d="M15.8 3.8v3.8H12"/></svg>',
    tab:
      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="13" height="13" rx="2.2"/><path d="M10 2h8v8M18 2l-8.5 8.5"/></svg>',
    split:
      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3" width="15" height="14" rx="2.5"/><path d="M10 3v14"/></svg>',
    copy:
      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="11" height="11" rx="2"/><path d="M6 6V4a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-1"/></svg>',
    check:
      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m4 10.5 4 4 8-9"/></svg>',
    x:
      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m5 5 10 10M15 5 5 15"/></svg>'
  };

  const CSS = `
:host{all:initial}
*{box-sizing:border-box;margin:0;padding:0}
.backdrop{position:fixed;inset:0;background:rgba(0,0,0,.18);font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;animation:pb-fade .22s cubic-bezier(.32,.72,0,1)}
.backdrop.closing{animation:pb-fadeout .18s ease-in forwards}
.stage{position:absolute;display:flex;align-items:flex-start;gap:12px;animation:pb-in .3s cubic-bezier(.32,.72,0,1);filter:drop-shadow(0 18px 32px rgba(0,0,0,.22))}
.stage.closing{animation:pb-out .16s ease-in forwards}
.card{position:relative;flex:1 1 auto;min-width:0;height:100%;background:#fff;border-radius:10px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 0 0 1px rgba(23,23,23,.08),0 8px 24px rgba(0,0,0,.14)}
@keyframes pb-fade{from{opacity:0}}
@keyframes pb-fadeout{to{opacity:0}}
.chrome{position:relative;z-index:4;flex:0 0 44px;height:44px;display:flex;align-items:center;gap:5px;padding:5px 8px;background:rgba(247,247,246,.96);border-bottom:1px solid rgba(23,23,23,.07);transition:opacity .16s ease,transform .16s ease}
.nav,.address{background:rgba(255,255,255,.74);border:1px solid rgba(23,23,23,.08);box-shadow:0 1px 4px rgba(0,0,0,.06);backdrop-filter:blur(18px) saturate(1.25);-webkit-backdrop-filter:blur(18px) saturate(1.25)}
.nav{height:34px;padding:2px;display:flex;align-items:center;border-radius:9px}
.address{height:34px;min-width:0;max-width:430px;display:flex;align-items:center;gap:8px;padding:0 11px;border-radius:9px;cursor:grab;user-select:none;-webkit-user-select:none}
.address[hidden]{display:none}
.site-dot{width:8px;height:8px;border-radius:50%;background:#30a46c;box-shadow:0 0 0 3px rgba(48,164,108,.12);flex:none}
.site-dot.loading{animation:pb-pulse 1s ease-in-out infinite}
@keyframes pb-pulse{50%{opacity:.38}}
.meta{min-width:0;display:flex;align-items:baseline;gap:7px}
.title{font-size:12px;font-weight:600;color:#242424;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.url{font-size:10.5px;font-weight:450;color:#707070;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.btn{width:28px;height:28px;border:0;border-radius:7px;background:transparent;color:#3f3f3f;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;transition:background .12s ease,transform .12s ease,color .12s ease}
.btn:hover{background:rgba(23,23,23,.09)}
.btn:active{transform:scale(.9)}
.btn svg{width:17px;height:17px;display:block}
.btn:disabled,.knob:disabled{opacity:.34;cursor:default;transform:none}
.btn:disabled:hover{background:transparent}
.btn.ok{color:#285B46}
.body{flex:1 1 auto;position:relative;background:#e9ebe8}
.frame{width:100%;height:100%;border:0;display:block;background:#fff}
.loader{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:#fff;color:#747474;font-size:12px}
.loader[hidden],.blocked[hidden]{display:none}
.bar{position:absolute;top:0;left:-40%;height:2px;width:40%;border-radius:2px;background:#285B46;animation:pb-bar 1.1s cubic-bezier(.4,0,.6,1) infinite;z-index:5}
.bar[hidden]{display:none}
@keyframes pb-bar{to{transform:translateX(350%)}}
.spin{width:20px;height:20px;border-radius:50%;border:2.5px solid rgba(40,91,70,.15);border-top-color:#285B46;animation:pb-spin .75s linear infinite}
@keyframes pb-spin{to{transform:rotate(360deg)}}
.blocked{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#fff;padding:24px;animation:pb-fade .25s ease-out}
.blocked-card{max-width:330px;text-align:center;display:flex;flex-direction:column;gap:9px;align-items:center}
.blocked-mark{width:42px;height:42px;border-radius:13px;background:#f0f1ef;color:#5e645f;display:grid;place-items:center;font-size:18px;margin-bottom:4px}
.blocked-title{font-size:14.5px;font-weight:650;color:#1c1f1d}
.blocked-sub{font-size:12px;color:#6b716c;line-height:1.5}
.blocked-actions{display:flex;gap:8px;margin-top:8px}
.btn-primary{background:#285B46;color:#fff;border:0;border-radius:9px;padding:8px 15px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;transition:background .12s ease}
.btn-primary:hover{background:#1f4a38}
.btn-ghost{background:transparent;color:#3c423e;border:1px solid #d4d8d3;border-radius:9px;padding:8px 15px;font-size:12.5px;cursor:pointer;font-family:inherit;transition:background .12s ease}
.btn-ghost:hover{background:rgba(0,0,0,.05)}
.knobs{display:flex;flex-direction:column;gap:9px;padding-top:8px}
.knob{position:relative;width:36px;height:36px;border:0;border-radius:50%;background:rgba(29,29,29,.88);color:rgba(255,255,255,.96);box-shadow:0 0 0 1px rgba(0,0,0,.18),0 4px 14px rgba(0,0,0,.14);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);cursor:pointer;display:grid;place-items:center;transition:background .12s ease,transform .12s ease}
.knob:hover{background:rgba(45,45,45,.96);transform:scale(1.04)}
.knob:active{transform:scale(.92)}
.knob:disabled:hover{background:rgba(29,29,29,.88);transform:none}
.knob svg{width:19px;height:19px}
.knob.active{background:#285B46}
.tip{position:absolute;right:46px;top:50%;transform:translateY(-50%);height:28px;padding:0 8px 0 10px;border-radius:8px;background:rgba(29,29,29,.94);color:#fff;display:none;align-items:center;gap:7px;white-space:nowrap;font-size:11.5px;font-weight:550;box-shadow:0 3px 12px rgba(0,0,0,.16)}
.knob:hover .tip,.knob:focus-visible .tip{display:flex}
.keys{font-size:10px;color:rgba(255,255,255,.72)}
.grip{position:absolute;z-index:5;right:5px;bottom:5px;width:16px;height:16px;cursor:nwse-resize;opacity:.38;background:linear-gradient(135deg,transparent 0 50%,#7f8580 50% 57%,transparent 57% 67%,#7f8580 67% 74%,transparent 74%)}
.stage.docked{filter:drop-shadow(-10px 0 24px rgba(0,0,0,.18))}
.stage.docked .card{border-radius:12px 0 0 12px}
.stage.docked .grip{display:none}
.stage.docked .address{cursor:default}
.stage.docked .knobs{order:-1}
.stage.docked .tip{left:46px;right:auto}
.backdrop.docked{background:transparent;pointer-events:none}
.backdrop.docked .stage{pointer-events:auto}
@media (max-width:720px){.stage{gap:8px}.knob{width:34px;height:34px}.tip{display:none!important}.address{max-width:calc(100vw - 170px)}.chrome{padding-right:6px;padding-left:6px}.grip{display:none}}
@media (prefers-reduced-motion:reduce){.backdrop,.stage,.bar,.spin,.btn,.knob{animation:none!important;transition:none!important}}
@media (prefers-color-scheme:dark){
.card{background:#1d2120;box-shadow:0 0 0 1px rgba(255,255,255,.1),0 8px 28px rgba(0,0,0,.42)}
.chrome{background:rgba(34,37,35,.97);border-bottom-color:rgba(255,255,255,.07)}
.nav,.address{background:rgba(46,49,47,.86);border-color:rgba(255,255,255,.08);box-shadow:0 1px 5px rgba(0,0,0,.2)}
.title{color:#e9edea}
.url{color:#9aa39c}
.btn{color:#c9cfcb}
.btn:hover{background:rgba(255,255,255,.1)}
.body{background:#121514}
.loader,.blocked{background:#1d2120}
.blocked-title{color:#e9edea}
.blocked-sub,.loader{color:#99a09b}
.blocked-mark{background:#2a2f2c;color:#aeb5b0}
.btn-ghost{color:#c9cfcb;border-color:#3b413d}
.btn-ghost:hover{background:rgba(255,255,255,.07)}
.btn.ok{color:#7fb894}
.bar{background:#7fb894}
.spin{border-color:rgba(127,184,148,.2);border-top-color:#7fb894}
.grip{background:linear-gradient(135deg,transparent 0 50%,#6b726c 50% 58%,transparent 58% 68%,#6b726c 68% 76%,transparent 76%)}
}`;

  let enabled = true;
  let optionClick = true;
  let showAddress = true;
  let peek = null;
  let savedOverflow = null;

  function send(msg) {
    return runtimeMessage(msg);
  }

  function clamp(v, lo, hi) {
    return Math.min(Math.max(v, lo), hi);
  }

  function peekIntent(e) {
    if (e.button !== 0) return null;
    const mode = e.shiftKey ? "peek" : optionClick && e.altKey ? "beside" : null;
    if (!mode) return null;
    const path = typeof e.composedPath === "function" ? e.composedPath() : [e.target];
    // Scan the whole path, not just the target's ancestors — covers anchors inside open shadow roots.
    const a = path.find((n) => n instanceof Element && typeof n.matches === "function" && n.matches("a[href]"));
    if (!a || a.hasAttribute("download")) return null;
    const href = a.href;
    return typeof href === "string" && /^https?:\/\//i.test(href) ? { anchor: a, mode } : null;
  }

  window.addEventListener(
    "click",
    (e) => {
      const intent = peekIntent(e);
      if (!intent || !enabled) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const a = intent.anchor;
      const label = (a.innerText || a.textContent || "").replace(/\s+/g, " ").trim();
      console.debug("[PeekBit] peek:", a.href);
      openPeek(a.href, label, intent.mode);
    },
    true
  );

  // Shift+Click would normally start a text selection on the link — suppress it,
  // and keep the page's own mousedown handlers from seeing the gesture.
  window.addEventListener(
    "mousedown",
    (e) => {
      if (enabled && peekIntent(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true
  );

  function openPeek(url, label, mode = "peek") {
    send({ type: "peek:open", url }).then((result) => {
      const policy = {
        // Only an explicit policy rejection should block the iframe. A worker
        // startup/message failure should still attempt the preview instead of
        // showing a false "cannot be loaded" handoff immediately.
        previewable: !result || !result.ok || result.previewable !== false,
        reason: result && result.reason ? result.reason : "unavailable"
      };
      if (peek) {
        navigatePeek(url, label, policy);
        setDocked(policy.previewable && mode === "beside");
      } else buildOverlay(url, label, mode, policy);
    });
  }

  function setMeta(url, label) {
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {}
    // Link text sometimes contains the raw URL (e.g. Google results) — prefer the hostname then.
    const usable = label && label.length <= 90 && !/https?:\/\//i.test(label);
    peek.els.title.textContent = usable ? label : host || url;
    peek.els.url.textContent = readableUrl(url);
    peek.els.url.title = url;
  }

  function readableUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname + (parsed.pathname === "/" ? "" : parsed.pathname);
    } catch {
      return url;
    }
  }

  function buildOverlay(url, label, mode, policy) {
    const host = document.createElement("div");
    host.setAttribute("data-peekbit", "");
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>${CSS}</style>
      <div class="backdrop">
        <div class="stage">
          <div class="card">
            <div class="chrome">
              <span class="nav">
                <button class="btn back" title="Back" aria-label="Back" disabled>${ICON.back}</button>
                <button class="btn forward" title="Forward" aria-label="Forward" disabled>${ICON.forward}</button>
                <button class="btn reload" title="Reload" aria-label="Reload">${ICON.reload}</button>
              </span>
              <span class="address"${showAddress ? "" : " hidden"}>
                <span class="site-dot loading"></span>
                <span class="meta"><span class="title"></span><span class="url"></span></span>
              </span>
            </div>
            <div class="body">
              <span class="bar"></span>
              <iframe class="frame" sandbox="${SANDBOX}" allowfullscreen></iframe>
              <div class="loader"><span class="spin"></span><span>Opening preview…</span></div>
              <div class="blocked" hidden>
                <div class="blocked-card">
                  <span class="blocked-mark">↗</span>
                  <p class="blocked-title">This page won’t open in Peek</p>
                  <p class="blocked-sub">The site may block embedded pages or require a full browser tab.</p>
                  <span class="blocked-actions">
                    <button class="btn-primary blocked-open">Keep as tab</button>
                    <button class="btn-ghost blocked-close">Close</button>
                  </span>
                </div>
              </div>
            </div>
            <span class="grip"></span>
          </div>
          <div class="knobs" aria-label="Peek actions">
            <button class="knob close" aria-label="Close Peek">${ICON.x}<span class="tip">Close <span class="keys">Esc</span></span></button>
            <button class="knob keep" aria-label="Keep as tab">${ICON.tab}<span class="tip">Keep as tab</span></button>
            <button class="knob split" aria-label="Open beside page">${ICON.split}<span class="tip">Open beside</span></button>
            <button class="knob copy" aria-label="Copy address">${ICON.copy}<span class="tip">Copy address</span></button>
          </div>
        </div>
      </div>`;

    const $ = (sel) => shadow.querySelector(sel);
    const els = {
      backdrop: $(".backdrop"),
      stage: $(".stage"),
      card: $(".card"),
      address: $(".address"),
      title: $(".title"),
      url: $(".url"),
      siteDot: $(".site-dot"),
      frame: $(".frame"),
      progress: $(".bar"),
      loader: $(".loader"),
      blocked: $(".blocked"),
      blockedTitle: $(".blocked-title"),
      blockedSub: $(".blocked-sub"),
      back: $(".back"),
      forward: $(".forward"),
      reload: $(".reload"),
      copy: $(".copy"),
      split: $(".split"),
      grip: $(".grip")
    };

    const w = Math.max(MIN_W, Math.min(Math.round(window.innerWidth * 0.74), 1060));
    const h = Math.max(MIN_H, Math.min(Math.round(window.innerHeight * 0.82), 900));
    els.stage.style.width = w + 48 + "px";
    els.stage.style.height = h + "px";
    els.stage.style.left = Math.max(8, Math.round((window.innerWidth - w - 48) / 2)) + "px";
    els.stage.style.top = Math.max(8, Math.round((window.innerHeight - h) / 2)) + "px";

    peek = { host, els, url, loaded: false, loadTimer: 0, docked: false, previewable: policy.previewable };
    setMeta(url, label);

    // Src is set before the iframe is attached so the first load event is the real navigation.
    if (policy.previewable) els.frame.src = url;

    els.frame.addEventListener("load", () => {
      if (!peek || !peek.previewable) return;
      peek.loaded = true;
      els.loader.hidden = true;
      els.progress.hidden = true;
      els.blocked.hidden = true;
      els.siteDot.classList.remove("loading");
      clearTimeout(peek.loadTimer);
    });

    els.backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === els.backdrop) closePeek();
    });
    for (const t of ["click", "mousedown", "pointerdown", "contextmenu"]) {
      els.backdrop.addEventListener(t, (e) => e.stopPropagation());
    }
    els.backdrop.addEventListener("wheel", (e) => e.preventDefault(), { passive: false });
    els.backdrop.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });

    els.address.addEventListener("pointerdown", startDrag);
    els.grip.addEventListener("pointerdown", startResize);

    shadow.querySelector(".close").addEventListener("click", () => closePeek());
    shadow.querySelector(".keep").addEventListener("click", () => {
      send({ type: "peek:open-tab", url: peek.url });
      closePeek(true);
    });
    els.back.addEventListener("click", () => frameAction("back", els.back));
    els.forward.addEventListener("click", () => frameAction("forward", els.forward));
    els.reload.addEventListener("click", () => frameAction("reload", els.reload));
    els.split.addEventListener("click", () => setDocked(!peek.docked));
    els.copy.addEventListener("click", () => copyLink(els.copy));
    shadow.querySelector(".blocked-open").addEventListener("click", () => {
      send({ type: "peek:open-tab", url: peek.url });
      closePeek(true);
    });
    shadow.querySelector(".blocked-close").addEventListener("click", () => closePeek());

    document.documentElement.appendChild(host);
    savedOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onWindowResize);
    setDocked(policy.previewable && mode === "beside");
    if (policy.previewable) armLoadTimer();
    else showSafetyHandoff(policy.reason);
  }

  async function frameAction(action, button) {
    if (!peek || !peek.previewable || button.disabled) return;
    peek.loaded = false;
    peek.els.progress.hidden = false;
    peek.els.siteDot.classList.add("loading");
    const result = await send({ type: "peek:frame-action", action });
    if (!peek) return;
    if (!result || !result.ok) {
      peek.loaded = true;
      peek.els.progress.hidden = true;
      peek.els.siteDot.classList.remove("loading");
      button.disabled = true;
      return;
    }
    if (action === "back") peek.els.forward.disabled = false;
    armLoadTimer();
  }

  function armLoadTimer() {
    clearTimeout(peek.loadTimer);
    peek.loadTimer = setTimeout(() => {
      if (peek && !peek.loaded) {
        showGenericFailure();
      }
    }, LOAD_TIMEOUT_MS);
  }

  function navigatePeek(url, label, policy) {
    peek.url = url;
    setMeta(url, label);
    peek.previewable = policy.previewable;
    peek.els.back.disabled = true;
    peek.els.forward.disabled = true;
    peek.els.reload.disabled = !policy.previewable;
    peek.els.split.disabled = !policy.previewable;
    if (!policy.previewable) {
      peek.els.frame.src = "about:blank";
      showSafetyHandoff(policy.reason);
      return;
    }
    peek.loaded = false;
    peek.els.loader.hidden = false;
    peek.els.progress.hidden = false;
    peek.els.blocked.hidden = true;
    peek.els.siteDot.classList.add("loading");
    peek.els.frame.src = url;
    armLoadTimer();
  }

  function showSafetyHandoff(reason) {
    if (!peek) return;
    peek.previewable = false;
    peek.loaded = true;
    clearTimeout(peek.loadTimer);
    peek.els.loader.hidden = true;
    peek.els.progress.hidden = true;
    peek.els.blocked.hidden = false;
    peek.els.siteDot.classList.remove("loading");
    peek.els.back.disabled = true;
    peek.els.forward.disabled = true;
    peek.els.reload.disabled = true;
    peek.els.split.disabled = true;
    peek.els.blockedTitle.textContent = "Open this page in a full tab";
    peek.els.blockedSub.textContent = reason === "protected-site"
      ? "This dedicated identity or payment site requires a full browser tab. Other sign-in and account pages are attempted inside Peek."
      : "This address cannot be loaded inside PeekBit.";
  }

  function showGenericFailure() {
    if (!peek) return;
    peek.loaded = true;
    peek.els.loader.hidden = true;
    peek.els.progress.hidden = true;
    peek.els.blocked.hidden = false;
    peek.els.siteDot.classList.remove("loading");
    peek.els.blockedTitle.textContent = "This page couldn’t be previewed";
    peek.els.blockedSub.textContent = "The site may not support embedded browsing. Open it as a normal tab to continue safely.";
  }

  function closePeek(immediate = false) {
    if (!peek) return;
    const p = peek;
    peek = null;
    clearTimeout(p.loadTimer);
    p.els.backdrop.classList.add("closing");
    p.els.stage.classList.add("closing");
    if (immediate === true) p.host.remove();
    else setTimeout(() => p.host.remove(), CLOSE_ANIM_MS);
    if (savedOverflow !== null) {
      document.documentElement.style.overflow = savedOverflow;
      savedOverflow = null;
    }
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", onWindowResize);
    send({ type: "peek:close" });
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closePeek();
    }
  }

  function setDocked(docked) {
    if (!peek || peek.docked === docked) return;
    peek.docked = docked;
    const { backdrop, stage, split } = peek.els;
    backdrop.classList.toggle("docked", docked);
    stage.classList.toggle("docked", docked);
    split.classList.toggle("active", docked);
    split.setAttribute("aria-label", docked ? "Return to floating Peek" : "Open beside page");
    if (docked) {
      if (savedOverflow !== null) document.documentElement.style.overflow = savedOverflow;
      const width = Math.max(MIN_W, Math.min(Math.round(window.innerWidth * 0.46), 720));
      stage.style.width = width + 48 + "px";
      stage.style.height = window.innerHeight + "px";
      stage.style.left = Math.max(0, window.innerWidth - width - 48) + "px";
      stage.style.top = "0px";
    } else {
      savedOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = "hidden";
      const width = Math.max(MIN_W, Math.min(Math.round(window.innerWidth * 0.74), 1060));
      const height = Math.max(MIN_H, Math.min(Math.round(window.innerHeight * 0.82), 900));
      stage.style.width = width + 48 + "px";
      stage.style.height = height + "px";
      stage.style.left = Math.max(8, Math.round((window.innerWidth - width - 48) / 2)) + "px";
      stage.style.top = Math.max(8, Math.round((window.innerHeight - height) / 2)) + "px";
    }
  }

  function onWindowResize() {
    if (!peek) return;
    if (peek.docked) {
      const width = Math.max(MIN_W, Math.min(Math.round(window.innerWidth * 0.46), 720));
      peek.els.stage.style.width = width + 48 + "px";
      peek.els.stage.style.height = window.innerHeight + "px";
      peek.els.stage.style.left = Math.max(0, window.innerWidth - width - 48) + "px";
    } else {
      const rect = peek.els.stage.getBoundingClientRect();
      peek.els.stage.style.left = clamp(rect.left, 8, Math.max(8, window.innerWidth - 80)) + "px";
      peek.els.stage.style.top = clamp(rect.top, 8, Math.max(8, window.innerHeight - 48)) + "px";
    }
  }

  async function copyLink(btn) {
    let copied = false;
    try {
      await navigator.clipboard.writeText(peek.url);
      copied = true;
    } catch {}
    if (!copied) copied = legacyCopy(peek.url);
    if (!copied) return;
    btn.classList.add("ok");
    btn.innerHTML = ICON.check;
    setTimeout(() => {
      if (peek) {
        btn.classList.remove("ok");
        btn.innerHTML = ICON.copy;
      }
    }, 900);
  }

  function legacyCopy(value) {
    if (!peek) return false;
    const input = document.createElement("textarea");
    input.value = value;
    input.setAttribute("readonly", "");
    input.style.cssText = "position:fixed;opacity:0;pointer-events:none;";
    peek.host.shadowRoot.appendChild(input);
    input.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {}
    input.remove();
    return ok;
  }

  function trackPointer(move) {
    if (!peek) return () => {};
    // The iframe swallows pointer events while the cursor is over it — disable it during drags.
    const frame = peek.els.frame;
    frame.style.pointerEvents = "none";
    const up = () => {
      frame.style.pointerEvents = "";
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    return up;
  }

  function startDrag(e) {
    if (!peek || peek.docked || e.button !== 0 || e.target.closest("button")) return;
    const r = peek.els.stage.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    trackPointer((ev) => {
      if (!peek) return;
      peek.els.stage.style.left = clamp(ev.clientX - dx, 80 - r.width, window.innerWidth - 80) + "px";
      peek.els.stage.style.top = clamp(ev.clientY - dy, 0, window.innerHeight - 40) + "px";
    });
    e.preventDefault();
  }

  function startResize(e) {
    if (!peek || peek.docked || e.button !== 0) return;
    const r = peek.els.stage.getBoundingClientRect();
    trackPointer((ev) => {
      if (!peek) return;
      peek.els.stage.style.width = clamp(ev.clientX - r.left, MIN_W + 48, window.innerWidth - r.left) + "px";
      peek.els.stage.style.height = clamp(ev.clientY - r.top, MIN_H, window.innerHeight - r.top) + "px";
    });
    e.preventDefault();
    e.stopPropagation();
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!peek || !message) return;
    if (message.type === "peek:safety") {
      if (typeof message.url === "string" && /^https?:\/\//i.test(message.url)) {
        peek.url = message.url;
        setMeta(message.url, "");
      }
      peek.els.frame.src = "about:blank";
      setDocked(false);
      showSafetyHandoff(message.reason || "sensitive-flow");
      return;
    }
    if (message.type === "peek:retry") {
      if (typeof message.url !== "string" || !/^https?:\/\//i.test(message.url)) return;
      peek.url = message.url;
      peek.previewable = true;
      peek.loaded = false;
      setMeta(message.url, "");
      peek.els.loader.hidden = false;
      peek.els.progress.hidden = false;
      peek.els.blocked.hidden = true;
      peek.els.siteDot.classList.add("loading");
      peek.els.frame.src = message.url;
      armLoadTimer();
      return;
    }
    if (message.type === "peek:failure") {
      showGenericFailure();
      return;
    }
    if (message.type !== "peek:location") return;
    if (typeof message.url === "string" && /^https?:\/\//i.test(message.url)) {
      peek.url = message.url;
      setMeta(message.url, message.title || "");
    } else if (message.title) {
      peek.els.title.textContent = message.title;
    }
    if (message.loading) {
      peek.els.progress.hidden = false;
      peek.els.siteDot.classList.add("loading");
    } else {
      peek.loaded = true;
      peek.els.loader.hidden = true;
      peek.els.progress.hidden = true;
      peek.els.blocked.hidden = true;
      peek.els.siteDot.classList.remove("loading");
      peek.els.back.disabled = !message.canBack;
      peek.els.reload.disabled = false;
      clearTimeout(peek.loadTimer);
    }
  });

  try {
    chrome.storage.sync.get({ peekEnabled: true, peekOptionClick: true, peekShowAddress: true }, (items) => {
      enabled = items.peekEnabled !== false;
      optionClick = items.peekOptionClick !== false;
      showAddress = items.peekShowAddress !== false;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      if (changes.peekEnabled) {
        enabled = changes.peekEnabled.newValue !== false;
        if (!enabled) closePeek();
      }
      if (changes.peekOptionClick) optionClick = changes.peekOptionClick.newValue !== false;
      if (changes.peekShowAddress) {
        showAddress = changes.peekShowAddress.newValue !== false;
        if (peek) peek.els.address.hidden = !showAddress;
      }
    });
  } catch {}

  console.debug("[PeekBit] active — Shift+Click a link to peek");
})();
