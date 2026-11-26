import { launch, root } from "../scripts/cdp.mjs";

const browser = await launch();
try {
  await browser.developerMode();
  const { id } = await browser.loadExtension(root);
  const popup = await browser.page(`chrome-extension://${id}/src/popup/popup.html`);
  await browser.waitFor(popup.session, `document.querySelector('#master-password') && document.querySelector('#confirm-password')`);
  await browser.evaluate(popup.session, `(() => {
    document.querySelector('#master-password').value = 'correct horse battery staple';
    document.querySelector('#confirm-password').value = 'correct horse battery staple';
    return true;
  })()`);
  await browser.trustedClick(popup.session, "#auth button[type=submit]");
  await browser.waitFor(popup.session, `!document.querySelector('#unlocked').hidden && document.querySelector('#open-side-panel')`);

  const defaults = await browser.evaluate(popup.session, `chrome.runtime.sendMessage({type:'STATUS'}).then(r => r.data.settings)`);
  if (defaults.stayUnlocked !== false || defaults.lockOnScreenLock !== true) throw new Error(`Unsafe new-vault defaults: ${JSON.stringify(defaults)}`);

  const vault = await browser.page(`chrome-extension://${id}/src/vault-ui/vault.html#secrets`);
  await browser.waitFor(vault.session, `!document.querySelector('#app').hidden && document.querySelector('[data-view="secrets"]')`);
  await browser.trustedClick(vault.session, `[data-view="secrets"]`);
  await browser.trustedClick(vault.session, "#add-login");
  await browser.waitFor(vault.session, `document.querySelector('#login-dialog')?.open && document.querySelector('#login-dialog').classList.contains('secret-mode')`);
  await browser.evaluate(vault.session, `(() => {
    document.querySelector('#name').value = 'Browser smoke API';
    document.querySelector('#tags').value = 'test, browser';
    const row = document.querySelector('.custom-field-row');
    const inputs = row.querySelectorAll('input');
    inputs[0].value = 'Token'; inputs[1].value = 'kb_smoke_secret'; inputs[2].checked = true;
    return true;
  })()`);
  await browser.trustedClick(vault.session, "#save");
  await browser.waitFor(vault.session, `!document.querySelector('#login-dialog').open && [...document.querySelectorAll('.item-row .primary')].some(n => n.textContent.includes('Browser smoke API'))`);
  if (process.env.KEYBIT_SCREENSHOT) await browser.shot(vault.session, process.env.KEYBIT_SCREENSHOT);

  if (browser.errors.length) throw new Error(`Browser errors: ${JSON.stringify(browser.errors).slice(0, 2000)}`);
  process.stdout.write("KeyBit browser smoke passed: create, secure defaults, side-panel registration, and developer-secret save.\n");
} finally {
  await browser.close();
}
