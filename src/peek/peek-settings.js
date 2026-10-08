// Peek: settings access for the content script. chrome.storage is restricted to trusted
// contexts, so the service worker mediates; the controller caches what this loads.
(() => {
  const ns = (globalThis.__keybitPeek = { ...(globalThis.__keybitPeek ?? {}) });
  ns.settings = {
    defaults() { return { ...ns.utils.DEFAULT_SETTINGS }; },
    sanitize(raw) { return ns.utils.sanitizeSettings(raw); },
    async load() {
      const response = await chrome.runtime.sendMessage({ type: "PEEK_GET_SETTINGS" });
      if (!response?.ok) throw new Error("Peek settings are unavailable.");
      const settings = ns.utils.sanitizeSettings(response.data);
      // Per-site allowance belongs to the top-level page, not the preview or an embedded frame.
      settings.siteAllowed = response?.data?.siteAllowed !== false;
      return settings;
    }
  };
})();
