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
  if (defaults.stayUnlocked !== false || defaults.lockOnScreenLock !== true || defaults.lockPolicyVersion !== 1) throw new Error(`Unsafe new-vault defaults: ${JSON.stringify(defaults)}`);

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
  const beforeVerification = await browser.evaluate(vault.session, `chrome.runtime.sendMessage({type:'STATUS'}).then(r => r.data.revision)`);
  await browser.trustedClick(vault.session, `[data-view="backup"]`);
  await browser.waitFor(vault.session, `!document.querySelector('#view-backup').hidden && document.querySelector('#verify-backup')`);
  await browser.evaluate(vault.session, `(async () => {
    const exported = await chrome.runtime.sendMessage({type:'EXPORT'});
    const transfer = new DataTransfer();
    transfer.items.add(new File([JSON.stringify(exported.data)], 'smoke.kvault', {type:'application/json'}));
    document.querySelector('#backup-file').files = transfer.files;
    document.querySelector('#backup-password').value = 'correct horse battery staple';
    return true;
  })()`);
  await browser.evaluate(vault.session, `document.querySelector('#verify-backup').scrollIntoView({block:'center'})`);
  await browser.trustedClick(vault.session, "#verify-backup");
  try {
    await browser.waitFor(vault.session, `!document.querySelector('#selected-backup-status').hidden && document.querySelector('#selected-backup-status').textContent.includes('1 developer secret')`);
  } catch (error) {
    const debug = await browser.evaluate(vault.session, `({status:document.querySelector('#selected-backup-status').textContent, hidden:document.querySelector('#selected-backup-status').hidden, message:document.querySelector('#message')?.textContent, messageHidden:document.querySelector('#message')?.hidden, file:document.querySelector('#backup-file').files[0]?.name})`);
    throw new Error(`Backup verification UI failed: ${JSON.stringify(debug)}`, { cause: error });
  }
  const afterVerification = await browser.evaluate(vault.session, `chrome.runtime.sendMessage({type:'STATUS'}).then(r => r.data.revision)`);
  if (afterVerification !== beforeVerification) throw new Error(`Backup verification changed vault revision ${beforeVerification} -> ${afterVerification}`);
  if (process.env.KEYBIT_SCREENSHOT) await browser.shot(vault.session, process.env.KEYBIT_SCREENSHOT);

  if (browser.errors.length) throw new Error(`Browser errors: ${JSON.stringify(browser.errors).slice(0, 2000)}`);
  process.stdout.write("KeyBit browser smoke passed: create, secure defaults, side-panel registration, developer-secret save, and read-only backup verification.\n");
} finally {
  await browser.close();
}
