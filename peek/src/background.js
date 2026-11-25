// PeekBit background — scopes preview compatibility rules to one tab and target domain at a time.
"use strict";

// Only hosts dedicated to identity or payment stay in full-tab mode. Ordinary
// sites are allowed to try every route (including /login and /account) in Peek.
const PROTECTED_HOSTS = [
  "accounts.google.com",
  "appleid.apple.com",
  "checkout.stripe.com",
  "login.live.com",
  "login.microsoftonline.com",
  "paypal.com"
];

const peekFrames = new Map(); // tabId -> { frameId, expectedUrl, previewable }
const peekRules = new Map(); // tabId -> { id, domainKey }
const recentPeek = new Map(); // tabId -> timestamp of last peek:open
const PEEK_GRACE_MS = 1000;
let pending = Promise.resolve();
let nextRuleId = 1001;

// Session rules outlive a service-worker restart, so reconcile first.
(async () => {
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const ids = rules.map((r) => r.id);
    if (ids.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
  } catch {}
})();

function queueRuleUpdate(update) {
  pending = pending.then(() => chrome.declarativeNetRequest.updateSessionRules(update)).catch(() => {});
  return pending;
}

function isProtectedHost(hostname) {
  const host = hostname.toLowerCase();
  return PROTECTED_HOSTS.some((domain) => host === domain || host.endsWith("." + domain));
}

function previewPolicy(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return { previewable: false, reason: "unsupported" };
    if (url.username || url.password) return { previewable: false, reason: "sensitive" };
    if (isProtectedHost(url.hostname)) return { previewable: false, reason: "protected-site" };
    return { previewable: true, reason: "" };
  } catch {
    return { previewable: false, reason: "invalid" };
  }
}

function ruleDomains(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    const base = host.replace(/^www\./, "");
    return host === base ? [host] : [host, base];
  } catch {
    return [];
  }
}

function setPreviewRule(tabId, url, previewable) {
  const old = peekRules.get(tabId);
  if (!previewable) {
    peekRules.delete(tabId);
    return old ? queueRuleUpdate({ removeRuleIds: [old.id] }) : Promise.resolve();
  }
  const domains = ruleDomains(url);
  if (!domains.length) return Promise.resolve();
  const domainKey = domains.join("|");
  if (old && old.domainKey === domainKey) return Promise.resolve();
  const id = old ? old.id : nextRuleId++;
  peekRules.set(tabId, { id, domainKey });
  const rule = {
    id,
    priority: 1,
    action: {
      type: "modifyHeaders",
      responseHeaders: [
        { header: "x-frame-options", operation: "remove" },
        { header: "content-security-policy", operation: "remove" },
        { header: "content-security-policy-report-only", operation: "remove" }
      ]
    },
    condition: { tabIds: [tabId], requestDomains: domains, resourceTypes: ["sub_frame"] }
  };
  return queueRuleUpdate({ removeRuleIds: old ? [old.id] : [], addRules: [rule] });
}

function clearPreviewRule(tabId) {
  const rule = peekRules.get(tabId);
  peekRules.delete(tabId);
  return rule ? queueRuleUpdate({ removeRuleIds: [rule.id] }) : Promise.resolve();
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return value;
  }
}

function sendToPeek(tabId, message) {
  try {
    const result = chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch {}
}

function sendToFrame(tabId, frameId, message) {
  try {
    const result = chrome.tabs.sendMessage(tabId, message, { frameId });
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch {}
}

function matchesExpected(actual, expected) {
  if (!expected) return false;
  const a = normalizeUrl(actual);
  const e = normalizeUrl(expected);
  return a === e || a.startsWith(e) || e.startsWith(a);
}

async function runFrameAction(tabId, action) {
  const state = peekFrames.get(tabId);
  if (!state || typeof state.frameId !== "number") return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [state.frameId] },
      func: (name) => {
        if (name === "back") history.back();
        else if (name === "forward") history.forward();
        else if (name === "reload") location.reload();
      },
      args: [action]
    });
    return true;
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tab = sender.tab;
  const tabId = tab && typeof tab.id === "number" ? tab.id : null;
  if (!msg || typeof msg.type !== "string") return;
  switch (msg.type) {
    case "peek:frame-status":
      {
        const state = tabId === null ? null : peekFrames.get(tabId);
        const frameId = typeof sender.frameId === "number" ? sender.frameId : 0;
        const frameUrl = typeof sender.url === "string" ? sender.url : msg.url;
        const owned = Boolean(
          state && state.previewable && frameId > 0 &&
          (state.frameId === frameId || (state.frameId === null && matchesExpected(frameUrl, state.expectedUrl)))
        );
        if (owned && state.frameId === null) state.frameId = frameId;
        sendResponse({ ok: true, owned });
      }
      return;
    case "peek:prepare-navigation":
      {
        const state = tabId === null ? null : peekFrames.get(tabId);
        const frameId = typeof sender.frameId === "number" ? sender.frameId : 0;
        if (!state || !state.previewable || frameId <= 0 || state.frameId !== frameId || typeof msg.url !== "string") {
          sendResponse({ ok: false, owned: false });
          return;
        }
        const policy = previewPolicy(msg.url);
        if (!policy.previewable) {
          state.previewable = false;
          state.expectedUrl = msg.url;
          clearPreviewRule(tabId).then(() => {
            sendToPeek(tabId, { type: "peek:safety", url: msg.url, reason: policy.reason });
            sendResponse({ ok: true, owned: true, previewable: false });
          });
          return true;
        }
        setPreviewRule(tabId, msg.url, true).then(() => {
          state.expectedUrl = msg.url;
          state.retriedUrl = "";
          sendResponse({ ok: true, owned: true, previewable: true });
        });
      }
      return true;
    case "peek:open":
      if (tabId === null) {
        sendResponse({ ok: false });
        return;
      }
      {
        const policy = previewPolicy(msg.url);
        peekFrames.set(tabId, {
          frameId: null,
          expectedUrl: typeof msg.url === "string" ? msg.url : "",
          previewable: policy.previewable,
          retriedUrl: ""
        });
        recentPeek.set(tabId, Date.now());
        setPreviewRule(tabId, msg.url, policy.previewable).then(() => {
          sendResponse({ ok: true, previewable: policy.previewable, reason: policy.reason });
        });
      }
      return true;
    case "peek:close":
      if (tabId !== null) {
        peekFrames.delete(tabId);
      }
      (tabId === null ? Promise.resolve() : clearPreviewRule(tabId)).then(() => sendResponse({ ok: true }));
      return true;
    case "peek:open-tab":
      if (typeof msg.url === "string") {
        chrome.tabs.create({ url: msg.url, active: true, index: tab ? tab.index + 1 : undefined });
      }
      sendResponse({ ok: true });
      return;
    case "peek:frame-action":
      if (tabId === null || !["back", "forward", "reload"].includes(msg.action)) {
        sendResponse({ ok: false });
        return;
      }
      runFrameAction(tabId, msg.action).then((ok) => sendResponse({ ok }));
      return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  peekFrames.delete(tabId);
  clearPreviewRule(tabId);
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) {
    peekFrames.delete(details.tabId);
    clearPreviewRule(details.tabId);
    return;
  }
  const state = peekFrames.get(details.tabId);
  if (!state || !state.previewable) return;
  const policy = previewPolicy(details.url);
  if (!policy.previewable) {
    state.previewable = false;
    state.expectedUrl = details.url;
    clearPreviewRule(details.tabId);
    sendToPeek(details.tabId, { type: "peek:safety", url: details.url, reason: policy.reason });
    return;
  }
  if (state.frameId === null && matchesExpected(details.url, state.expectedUrl)) state.frameId = details.frameId;
  if (state.frameId !== details.frameId) return;
  state.expectedUrl = details.url;
  setPreviewRule(details.tabId, details.url, true);
  sendToFrame(details.tabId, details.frameId, { type: "peek:frame-owned" });
  sendToPeek(details.tabId, { type: "peek:location", url: details.url, loading: true });
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId === 0) return;
  const state = peekFrames.get(details.tabId);
  if (!state || !state.previewable) return;
  const policy = previewPolicy(details.url);
  if (!policy.previewable) {
    state.previewable = false;
    state.expectedUrl = details.url;
    clearPreviewRule(details.tabId);
    sendToPeek(details.tabId, { type: "peek:safety", url: details.url, reason: policy.reason });
    return;
  }
  if (state.frameId === null && matchesExpected(details.url, state.expectedUrl)) state.frameId = details.frameId;
  if (state.frameId === details.frameId) {
    state.expectedUrl = details.url;
    // Links in a preview can cross domains. Move the narrowly-scoped framing
    // rule to the destination instead of leaving it attached to the first host.
    setPreviewRule(details.tabId, details.url, true);
    sendToPeek(details.tabId, { type: "peek:location", url: details.url, loading: true });
  }
});

chrome.webNavigation.onCompleted.addListener(async (details) => {
  const state = peekFrames.get(details.tabId);
  if (!state || !state.previewable || details.frameId !== state.frameId) return;
  let title = "";
  let url = details.url;
  let historyLength = 1;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: details.tabId, frameIds: [details.frameId] },
      func: () => ({ title: document.title, url: location.href, historyLength: history.length })
    });
    if (result && result.result) {
      title = result.result.title || "";
      url = result.result.url || url;
      historyLength = result.result.historyLength || 1;
    }
  } catch {}
  state.expectedUrl = url;
  state.retriedUrl = "";
  sendToPeek(details.tabId, { type: "peek:location", url, title, loading: false, canBack: historyLength > 1 });
});

chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId === 0 || details.error === "net::ERR_ABORTED") return;
  const state = peekFrames.get(details.tabId);
  if (!state || !state.previewable || details.frameId !== state.frameId) return;
  const policy = previewPolicy(details.url);
  if (!policy.previewable) return;
  const normalized = normalizeUrl(details.url);
  if (state.retriedUrl === normalized) {
    sendToPeek(details.tabId, { type: "peek:failure", url: details.url });
    return;
  }
  state.retriedUrl = normalized;
  // onBeforeNavigate cannot wait for an asynchronous DNR update. If a
  // cross-domain response wins that race, retry once after the new host rule is
  // definitely installed.
  setPreviewRule(details.tabId, details.url, true).then(() => {
    sendToPeek(details.tabId, { type: "peek:retry", url: details.url });
  });
});

// Safety net: if a Shift+Click still slips through and the browser opens a new
// window/tab right after a peek request, close it — the overlay is already up.
chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  const t = recentPeek.get(details.sourceTabId);
  if (!t) return;
  recentPeek.delete(details.sourceTabId);
  if (Date.now() - t <= PEEK_GRACE_MS) {
    try {
      const p = chrome.tabs.remove(details.tabId);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {}
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(["peekEnabled"], (items) => {
    if (items.peekEnabled === undefined) chrome.storage.sync.set({ peekEnabled: true });
  });
});

// Manifest-injected content scripts only land on pages loaded after install or
// extension reload. Run this on every worker startup so already-open tabs do not
// retain an invalidated old script that makes every preview look unavailable.
async function injectIntoExistingTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
    for (const tab of tabs) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["src/content.js"] });
      } catch {}
    }
  } catch {}
}

injectIntoExistingTabs();
