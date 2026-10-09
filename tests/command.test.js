import test from "node:test";
import assert from "node:assert/strict";
import { Vault } from "../src/vault/vault.js";
import { buildCommands } from "../src/command/registry.js";
import { fuzzyFilter, tokenize } from "../src/command/search.js";
import { currentEnvironment } from "../src/matching/url-matcher.js";

const password = "a unique test passphrase";
const ctx = { url: "http://localhost:8000/srms-college/admin", origin: "http://localhost:8000", tabId: 1 };
function memoryStorage() {
  let data = null;
  return { async read() { return structuredClone(data); }, async write(value) { data = structuredClone(value); } };
}
async function seeded() {
  const vault = new Vault(memoryStorage());
  let state = await vault.create(password);
  state = await vault.saveItem(state.session, state.revision, {
    name: "SRMS Admin", urls: ["http://localhost:8000/srms-college"], username: "registrar", password: "pw-one",
    project: "SRMS", environment: "local" });
  state = await vault.saveItem(state.session, state.revision, {
    name: "GitHub", urls: ["https://github.com/login"], username: "octo", password: "pw-two", environment: "production" });
  state = await vault.saveItem(state.session, state.revision, { name: "Launch checklist", type: "note", notes: "deploy then celebrate" });
  state = await vault.setProjectEnvironments(state.session, state.revision, "SRMS",
    { local: "http://localhost:8000/srms-college", production: "https://srms.example.com" });
  return { vault, session: state.session };
}
test("fuzzy search matches tokens, subsequence and prefixes with sane ordering", () => {
  const pool = [{ n: "Switch SRMS to production" }, { n: "Inspect login form" }, { n: "Lock KeyBit" }];
  assert.deepEqual(fuzzyFilter("prod", pool, item => item.n).map(item => item.n), ["Switch SRMS to production"]);
  assert.deepEqual(fuzzyFilter("inspect", pool, item => item.n).map(item => item.n), ["Inspect login form"]);
  assert.deepEqual(fuzzyFilter("lock", pool, item => item.n).map(item => item.n), ["Lock KeyBit"]);
  assert.deepEqual(fuzzyFilter("log frm", pool, item => item.n).map(item => item.n), ["Inspect login form"], "scattered tokens still match");
  assert.deepEqual(fuzzyFilter("", pool, item => item.n).length, 3, "empty query returns everything");
  assert.deepEqual(fuzzyFilter("zzzzz", pool, item => item.n), []);
  assert.deepEqual(tokenize("  Switch  to  Production "), ["switch", "to", "production"]);
});

test("locked palette lists only non-secret commands — no vault metadata at all", async () => {
  const { vault } = await seeded();
  const locked = buildCommands({ vault, session: null, ctx, query: "" });
  assert.equal(locked.locked, true);
  assert.deepEqual(locked.commands.map(command => command.id).sort(), ["inspect", "open", "unlock"]);
  // Searching while locked must not reach item names — not even via fuzzy hits.
  for (const query of ["srms", "github", "registrar", "checklist"]) {
    const result = buildCommands({ vault, session: null, ctx, query });
    assert.ok(result.commands.every(command => ["unlock", "open", "inspect"].includes(command.id)), query);
    assert.ok(!JSON.stringify(result).match(/SRMS Admin|GitHub|registrar|checklist/i), query);
  }
});

test("unlocked palette offers fill, switch, generate, note, security, inspect and lock", async () => {
  const { vault, session } = await seeded();
  const commands = buildCommands({ vault, session, ctx, query: "" }).commands;
  const ids = commands.map(command => command.id);
  for (const id of ["fill", "switch", "open", "inspect", "generate", "note", "security", "lock"]) assert.ok(ids.includes(id), id);
  const fill = commands.find(command => command.id === "fill");
  assert.equal(fill.item, vault.list(session, "SRMS")[0].id);
  const prod = commands.find(command => command.id === "switch" && command.env === "production");
  assert.ok(prod.production, "production switch carries the marker");
  assert.match(prod.label, /⚠/);
  assert.equal(prod.hint, "https://srms.example.com/");
  assert.ok(!commands.some(command => command.env === "local"), "the current environment is never offered");
});

test("queries route to commands and vault search without leaking wrong-site fills", async () => {
  const { vault, session } = await seeded();
  const run = query => buildCommands({ vault, session, ctx, query }).commands;
  assert.equal(run("prod")[0].id, "switch");
  assert.equal(run("lock")[0].id, "lock");
  assert.equal(run("inspect")[0].id, "inspect");
  // GitHub matches a vault login on another site — offered as open-in-KeyBit, never fill here.
  const github = run("github").find(command => /GitHub/.test(command.label));
  assert.ok(github, "vault search finds the item");
  assert.equal(github.id, "open-item");
  // Fills only ever come from exact site matches.
  assert.ok(run("github").every(command => command.id !== "fill"), "off-site credentials are not fillable");
  const note = run("checklist").find(command => command.id === "open-item");
  assert.ok(note, "secure notes are searchable too");
});

test("currentEnvironment picks the longest matching base and rejects pages outside the project", () => {
  const map = { local: "http://localhost:8000/srms-college", production: "https://srms.example.com" };
  assert.equal(currentEnvironment(map, "http://localhost:8000/srms-college/admin?tab=2"), "local");
  assert.equal(currentEnvironment(map, "https://srms.example.com/x"), "production");
  assert.equal(currentEnvironment(map, "http://localhost:8000/other-app"), null);
  assert.equal(currentEnvironment(map, "https://elsewhere.example.com"), null);
  assert.equal(currentEnvironment({ a: "http://localhost:8000/app", b: "http://localhost:8000" }, "http://localhost:8000/app/x"), "a", "longest base wins");
});
