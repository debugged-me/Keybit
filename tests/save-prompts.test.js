import test from "node:test";
import assert from "node:assert/strict";
import { SavePrompts } from "../src/background/save-prompts.js";
import { Vault } from "../src/vault/vault.js";

// A fake browser for one tab. `page.url` is the top-level document URL; `page.documentId` changes on navigation.
function harness(origin) {
  const env = { now: Date.now(), encrypted: null, permission: true, activeId: 1, page: { url: origin + "/login", documentId: "original" } };
  globalThis.chrome = {
    tabs: { get: async () => ({ id: 1, url: env.page.url }), query: async () => [{ id: env.activeId }] },
    scripting: { executeScript: async ({ target }) => {
      if (target.documentIds[0] !== env.page.documentId) throw new Error("Document gone");
      return [{ result: new URL(env.page.url).origin }];
    } }
  };
  let prompts;
  env.vault = new Vault({ read: async () => env.encrypted, write: async value => { env.encrypted = value; } }, () => env.now, () => prompts?.clear());
  prompts = env.prompts = new SavePrompts(env.vault, { allows: async value => value === origin && env.permission }, () => env.now);
  env.sender = () => ({ frameId: 0, documentId: env.page.documentId, url: env.page.url, tab: { id: 1 } });
  env.frame = () => ({ frameId: 1, documentId: "panel-" + env.page.documentId, tab: { id: 1 } });
  env.prompt = async submission => {
    assert.equal((await prompts.capture(submission, env.sender())).available, true);
    const { token } = await prompts.open(env.sender());
    return { token, state: await prompts.panel({ type: "SAVE_PROMPT_STATE", token }, env.frame()) };
  };
  env.confirm = (token, action, id) => prompts.panel({ type: "SAVE_PROMPT_CONFIRM", token, action, id }, env.frame());
  return env;
}

test("save prompts enforce confirmation, origin, frame, revision, duplicate suppression, expiry, and lock", async () => {
  const origin = "https://login.example.test";
  const env = harness(origin);
  const { vault, prompts } = env;
  const submission = { username: "new-user", password: "submitted-secret" };
  await vault.create("test-only-master-password");
  let state;
  try {
    const before = JSON.stringify(env.encrypted);
    const { token, state: card } = await env.prompt(submission);
    assert.equal(JSON.stringify(env.encrypted), before, "Capture must not persist anything");
    assert.deepEqual(card, { origin, site: "login.example.test", username: "new-user", kind: "login", update: false, preferNew: true, candidates: [] });
    await assert.rejects(prompts.panel({ type: "SAVE_PROMPT_CONFIRM", token, action: "new" }, { ...env.frame(), tab: { id: 2 } }), /expired/);
    await assert.rejects(prompts.panel({ type: "SAVE_PROMPT_CONFIRM", token, action: "new" }, { ...env.frame(), frameId: 0 }), /expired/);
    await env.confirm(token, "new");
    state = await vault.status();
    const saved = vault.list(state.session)[0];
    assert.equal(vault.item(state.session, saved.id).password, submission.password);
    assert.equal(JSON.stringify(env.encrypted).includes(submission.password), false);
    assert.equal((await prompts.capture(submission, env.sender())).available, false, "Identical credentials are not offered again");
    assert.equal((await prompts.capture(submission, { ...env.sender(), url: "http://login.example.test" })).available, false);
    assert.equal((await prompts.capture(submission, { ...env.sender(), url: origin + ":8443" })).available, false);
    env.permission = false;
    assert.equal((await prompts.capture({ ...submission, password: "other" }, env.sender())).available, false);
    env.permission = true;

    let opened = await env.prompt({ ...submission, password: "updated-secret" });
    assert.equal(opened.state.update, true);
    assert.equal(opened.state.preferNew, false);
    assert.deepEqual(opened.state.candidates.map(candidate => candidate.id), [saved.id]);
    await env.confirm(opened.token, "update", saved.id);
    const updated = vault.item(state.session, saved.id);
    assert.equal(updated.password, "updated-secret");
    assert.deepEqual(updated.history.map(entry => entry.password), [submission.password], "The replaced password is kept in history");

    opened = await env.prompt({ ...submission, password: "wrong-target" });
    await assert.rejects(env.confirm(opened.token, "update", "00000000-0000-4000-8000-000000000000"), /Choose which saved login/);
    await assert.rejects(env.confirm(opened.token), /Unsupported/);
    env.activeId = 2;
    await assert.rejects(env.confirm(opened.token, "update", saved.id), /Return to/);
    env.activeId = 1;
    await assert.rejects(prompts.panel({ type: "SAVE_PROMPT_STATE", token: opened.token }, { ...env.frame(), tab: { id: 2 } }), /expired/);
    await assert.rejects(prompts.panel({ type: "SAVE_PROMPT_STATE", token: opened.token }, { ...env.frame(), frameId: 0 }), /expired/);
    // A normal same-origin redirect rebinds only the new document/frame.
    const oldFrame = env.frame(); env.page.documentId = "redirect";
    assert.equal((await prompts.open(env.sender())).token, opened.token);
    await prompts.panel({ type: "SAVE_PROMPT_STATE", token: opened.token }, env.frame());
    await assert.rejects(prompts.panel({ type: "SAVE_PROMPT_CONFIRM", token: opened.token, action: "new" }, oldFrame), /expired/);
    await prompts.panel({ type: "SAVE_PROMPT_DISMISS", token: opened.token }, env.frame());
    assert.equal(prompts.pending.size, 0);
    assert.equal(vault.item(state.session, saved.id).password, "updated-secret", "Dismissal leaves the vault unchanged");

    opened = await env.prompt({ ...submission, password: "stale-secret" });
    state = await vault.status();
    await vault.settings(state.session, { autoLockMinutes: 5 });
    await assert.rejects(env.confirm(opened.token, "update", saved.id), /another window/);
    opened = await env.prompt({ ...submission, password: "late-secret" });
    env.now += 120001;
    await assert.rejects(env.confirm(opened.token, "update", saved.id), /expired/);
    assert.equal(prompts.pending.size, 0);
    await prompts.capture({ ...submission, password: "locked-secret" }, env.sender());
    vault.lock();
    assert.equal(prompts.pending.size, 0);
    assert.equal((await prompts.capture({ ...submission, password: "locked-secret" }, env.sender())).available, false);
    await vault.unlock("test-only-master-password");
    await prompts.capture({ ...submission, password: "expiring-secret" }, env.sender());
    env.now += 300001; await vault.status();
    assert.equal(prompts.pending.size, 0, "Auto-lock clears pending credentials too");
  } finally { prompts.clear(); delete globalThis.chrome; }
});

test("same username on another site or project folder never overwrites the other login", async () => {
  const env = harness("http://localhost");
  const { vault, prompts } = env;
  let state = await vault.create("test-only-master-password");
  const base = { username: "admin", notes: "", environment: "local" };
  try {
    state = await vault.saveItem(state.session, state.revision, { ...base, name: "SRMS", urls: ["http://localhost/srms-college/"], password: "srms-secret" });
    const srms = vault.list(state.session)[0];
    // Another XAMPP project, same username, different password: a new login, not an update.
    env.page.url = "http://localhost/other-app/login.php";
    let opened = await env.prompt({ username: "admin", password: "other-secret" });
    assert.equal(opened.state.site, "localhost/other-app");
    assert.equal(opened.state.update, false);
    await env.confirm(opened.token, "new");
    state = await vault.status();
    const other = vault.list(state.session, "", "http://localhost/other-app/").find(item => item.id !== srms.id);
    assert.deepEqual(vault.item(state.session, other.id).urls, ["http://localhost/other-app/"]);
    assert.equal(vault.item(state.session, other.id).environment, "local");
    assert.equal(vault.item(state.session, srms.id).password, "srms-secret", "SRMS keeps its password");
    // Each project's dropdown lists only its own login.
    assert.deepEqual(vault.list(state.session, "", "http://localhost/srms-college/login.php").map(item => item.id), [srms.id]);

    // An older whole-server login is offered, but "Save as new" is the default on a project folder.
    state = await vault.saveItem(state.session, state.revision, { ...base, name: "Whole server", urls: ["http://localhost/"], password: "server-secret" });
    const server = vault.list(state.session, "Whole server")[0];
    env.page.url = "http://localhost/shop/login.php";
    opened = await env.prompt({ username: "admin", password: "shop-secret" });
    assert.equal(opened.state.update, true);
    assert.equal(opened.state.preferNew, true);
    assert.deepEqual(opened.state.candidates.map(candidate => candidate.id), [server.id]);
    await env.confirm(opened.token, "new");
    state = await vault.status();
    assert.equal(vault.item(state.session, server.id).password, "server-secret");
    // In a project with its own login plus the whole-server one, the project login sorts first.
    assert.equal(vault.list(state.session, "", "http://localhost/srms-college/").map(item => item.id)[0], srms.id);

    // Two logins with the same username for one project: the user picks which to update.
    state = await vault.saveItem(state.session, state.revision, { ...base, name: "SRMS staging account", urls: ["http://localhost/srms-college/"], password: "srms-second" });
    env.page.url = "http://localhost/srms-college/login.php";
    opened = await env.prompt({ username: "admin", password: "srms-new" });
    assert.equal(opened.state.candidates.length, 2);
    const second = opened.state.candidates.find(candidate => candidate.name === "SRMS staging account");
    await env.confirm(opened.token, "update", second.id);
    state = await vault.status();
    assert.equal(vault.item(state.session, second.id).password, "srms-new");
    assert.equal(vault.item(state.session, srms.id).password, "srms-secret");

    // A change-password form without a username updates a login of this project only.
    env.page.url = "http://localhost/other-app/account.php";
    opened = await env.prompt({ username: "", password: "other-changed", kind: "change" });
    assert.equal(opened.state.kind, "change");
    assert.equal(opened.state.preferNew, false);
    assert.deepEqual(opened.state.candidates.map(candidate => candidate.id), [other.id]);
    assert.equal(opened.state.username, "admin");
    await env.confirm(opened.token, "update", other.id);
    state = await vault.status();
    assert.equal(vault.item(state.session, other.id).password, "other-changed");
    env.page.url = "http://localhost/no-logins/account.php";
    assert.equal((await prompts.capture({ username: "", password: "x-changed", kind: "change" }, env.sender())).available, false);
  } finally { prompts.clear(); delete globalThis.chrome; }
});
