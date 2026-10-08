// Accessibility audit (axe-core, WCAG 2.1 A and AA) of KeyBit's screens in light and dark themes.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { launch, fixtureServer, root, delay } from './cdp.mjs';

const axeSource = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const { server, url } = await fixtureServer();
const browser = await launch();
const { send, evaluate, waitFor, page, frameTarget } = browser;
const password = 'a unique a11y test passphrase';
const results = [];
async function audit(session, name, context = 'document') {
  for (const theme of ['light', 'dark']) {
    // Reduced motion is emulated so axe samples settled colors — a theme flip otherwise
    // catches elements mid-transition (e.g. a button background animating to dark accent).
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }] }, session);
    await delay(150);
    await evaluate(session, axeSource + ';true');
    const violations = await evaluate(session, `axe.run(${context}, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }).then(r => r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 4).map(n => n.target.join(' ') + (n.any[0]?.message ? ' — ' + n.any[0].message : '')) })))`);
    results.push({ name: `${name} (${theme})`, violations });
  }
  await send('Emulation.setEmulatedMedia', { features: [] }, session);
}
try {
  await browser.developerMode();
  const { id } = await browser.loadExtension(root);
  const base = `chrome-extension://${id}/src`;
  const app = await page(`${base}/vault-ui/vault.html#welcome`);
  await audit(app.session, 'Welcome / create vault');
  await evaluate(app.session, `chrome.runtime.sendMessage({ type: 'CREATE', password: ${JSON.stringify(password)} })`);
  let state = (await evaluate(app.session, `chrome.runtime.sendMessage({ type: 'STATUS' })`)).data;
  for (const item of [
    { name: 'Fixture', urls: [url], username: 'test-user@example.test', password: 'Fixture-secret-1!xyz', notes: '', environment: 'production', project: 'SRMS', totp: 'JBSWY3DPEHPK3PXP' },
    { name: 'Weak', urls: ['https://weak.example.test'], username: 'weak', password: 'admin123', notes: '', environment: 'other' },
    { type: 'note', name: 'Server keys', notes: 'ssh', project: 'SRMS' },
    { type: 'passkey', name: 'Alice Fixture', rpId: new URL(url).hostname, credentialId: 'a2V5Yml0LWFsbHktdGVzdA',
      userName: 'alice@fixture.test', userHandle: 'YWxpY2U', privateKey: 'fixture-pkcs8-bytes', signCount: 3, lastUsedAt: new Date().toISOString() }]) {
    state = (await evaluate(app.session, `chrome.runtime.sendMessage(${JSON.stringify({ type: 'SAVE', session: state.session, revision: state.revision, item })})`)).data;
  }
  await evaluate(app.session, 'location.hash = "#logins"; location.reload()');
  await delay(800);
  await waitFor(app.session, '!document.querySelector("#app").hidden && document.querySelectorAll("#items .login-item").length === 2');
  await evaluate(app.session, 'document.querySelector("#items .login-item").click()');
  await waitFor(app.session, 'document.querySelector("#detail").open');
  await audit(app.session, 'All logins + details');
  // The detail dialog makes the page inert; close it so the sidebar clicks below reach.
  await evaluate(app.session, 'document.querySelector("#detail").close()');
  for (const view of ['health', 'generator', 'import', 'backup', 'settings', 'project:SRMS', 'notes', 'passkeys']) {
    await evaluate(app.session, `document.querySelector('[data-view="${view}"]').click()`);
    await delay(300);
    await audit(app.session, `View: ${view}`);
  }
  await evaluate(app.session, 'document.querySelector("#items .login-item").click()');
  await waitFor(app.session, 'document.querySelector("#detail").open');
  await audit(app.session, 'Passkey details');
  await evaluate(app.session, 'document.querySelector("#detail").close()');
  await evaluate(app.session, `document.querySelector('[data-view="logins"]').click()`);
  await waitFor(app.session, 'document.querySelectorAll("#items .login-item").length === 2');
  await evaluate(app.session, 'document.querySelector("#items .login-item").click()');
  await waitFor(app.session, 'document.querySelector("#detail").open && !!document.querySelector("#share-item")');
  await evaluate(app.session, 'document.querySelector("#share-item").click()');
  await waitFor(app.session, 'document.querySelector("#share-dialog").open');
  await audit(app.session, 'Share dialog');
  await evaluate(app.session, 'document.querySelector("#share-dialog").close(); document.querySelector("#detail").close()');
  await evaluate(app.session, `document.querySelector('[data-view="logins"]').click(); document.querySelector("#add-login").click()`);
  await waitFor(app.session, 'document.querySelector("#login-dialog").open');
  await audit(app.session, 'Add login dialog');
  await evaluate(app.session, 'document.querySelector("#login-dialog").close(); document.querySelector("#autolock").click()');
  await audit(app.session, 'Auto-lock menu');
  await evaluate(app.session, 'document.querySelector("#autolock").click(); document.querySelector(\'[data-view="settings"]\').click(); document.querySelector("#create-kit").click()');
  await waitFor(app.session, 'document.querySelector("#kit-dialog").open');
  await audit(app.session, 'Recovery kit dialog');
  await evaluate(app.session, 'document.querySelector("#kit-dialog").close()');
  const site = await page(`${url}/basic-login.html`);
  await send('Target.activateTarget', { targetId: site.targetId });
  await evaluate(site.session, 'document.querySelector("#user").focus()');
  const panel = await frameTarget('/src/inline/panel.html#');
  await waitFor(panel, 'document.querySelectorAll(".account").length === 1');
  await audit(panel, 'In-page dropdown');
  const tab = (await send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] })).targetInfos.find(t => t.url.startsWith(`${url}/basic-login.html`));
  await send('Extensions.triggerAction', { id, targetId: tab.targetId });
  const popup = await frameTarget('/src/popup/popup.html');
  await waitFor(popup, 'document.querySelectorAll("#matches .login-item").length === 1');
  await audit(popup, 'Popup');
  await evaluate(site.session, 'document.querySelector("#user").value = "new-person"; document.querySelector("#pass").value = "new-secret-pass"; document.querySelector("button").click()');
  const card = await frameTarget('/src/inline/save.html#');
  await waitFor(card, '!document.querySelector("#save").disabled');
  await audit(card, 'Save card');
  const pkSite = await page(`${url}/webauthn.html`);
  await send('Target.activateTarget', { targetId: pkSite.targetId });
  await evaluate(pkSite.session, 'document.querySelector("#create").click()');
  const pkCard = await frameTarget('/src/inline/passkey.html#');
  await waitFor(pkCard, '!document.querySelector("#save").disabled');
  await audit(pkCard, 'Passkey card');
  await evaluate(pkCard, 'document.querySelector("#dismiss").click()');
  await evaluate(app.session, `chrome.runtime.sendMessage({ type: 'LOCK' })`);
  await waitFor(app.session, '!!document.querySelector("#master-password")');
  await audit(app.session, 'Unlock');
  await evaluate(app.session, 'document.querySelector("#recover-instead").click()');
  await waitFor(app.session, 'document.querySelector("#recover-dialog").open');
  await audit(app.session, 'Recover dialog');
  await evaluate(app.session, 'document.querySelector("#recover-dialog").close()');
  let total = 0;
  for (const { name, violations } of results) {
    total += violations.length;
    console.log(`${violations.length ? '✖' : '✔'} ${name}${violations.length ? '' : ': no violations'}`);
    for (const v of violations) console.log(`   ${v.impact} ${v.id}: ${v.help}\n     ${v.targets.join('\n     ')}`);
  }
  console.log(total ? `\n${total} violation group(s).` : '\nPASS: no WCAG 2.1 A/AA violations found by axe-core on any screen, in light or dark theme.');
  process.exitCode = total ? 1 : 0;
} finally { await browser.close(); server.close(); }
