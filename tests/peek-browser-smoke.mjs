import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { delay, launch, root } from "../scripts/cdp.mjs";

const server = createServer((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("content-security-policy", "frame-ancestors 'none'");
  if (request.url === "/target") {
    response.end("<!doctype html><title>Preview target</title><button id='inside'>Inside preview</button>");
    return;
  }
  if (request.url === "/login") {
    response.end("<!doctype html><title>Protected login</title><input type='password'>");
    return;
  }
  response.end("<!doctype html><title>Peek source</title><a id='safe' href='/target'>Safe preview</a><a id='login' href='/login'>Protected login</a>");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;

const browser = await launch();
try {
  await browser.developerMode();
  const extension = await browser.loadExtension(join(root, "peek"), "/src/background.js");
  const workerSession = await browser.attach(extension.worker.targetId);
  const source = await browser.page(`${origin}/`);
  await browser.waitFor(source.session, "Boolean(document.querySelector('#safe'))");

  async function modifiedClick(selector, modifiers) {
    const point = await browser.evaluate(source.session, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await browser.send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1, modifiers }, source.session);
    }
  }

  await modifiedClick("#safe", 8);
  await browser.waitFor(source.session, "Boolean(document.querySelector('[data-peekbit]')?.shadowRoot?.querySelector('iframe'))");
  await browser.waitFor(workerSession, "chrome.declarativeNetRequest.getSessionRules().then(r => r.length === 1)");
  const rule = await browser.evaluate(workerSession, "chrome.declarativeNetRequest.getSessionRules().then(r => r[0])");
  if (!rule.condition.tabIds?.length || !rule.condition.requestDomains?.includes("127.0.0.1")) {
    throw new Error(`Preview rule is not scoped to the source tab and target host: ${JSON.stringify(rule)}`);
  }

  await browser.waitFor(source.session, "Boolean(document.querySelector('[data-peekbit]').shadowRoot.querySelector('iframe').contentDocument?.querySelector('#inside'))");
  await browser.evaluate(source.session, "document.querySelector('[data-peekbit]').shadowRoot.querySelector('iframe').contentDocument.querySelector('#inside').focus()");
  await browser.key(source.session, "Escape", 27);
  await browser.waitFor(source.session, "!document.querySelector('[data-peekbit]')");
  await browser.waitFor(workerSession, "chrome.declarativeNetRequest.getSessionRules().then(r => r.length === 0)");

  await modifiedClick("#login", 8);
  await browser.waitFor(workerSession, "chrome.declarativeNetRequest.getSessionRules().then(r => r.length === 0)");
  await browser.waitFor(source.session, "!document.querySelector('[data-peekbit]')");
  let allTargets = [];
  let loginTargets = [];
  for (let attempt = 0; attempt < 30 && !loginTargets.length; attempt++) {
    allTargets = (await browser.send("Target.getTargets")).targetInfos;
    loginTargets = allTargets.filter(target => target.url === `${origin}/login`);
    if (!loginTargets.length) await delay(100);
  }
  if (!loginTargets.length) throw new Error(`Protected login was not promoted to a top-level window: ${JSON.stringify(allTargets.map(target => [target.type, target.url]))}`);

  if (browser.errors.length) throw new Error(`Browser errors: ${JSON.stringify(browser.errors).slice(0, 2000)}`);
  process.stdout.write("PeekBit browser smoke passed: safe preview, tab/host-scoped rule, iframe Escape cleanup, and protected-route handoff.\n");
} finally {
  await browser.close();
  server.close();
}
