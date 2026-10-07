// Applies the chosen theme (System, Light, or Dark) before the page paints. Loaded as a classic script in <head>.
(() => {
  const apply = theme => {
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  };
  let saved = null;
  try { saved = localStorage.getItem("keybit-theme"); } catch { /* Storage blocked. */ }
  apply(saved);
  // Frames inside websites may not share localStorage with KeyBit's pages; extension storage always does.
  chrome.storage?.local.get("theme").then(value => { if ((value.theme ?? null) !== saved) apply(value.theme); }).catch(() => {});
  chrome.storage?.onChanged.addListener((changes, area) => { if (area === "local" && changes.theme) apply(changes.theme.newValue); });
  globalThis.keybitTheme = {
    get: () => document.documentElement.dataset.theme ?? "system",
    set: theme => {
      try { localStorage.setItem("keybit-theme", theme); } catch { /* Storage blocked. */ }
      apply(theme);
      return chrome.storage.local.set({ theme });
    }
  };
})();
