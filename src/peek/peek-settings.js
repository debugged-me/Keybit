// Peek: settings access for the content script. chrome.storage is restricted to trusted
// contexts, so the service worker mediates; the controller caches what this loads.
(() => {
  const ns = (globalThis.__keybitPeek = { ...(globalThis.__keybitPeek ?? {}) });
  ns.settings = {
    defaults() { return { ...ns.utils.DEFAULT_SETTINGS }; },
    sanitize(raw) { return ns.utils.sanitizeSettings(raw); },
    async load() {
      const response = await chrome.runtime.sendMessage({ type: "PEEK_GET_SETTINGS" });
      return ns.utils.sanitizeSettings(response?.ok ? response.data : null);
    }
  };
})();
