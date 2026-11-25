"use strict";

const enabledToggle = document.getElementById("enabled");
const optionToggle = document.getElementById("option-click");
const addressToggle = document.getElementById("show-address");
const statusBadge = document.getElementById("status");

function updateStatus() {
  const on = enabledToggle.checked;
  statusBadge.textContent = on ? "On" : "Off";
  statusBadge.classList.toggle("off", !on);
  document.body.classList.toggle("disabled", !on);
}

chrome.storage.sync.get({ peekEnabled: true, peekOptionClick: true, peekShowAddress: true }, (items) => {
  enabledToggle.checked = items.peekEnabled !== false;
  optionToggle.checked = items.peekOptionClick !== false;
  addressToggle.checked = items.peekShowAddress !== false;
  updateStatus();
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
