# KeyBit

A private, local-only Manifest V3 password manager for Helium and Chromium browsers. No backend, account, build step, runtime dependencies, telemetry, or intentional network requests.

The original brief is in [CLARK_VAULT_CODEX.md](CLARK_VAULT_CODEX.md). Later instructions renamed the product **KeyBit**, added suggestions in login fields and save-password prompts, made suggestions on by default on every site with Never as the default auto-lock (1.1), and asked for a cleaner, friendlier design that keeps same-username logins on different sites apart (1.2). The icon source is [icons/keybit.svg](icons/keybit.svg).

## Load or update in Helium

1. Open `helium://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select `/Applications/XAMPP/xamppfiles/htdocs/Keybit/Keybit` (the folder containing `manifest.json`). If KeyBit is already loaded, click **Reload** on its card instead. Open tabs pick up the new version automatically. If you update the folder but forget to reload, KeyBit's pages show **Finish updating KeyBit** with a **Reload KeyBit** button. Until then, the old background code keeps running.
3. Pin KeyBit, then create or unlock your vault.
4. Visit a website and click its username or password field. Choose an account from the **KeyBit** dropdown, or press ↓ then Enter. **⌘⇧L** (Ctrl+Shift+L elsewhere) opens the dropdown from the keyboard; change it at `helium://extensions/shortcuts`.
5. Sign in normally. KeyBit offers to save the login, and you confirm.

**Do not move or rename the KeyBit folder.** Chromium identifies an unpacked extension by its folder, so a moved copy is a different extension with an empty vault. If you need to move it, export a backup first and restore it in the new copy.

KeyBit does not replace Apple's iCloud menu or the browser's own password manager. If another dropdown covers KeyBit's, disable **iCloud Passwords** at `helium://extensions` and turn off **Offer to save passwords** at `helium://password-manager/settings`.

Chrome and Edge use `chrome://extensions` and `edge://extensions`. Chromium 127 or newer is required. Helium was tested; Chrome and Edge have not been verified by hand.

## What you get

- **On every site by default.** The dropdown appears when you click a login field, including a field that already has focus. It follows the field when the page scrolls. To turn KeyBit off for one site, use the switch in the toolbar popup. **Sites turned off** appears in the app only while at least one site is off.
- **Same username, different site, never overwritten.** Each website keeps its own logins: different domains, subdomains, ports, and HTTP/HTTPS never match. Local servers on the default port (XAMPP, MAMP, WAMP: `http://localhost/srms-college/` and `http://localhost/shop/`) treat **each project folder as its own site**. Signing in to another project with the same username saves a new login instead of updating the first.
- **Explicit update prompts.** After you sign in with a new password, the card names the login it would change. It offers **Update password**, **Save as new**, or **Not now**. When several logins share the username, you pick which one. If the only match is a broader login, such as a whole-server login seen from a project folder, the card defaults to **Save as new**.
- **Password history.** Each login keeps its last 5 passwords, encrypted. Restore one from the login's details.
- **Strong passwords where you need them.**
  - **Sign-up and change-password fields:** the dropdown offers a generated password, fills both fields with it, and offers to save the login after you submit.
  - **Popup:** a quick generator.
  - **App:** a full generator with length and character options.
- **Weak & reused.** Logins whose password is short or simple, or shared with other logins, are flagged. The check runs on this device.
- **One app window.** The sidebar holds All logins, Weak & reused, Generator, and Backup. Selecting a login opens its details, where you can reveal or copy fields, open the site, edit, or view history. Auto-lock is a timer icon in the header; hover it to see the current setting, such as "Auto-lock: Never", and click it to change it. On narrow windows the sidebar becomes tabs.
- **Adding and editing logins happen in a dialog**, in both the app window and the popup.
  - You can type just `example.com` or `localhost/project`; the full address is filled in.
  - A preview shows exactly where the login will fill, including the project folder on local servers.
  - The name defaults to the site.
  - Generate is built into the password field, with a strength meter.
  - Notes stay hidden until you add them.
  - You're told if that username already exists for the same site.
  - Closing with unsaved typing asks first.
  - From the popup, the dialog starts with the current site filled in.
- **Popup.**
  - Shows the current site's logins first.
  - Search covers all your logins.
  - Fill and copy are icon buttons; hover them for labels.
  - Has the per-site switch and the quick generator.
- **Light and dark themes** follow your system setting.
- **No practical limit on logins.** There is no login count limit. The vault can hold up to 32 MB of login data, roughly 100,000 typical logins (fewer with long notes). Testing with 20,001 logins gave an 8.6 MB encrypted vault: unlock took 0.4 s, search 17 ms, and saving 0.2 s.
- **Encrypted `.kvault` backups.** Restoring checks the backup before asking you to confirm the replacement, and leaves the restored vault locked. A reminder appears when no backup has been exported in 30 days.

Forgotten master passwords cannot be recovered. Restore replaces the current vault; it does not merge.

## Keeping your logins

- **Restarting the browser or the computer keeps everything.** The vault is saved on disk in your browser profile, encrypted. After a restart, KeyBit is locked until you enter the master password. `tests/restart-persistence.mjs` checks this: it quits and relaunches the browser on the same profile, then confirms that the logins, password history, and settings are still there.
- **Removing KeyBit from the browser deletes its vault.** This is how Chromium handles extension storage, and an extension cannot prevent it. Export a backup before removing or reinstalling.
- **A copy installed another way starts empty.** This includes a moved folder or the Chrome Web Store version. Export from the old copy, restore in the new one, then remove the old copy.
- `unlimitedStorage` is requested so that browser storage limits never block a save.

## Security and lifecycle

- Web Crypto derives a non-extractable AES-256 key using PBKDF2-HMAC-SHA-256 with 600,000 iterations and a fresh 16-byte random salt. Every encryption uses a fresh 12-byte IV and a 128-bit GCM tag. The envelope header is authenticated as additional data. Work factors and sizes are validated before decryption. Decoding runs in linear time even on large vaults. See [OWASP's PBKDF2 guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
- `chrome.storage.local` holds the encrypted vault plus a few non-secret values:
  - the sites where you turned KeyBit off;
  - the time of your last backup export;
  - when you snoozed the backup reminder.

  Everything else, including password history, is inside the encrypted vault. Storage access is restricted to trusted extension contexts.
- The master password and key are never persisted or logged. The key and decrypted vault live only in the background worker. Lock discards them, clears open views, and cancels pending operations.
- **The auto-lock setting decides when the vault locks.** Chromium stops an idle extension worker after 30 seconds. While unlocked, the worker makes a no-op extension API call every 20 seconds, which [resets that timer (Chrome 110+)](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle). The keep-alive stops when the vault locks. With Never, the key stays in memory until you lock, quit the browser, or reload the extension. It is never written to storage.
- **Matching:** scheme, exact host, and port must match. On local hosts at the default port, the project folder must match too. No substring or parent-domain matching. Each login stores one website URL.
- **Filling** is always an explicit choice. The worker rechecks the page and targets the original document. Iframes, hidden or read-only inputs, and ambiguous forms are not filled. KeyBit never submits forms.
- **The dropdown and save card** are extension-origin iframes inside a closed shadow root. Account names and usernames render only in those frames. The page's content script never receives the account list, master password, key, or notes. Generated passwords are made inside the extension frame and reach the page only when you choose **Use a strong password**.
- **Save prompts:** submitted credentials are read only during a trusted submit event. Synthetic submissions and cross-origin form actions are ignored. Pending credentials stay in worker memory for at most two minutes. The save card never receives the password. Updating a login always uses the login you confirmed; a change-password form can only update a login for that exact site or project folder. A revision check stops a late prompt from overwriting newer edits.
- **Content Security Policy:** it allows only bundled scripts, styles, and images, and blocks network connections. Only the dropdown and save card are web-accessible. There is no `eval` and no remote code. Icons are fixed inline SVG and user data is never rendered as HTML.
- **Clipboard:** copies happen only when you click Copy and are not cleared automatically. This avoids overwriting something you copied later.

This is a personal-use implementation with automated security checks, not an independently audited password manager. It cannot protect secrets from a compromised browser or OS, or from a malicious website after you intentionally fill that site's credentials.

## Permissions

| Permission | Why KeyBit needs it |
| --- | --- |
| HTTP/HTTPS host access (all sites) | Show the dropdown in login fields and offer to save passwords on any website. The bundled scripts only detect login forms and draw KeyBit's panels. |
| `scripting` | Fill the chosen login into the page, and add KeyBit to tabs already open at install. |
| `storage` | Save the encrypted vault on this device. |
| `unlimitedStorage` | Keep large vaults from hitting the browser's default storage quota. |
| `activeTab` | Let the toolbar popup work on the current tab if you restrict KeyBit's site access in the browser. |
| `clipboardWrite` | Copy a username, password, or generated password when you click Copy. |

The keyboard shortcut uses the manifest's `commands` key and needs no permission. No history, cookies, downloads, webRequest, tabs, or management permission is requested.

## Publishing to the Chrome Web Store

1. Run `npm run package`. It creates `keybit.zip` containing only `manifest.json`, `icons/`, and `src/`.
2. In the Developer Dashboard, describe a single purpose, for example: "KeyBit is a local-only password manager that saves, suggests, and fills logins." Paste the permission reasons from the table above.
3. **Privacy practices.**
   - KeyBit handles authentication information only on the user's device. It does not collect or transmit it, and makes no network requests.
   - Link a hosted copy of [PRIVACY.md](PRIVACY.md) as the privacy policy.
4. **Broad host access** usually means a longer, in-depth review. The justification is that suggestions and save prompts must already be running when the user clicks a login field on any site.
5. **Moving your own logins to the store version.** The store version gets a new extension ID, so it starts with an empty vault. Before uninstalling the unpacked copy:
   1. Export a backup from the unpacked copy.
   2. Install the store version and restore the backup there.
   3. Check your logins, then remove the unpacked copy.

## Source layout

```text
manifest.json          Extension registration, icons, permissions, shortcut, CSP
icons/                 Vector logo and 16/32/48/128px PNG icons
src/
  background/          Message routing, keep-alive while unlocked, per-site switch, dropdown tokens, save/update prompts
  crypto/              Encoding, PBKDF2, authenticated encryption and backup parsing
  vault/               Schema (with password history), encrypted storage, CRUD, session state, weak/reused checks
  matching/            Exact-origin matching with project folders on local servers
  generator/           Cryptographically secure, unbiased password generation
  content/             Login, sign-up and change-password detection, filling, submission capture, panel placement
  inline/              Isolated dropdown (accounts or generated password) and save/update card
  ui/                  Shared styles (light/dark), site tiles, icons, session handling, sign-in form, login rows
  popup/               Current site, search, Fill/copy, per-site switch, quick generator
  vault-ui/            App window: logins and details, weak & reused, generator, backup, sites turned off, auto-lock menu
tests/
  *.test.js            Crypto, matching, generator, vault, history, health, scale and save-prompt tests
  browser-smoke.mjs    Real Helium UI and injection test in a temporary profile
  restart-persistence.mjs  Quits and relaunches the browser to prove the vault persists
  fixtures/            Login, sign-up, dynamic and adversarial form pages
```

## Verification

Local test files under `tests/` are intentionally ignored by Git; these commands use the copies in this workspace.

```sh
npm test               # unit tests (Node 22+)
npm run test:browser   # Helium UI test, then the browser restart test
KEYBIT_TEST_IDLE=1 npm run test:browser   # also waits out a real one-minute auto-lock
```

Set `KEYBIT_BROWSER` to another Chromium executable if needed. The browser tests use isolated temporary profiles, never yours, and print the folder holding their screenshots. The native site-permission prompt still needs a manual check in your own browser.

On October 8, 2026, version 1.2 passed 14 unit tests and 29 browser checks on headless Helium 0.18.3.1 (Chromium 154). The 1.2 checks cover:

- **Same-username protection:** project folders on local servers, the update prompt's choices (Update, Save as new, choose among several), and change-password forms.
- **Password history and health:** history capped at 5, restore, history that can't be injected through a save, and weak or reused flags.
- **Scale:** 20,000 logins, including a backup round trip.
- **Decoder fix:** the stack-overflow fix for large vaults.
- **Sign-up flow:** the generated password filling both fields and the save prompt afterwards.
- **Shortcut:** the shortcut's open-dropdown message (the browser's own key routing is not exercised).
- **Popup:** search, the quick generator, and the add-login dialog (prefill, duplicate warning, default name).
- **Add-login dialog in the app window:** address completion, the "Fills on" preview, the strength meter, and editing.
- **Update banner:** shown when KeyBit's files are newer than the running extension.
- **App window:**
  - the auto-lock icon menu;
  - Sites turned off appearing only when needed;
  - backup reminder, export, and restore;
  - the narrow layout.
- **Restart:** quitting and relaunching the browser.
- **Earlier checks, still covered:**
  - encryption and tampering, encrypted-at-rest storage;
  - fill on plain, email, Bootstrap, controlled, and dynamic forms;
  - exclusion of ambiguous forms and iframes;
  - save prompts across a real 303 redirect;
  - lock cleanup, the 45-second idle check with Never, and cleanup of 1.0's per-site scripts.

Screens were inspected in light and dark themes.

Optional real-framework checks (React, Vue, jQuery) use dependencies outside the extension:

```sh
keybit_test_deps="$(mktemp -d)"
npm install --prefix "$keybit_test_deps" react@19.3.0 react-dom@19.3.0 vue@3.5.43 jquery@4.0.0 esbuild@0.28.2
node tests/build-framework-fixtures.mjs "$keybit_test_deps" "$keybit_test_deps/fixtures"
KEYBIT_FRAMEWORK_FIXTURES="$keybit_test_deps/fixtures" npm run test:browser
```

For hands-on testing, serve `tests/fixtures` with `python3 -m http.server 8765 --bind 127.0.0.1 --directory tests/fixtures` and open `http://127.0.0.1:8765/basic-login.html` or `signup.html`.

## Current limits

- **Forms that may need the login added or copied by hand:**
  - only top-level, conventional input-based forms are supported;
  - forms that bypass the browser's submit event;
  - cross-origin redirects or form actions;
  - username-first multi-step pages;
  - shadow-DOM forms;
  - cross-origin login iframes;
  - browser-internal pages;
  - sites that block embedded extension panels.
- **Save prompts** need an unlocked vault.
- **Project-folder matching** applies only to local servers on the default port. On normal websites one login covers the whole site.
- **Not included:** cloud sync, passkeys, TOTP, recovery, sharing, and automatic form submission.
