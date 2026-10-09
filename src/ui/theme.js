// Applies the chosen theme (System, Light, or Dark) before the page paints. Loaded as a classic script in <head>.
// The same early pass applies the accent, text-size and density preferences so nothing flashes.
(() => {
  const apply = theme => {
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  };
  const applyUi = prefs => {
    const root = document.documentElement;
    for (const [key, attr, fallback] of [["accent", "accent", ""], ["textSize", "text-size", "default"], ["density", "density", "comfortable"]]) {
      if (!(key in prefs)) continue; // Only touch the keys that were actually provided.
      const value = prefs[key];
      if (value && value !== fallback) root.setAttribute(`data-${attr}`, value);
      else root.removeAttribute(`data-${attr}`);
    }
  };
  let saved = null;
  try { saved = localStorage.getItem("keybit-theme"); } catch { /* Storage blocked. */ }
  apply(saved);
  // Frames inside websites may not share localStorage with KeyBit's pages; extension storage always does.
  chrome.storage?.local.get(["theme", "accent", "textSize", "density"]).then(value => {
    if ((value.theme ?? null) !== saved) apply(value.theme);
    applyUi(value);
  }).catch(() => {});
  chrome.storage?.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.theme) apply(changes.theme.newValue);
    applyUi(Object.fromEntries(Object.entries(changes).filter(([key]) => key !== "theme").map(([key, change]) => [key, change.newValue])));
  });
  globalThis.keybitTheme = {
    get: () => document.documentElement.dataset.theme ?? "system",
    set: theme => {
      try { localStorage.setItem("keybit-theme", theme); } catch { /* Storage blocked. */ }
      apply(theme);
      return chrome.storage.local.set({ theme });
    }
  };
  globalThis.keybitUi = {
    get: () => ({
      accent: document.documentElement.getAttribute("data-accent") ?? "green",
      textSize: document.documentElement.getAttribute("data-text-size") ?? "default",
      density: document.documentElement.getAttribute("data-density") ?? "comfortable"
    }),
    set: (key, value) => {
      applyUi({ [key]: value });
      return chrome.storage.local.set({ [key]: value });
    }
  };
})();
