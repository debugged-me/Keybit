// Offscreen document owned by the service worker: a page that copies a secret may close before
// the 30-second clear fires, but this document stays alive until its timer is done, then closes.
let pending;
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "CLIPBOARD_ARM" || sender.id !== chrome.runtime.id || typeof message.value !== "string") return;
  clearTimeout(pending);
  const ms = Number.isSafeInteger(message.ms) && message.ms > 0 ? Math.min(message.ms, 120000) : 30000;
  pending = setTimeout(async () => {
    // Only clear while the clipboard still holds what KeyBit copied — never erase something newer.
    try { if (await navigator.clipboard.readText() === message.value) await navigator.clipboard.writeText(""); }
    catch { /* clipboardRead revoked or clipboard busy: leave the clipboard alone. */ }
    window.close();
  }, ms);
});
