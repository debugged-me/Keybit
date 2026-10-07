export function chromeVaultStorage() {
  return {
    async read() { return (await chrome.storage.local.get("vault")).vault ?? null; },
    async write(envelope) {
      try { await chrome.storage.local.set({ vault: envelope }); }
      catch { throw new Error("Could not save the vault. Check available browser storage and try again."); }
    }
  };
}
