// Generates Chrome Web Store images from the real extension: five 1280×800 screenshots, a 440×280 small promo tile,
// and a 1400×560 marquee, in store/assets/. Uses an isolated temporary profile and demo data only.
// Usage: npm run store:assets
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const out = join(root, "store/assets");
await mkdir(out, { recursive: true });
const demo = await readFile(join(root, "store/templates/demo-login.html"));
const server = createServer((req, res) => {
  if (req.url.startsWith("/save-redirect")) { req.resume(); res.writeHead(303, { Location: "/" }); res.end(); return; }
  res.setHeader("Content-Type", "text/html");
  res.end(req.url.startsWith("/welcome") ? "<!doctype html><title>Northwind Console</title><body style='font:16px system-ui;padding:40px;background:#f5f7fb'><h1>Dashboard</h1>" : demo);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const { launch, delay } = await import("../tests/cdp.mjs");
const site = "http://console.northwind.example";
// The demo site appears as "console.northwind.example", without a port, in every label.
const browser = await launch(undefined, [`--host-resolver-rules=MAP console.northwind.example 127.0.0.1:${server.address().port}`]);
const { send, evaluate, waitFor, page, frameTarget } = browser;
const capture = async (session, scale = 2) => (await send("Page.captureScreenshot", { captureBeyondViewport: false }, session)).data;
const viewport = (session, width, height, scale = 1) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false }, session);
const theme = (session, value) => send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] }, session);
async function framed(name, title, subtitle, base64) {
  const frame = await page(pathToFileURL(join(root, "store/templates/frame.html")).href);
  await viewport(frame.session, 1280, 800);
  await evaluate(frame.session, `document.querySelector("#title").textContent = ${JSON.stringify(title)}; document.querySelector("#subtitle").textContent = ${JSON.stringify(subtitle)};
    new Promise(resolve => { const image = document.querySelector("#image"); image.onload = resolve; image.src = "data:image/png;base64,${base64}"; })`);
  await writeFile(join(out, `${name}.png`), Buffer.from(await capture(frame.session), "base64"));
  await send("Target.closeTarget", { targetId: frame.targetId });
}
const password = "store screenshots passphrase";
try {
  await browser.developerMode();
  const { id } = await browser.loadExtension(root);
  const base = `chrome-extension://${id}/src`;
  const app = await page(`${base}/vault-ui/vault.html`);
  let state = (await evaluate(app.session, `chrome.runtime.sendMessage({ type: "CREATE", password: ${JSON.stringify(password)} })`)).data;
  const items = [
    { name: "Northwind Console", urls: [site], username: "admin@northwind.example", password: "Cobalt-Ridge-Lantern-7", environment: "production", project: "Northwind", totp: "JBSWY3DPEHPK3PXP", favorite: true },
    { name: "Northwind Console", urls: [site], username: "dev@northwind.example", password: "u7#Lq9!vRw2$Zk4m", environment: "staging", project: "Northwind" },
    { name: "Northwind local", urls: ["http://localhost/northwind/"], username: "admin", password: "Lp4!rT9#sQ2w", environment: "local", project: "Northwind" },
    { type: "note", name: "Northwind server keys", notes: "ssh deploy@10.0.4.12", project: "Northwind" },
    { name: "GitHub", urls: ["https://github.com"], username: "ada.lovelace", password: "8$hN3m!Qe7&pX2zR", environment: "other", favorite: true },
    { name: "Figma", urls: ["https://www.figma.com"], username: "ada@studio.example", password: "Kite-Velvet-Orbit-3", environment: "other" },
    { name: "AWS Console", urls: ["https://console.aws.amazon.com"], username: "ada-admin", password: "w9!Rt4#Lm2$Qx8&V", environment: "production" },
    { name: "Linear", urls: ["https://linear.app"], username: "ada@studio.example", password: "Tq7$Wm2!Lp9#Xz4e", environment: "other" },
    { name: "Stripe Dashboard", urls: ["https://dashboard.stripe.com"], username: "billing@studio.example", password: "Rv3#Nk8!Qs5$Lt2w", environment: "production" },
    { name: "Vercel", urls: ["https://vercel.com"], username: "ada.lovelace", password: "Zm6!Pq3#Wr8$Lk1x", environment: "other" }
  ];
  for (const item of items) state = (await evaluate(app.session, `chrome.runtime.sendMessage(${JSON.stringify({ type: "SAVE", session: state.session, revision: state.revision, item: { notes: "", ...item } })})`)).data;
  await evaluate(app.session, "chrome.storage.local.set({ lastBackupAt: Date.now() })");

  // 1. The dropdown on a sign-in page.
  const login = await page(`${site}/`);
  await send("Target.activateTarget", { targetId: login.targetId });
  await viewport(login.session, 1120, 700, 2); await theme(login.session, "light");
  await evaluate(login.session, 'document.querySelector("#email").focus()');
  const panel = await frameTarget("/src/inline/panel.html#");
  await theme(panel, "light");
  await waitFor(panel, 'document.querySelectorAll(".account").length === 2');
  await waitFor(login.session, 'document.documentElement.lastElementChild.style.opacity === "1"');
  await delay(300);
  const dropdown = await capture(login.session);
  await framed("1-dropdown", "Your logins, right in the field", "Click a sign-in field and pick an account. Nothing ever leaves your device.", dropdown);

  // 2. A changed password: the card names the login it would update and offers Save as new.
  await evaluate(login.session, 'document.querySelector("#email").dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true})); document.querySelector("#email").value = "admin@northwind.example"; document.querySelector("#password").value = "Maple-Signal-Orbit-4"; document.querySelector("button").click()');
  const card = await frameTarget("/src/inline/save.html#");
  await theme(card, "light");
  await waitFor(card, '!document.querySelector("#save").disabled && document.querySelector("#heading").textContent === "Update this password?"');
  await waitFor(login.session, 'document.readyState === "complete" && !!document.querySelector("#email")');
  await delay(300);
  await framed("2-save", "Saves new passwords, asks before changing one", "KeyBit names the exact login it would update, and keeps old passwords in history.", await capture(login.session));

  // 3. The app window with a login's details and its 2FA code.
  await viewport(app.session, 1120, 700, 2); await theme(app.session, "light");
  await evaluate(app.session, 'location.hash = "#logins"; location.reload()');
  await delay(800);
  await waitFor(app.session, '!document.querySelector("#app").hidden && document.querySelectorAll("#items .login-item").length > 5');
  await evaluate(app.session, '[...document.querySelectorAll("#items .login-item")].find(row => row.textContent.includes("admin@northwind")).click()');
  await waitFor(app.session, '/^\\d{3} \\d{3}$/.test(document.querySelector(".totp-code")?.textContent ?? "")');
  await framed("3-app", "Everything in one calm place", "Search, favorites, secure notes, 2FA codes, and password history.", await capture(app.session));

  // 4. Projects: one project's logins grouped by environment, in dark mode.
  await theme(app.session, "dark");
  await evaluate(app.session, 'document.querySelector(\'[data-view="project:Northwind"]\').click()');
  await waitFor(app.session, 'document.querySelectorAll(".group-heading").length >= 3');
  await evaluate(app.session, '[...document.querySelectorAll("#items .login-item")].find(row => row.textContent.includes("dev@northwind")).click()');
  await waitFor(app.session, '!document.querySelector("#detail").hidden');
  await delay(300);
  await framed("4-projects", "Built for developers", "Local, staging, and production logins for each project, side by side.", await capture(app.session));

  // 5. The toolbar popup.
  await theme(app.session, "light");
  await send("Target.activateTarget", { targetId: login.targetId });
  await evaluate(login.session, `location.href = ${JSON.stringify(`${site}/`)}`);
  await delay(800);
  const tab = (await send("Target.getTargets", { filter: [{ type: "tab", exclude: false }, { exclude: true }] })).targetInfos.find(t => t.url.startsWith(site));
  await send("Extensions.triggerAction", { id, targetId: tab.targetId });
  const popup = await frameTarget("/src/popup/popup.html");
  await theme(popup, "light");
  await waitFor(popup, 'document.querySelectorAll("#matches .login-item").length === 2');
  // A popup can't be resized for capture; it is shown at its natural size.
  await delay(300);
  await framed("5-popup", "One click from the toolbar", "Fill, copy, search every login, or generate a strong password.", await capture(popup));

  // Promo tile (440×280) and marquee (1400×560).
  const logo = (await readFile(join(root, "icons/icon128.png"))).toString("base64");
  for (const [name, width, height, logoSize, titleSize, subtitleSize, withShot] of [["promo-small", 440, 280, 84, 40, 15, false], ["promo-marquee", 1400, 560, 150, 72, 26, true]]) {
    const promo = await page(pathToFileURL(join(root, "store/templates/promo.html")).href);
    await viewport(promo.session, width, height);
    await evaluate(promo.session, `(() => {
      const logo = document.querySelector("#logo"); logo.src = "data:image/png;base64,${logo}"; logo.width = ${logoSize}; logo.height = ${logoSize};
      document.querySelector("h1").style.fontSize = "${titleSize}px";
      const subtitle = document.querySelector("#subtitle"); subtitle.style.fontSize = "${subtitleSize}px"; subtitle.textContent = "Passwords that stay on your device.";
      if (${withShot}) { const shot = document.querySelector("#shot"); shot.hidden = false; shot.style.height = "430px"; shot.src = "data:image/png;base64,${dropdown}"; }
      return Promise.all([...document.images].filter(image => !image.hidden).map(image => image.complete ? null : new Promise(resolve => { image.onload = resolve; })));
    })()`);
    await writeFile(join(out, `${name}.png`), Buffer.from(await capture(promo.session), "base64"));
    await send("Target.closeTarget", { targetId: promo.targetId });
  }
  console.log(`Store images written to ${out}`);
} finally { await browser.close(); server.close(); }
