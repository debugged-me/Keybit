"use strict";

const enabledToggle = document.getElementById("enabled");
const optionToggle = document.getElementById("option-click");
const addressToggle = document.getElementById("show-address");
const safeAuthToggle = document.getElementById("safe-auth");
const siteToggle = document.getElementById("site-enabled");
const siteHost = document.getElementById("site-host");
const statusBadge = document.getElementById("status");
let currentHost = "";

function updateStatus() {
  const on = enabledToggle.checked;
  statusBadge.textContent = on ? "On" : "Off";
  statusBadge.classList.toggle("off", !on);
  document.body.classList.toggle("disabled", !on);
}

chrome.storage.sync.get({ peekEnabled: true, peekOptionClick: true, peekShowAddress: true, peekSafeAuth: true, peekBlockedHosts: [] }, (items) => {
  enabledToggle.checked = items.peekEnabled !== false;
  optionToggle.checked = items.peekOptionClick !== false;
  addressToggle.checked = items.peekShowAddress !== false;
  safeAuthToggle.checked = items.peekSafeAuth !== false;
  siteToggle.checked = !items.peekBlockedHosts.includes(currentHost);
  updateStatus();
});

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  try { currentHost = new URL(tabs[0]?.url).hostname.toLowerCase(); } catch { currentHost = ""; }
  siteHost.textContent = currentHost || "Unavailable on this page";
  siteToggle.disabled = !currentHost;
  chrome.storage.sync.get({ peekBlockedHosts: [] }, items => { siteToggle.checked = !!currentHost && !items.peekBlockedHosts.includes(currentHost); });
});

enabledToggle.addEventListener("change", () => {
  chrome.storage.sync.set({ peekEnabled: enabledToggle.checked });
  updateStatus();
});

optionToggle.addEventListener("change", () => {
  chrome.storage.sync.set({ peekOptionClick: optionToggle.checked });
});

addressToggle.addEventListener("change", () => {
  chrome.storage.sync.set({ peekShowAddress: addressToggle.checked });
});

safeAuthToggle.addEventListener("change", () => chrome.storage.sync.set({ peekSafeAuth: safeAuthToggle.checked }));
siteToggle.addEventListener("change", () => {
  if (!currentHost) return;
  chrome.storage.sync.get({ peekBlockedHosts: [] }, items => {
    const hosts = new Set(items.peekBlockedHosts);
    if (siteToggle.checked) hosts.delete(currentHost); else hosts.add(currentHost);
    chrome.storage.sync.set({ peekBlockedHosts: [...hosts].slice(0, 500) });
  });
});
