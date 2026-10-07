// When each login was last filled, on this device, so the most-used account is offered first.
// Keys are random login IDs, so this reveals no site names or usernames.
export class Usage {
  times = {};
  #timer = null;
  async load() {
    const saved = (await chrome.storage.local.get("usage")).usage;
    this.times = saved && typeof saved === "object" ? saved : {};
  }
  touch(id) {
    this.times[id] = Date.now();
    // Fills come in bursts; one small write is enough.
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void chrome.storage.local.set({ usage: this.times }).catch(() => {}), 1500);
  }
  annotate(items) { return items.map(item => ({ ...item, lastUsedAt: this.times[item.id] ?? 0 })); }
  prune(ids) {
    const keep = new Set(ids);
    if (Object.keys(this.times).every(id => keep.has(id))) return;
    this.times = Object.fromEntries(Object.entries(this.times).filter(([id]) => keep.has(id)));
    void chrome.storage.local.set({ usage: this.times }).catch(() => {});
  }
}

// Two-step sign-ins (username page, then password page): the chosen account is remembered per tab for five minutes.
export class Steps {
  #byTab = new Map();
  remember(tabId, origin, value) { this.#byTab.set(tabId, { ...this.recall(tabId, origin), ...value, origin, expires: Date.now() + 300000 }); }
  recall(tabId, origin) {
    const entry = this.#byTab.get(tabId);
    return entry && entry.origin === origin && entry.expires > Date.now() ? entry : null;
  }
  forget(tabId) { this.#byTab.delete(tabId); }
  clear() { this.#byTab.clear(); }
}
