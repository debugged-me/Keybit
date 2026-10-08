import { fuzzyFilter } from "./search.js";
import { matcherFor, currentEnvironment } from "../matching/url-matcher.js";

const MAX_RESULTS = 12;
// The palette's command set. Everything here is computed in the worker — the page-side iframe only
// ever sees labels/hints, and while the vault is locked the list carries no vault metadata at all.
// `ctx` is { url, origin, tabId }: the page the palette was opened on.
/** @param {{ vault: any, session: string | null, ctx: { url: string, origin: string, tabId: number }, query?: string, rule?: Record<string, boolean> }} args */
export function buildCommands({ vault, session, ctx, query = "", rule = {} }) {
  const unlocked = !!session;
  // The page's own site rule: a turned-off site gets no fills, and each offer flag gates its commands.
  const fillsAllowed = rule.enabled !== false && rule.logins !== false;
  const peekAllowed = rule.peek !== false;
  const commands = [];
  const seen = new Set();
  const push = command => {
    const key = `${command.id}:${command.item ?? ""}${command.project ?? ""}${command.env ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key); commands.push(command);
  };
  const fixed = unlocked ? [
    { id: "lock", icon: "lock", label: "Lock KeyBit", hint: "Clear secrets from memory", keywords: "close sign out" },
    { id: "open", icon: "external", label: "Open KeyBit", hint: "Vault, backups and settings", keywords: "vault manage" },
    { id: "inspect", icon: "search", label: "Inspect login form", hint: "Developer form report for this page", keywords: "developer diagnose" },
    { id: "generate", icon: "key", label: "Generate password", hint: "Copy a new random password", keywords: "random strong" },
    { id: "note", icon: "note", label: "New secure note", hint: "Save text encrypted", keywords: "create" },
    { id: "security", icon: "shield", label: "Open Security Center", hint: "Weak, reused and old passwords", keywords: "health audit" },
    { id: "peek", icon: "eye", label: "Peek this link", hint: "Preview the focused link on this page", keywords: "preview" }
  ].filter(command => command.id !== "peek" || peekAllowed) : [
    { id: "unlock", icon: "lock", label: "Unlock KeyBit", hint: "Enter your master password", keywords: "sign in open" },
    { id: "open", icon: "external", label: "Open KeyBit", hint: "The vault stays locked", keywords: "vault manage" },
    { id: "inspect", icon: "search", label: "Inspect login form", hint: "Developer form report for this page", keywords: "developer diagnose" },
    { id: "peek", icon: "eye", label: "Peek this link", hint: "Preview the focused link on this page", keywords: "preview" }
  ].filter(command => command.id !== "peek" || peekAllowed);
  if (unlocked && fillsAllowed) {
    // Page-matching logins become Fill commands, most relevant first.
    for (const item of vault.list(session, "", ctx.url).filter(item => item.type === "login").slice(0, 5))
      push({ id: "fill", item: item.id, icon: "fill", label: `Fill ${item.name}`, hint: item.username || item.scope, keywords: item.name });
    // Project environment switches: every environment except the one the page is already on.
    const environments = vault.environments(session).merged;
    for (const [project, map] of Object.entries(environments)) {
      const envs = Object.keys(map);
      if (envs.length < 2 || rule.enabled === false) continue;
      const current = currentEnvironment(map, ctx.url);
      for (const env of envs) {
        if (env === current) continue;
        push({ id: "switch", project, env, icon: "globe", label: `${env === "production" ? "⚠ " : ""}Switch ${project} to ${env}`,
          hint: map[env], keywords: `${project} ${env} environment`, production: env === "production" });
      }
    }
  }
  for (const command of fixed) push(command);
  if (!query.trim()) return { locked: !unlocked, commands: commands.slice(0, MAX_RESULTS) };
  // Searching also reaches into the vault: a matching login on this page fills in place, one on
  // another site opens in KeyBit. While locked nothing vault-related is queried or listed.
  if (unlocked) {
    const fits = matcherFor(ctx.url);
    for (const item of vault.list(session, query).slice(0, 8)) {
      if (item.type === "login" && fits(item) && fillsAllowed)
        push({ id: "fill", item: item.id, icon: "fill", label: `Fill ${item.name}`, hint: item.username || item.scope, keywords: item.name });
      else
        push({ id: "open-item", item: item.id, icon: item.type === "note" ? "note" : item.type === "card" ? "card" : item.type === "identity" ? "id" : "key",
          label: `Show ${item.name} in KeyBit`, hint: item.scope || item.username || item.type, keywords: item.name });
    }
  }
  const ranked = fuzzyFilter(query, commands, command => `${command.label} ${command.hint ?? ""} ${command.keywords ?? ""}`);
  return { locked: !unlocked, commands: ranked.slice(0, MAX_RESULTS) };
}
