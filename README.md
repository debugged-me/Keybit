# KeyBit

A private, local-only Manifest V3 password manager for Helium and Chromium browsers. No backend, account, build step, runtime dependencies, telemetry, or intentional network requests.

The original brief is in [CLARK_VAULT_CODEX.md](CLARK_VAULT_CODEX.md). Subsequent instructions renamed the product **KeyBit**, authorized the remaining Version 1 features, added account suggestions beneath login fields and save-password prompts, and (in 1.1) asked for suggestions on every site by default with Never as the default auto-lock. The custom icon source is [icons/keybit.svg](icons/keybit.svg); local PNG variants supply the toolbar and extension-manager icons.

## Load or update in Helium

1. Open `helium://extensions` and enable **Developer mode**. Keep Developer mode enabled for this unpacked extension.
2. Click **Load unpacked** and select `/Applications/XAMPP/xamppfiles/htdocs/Keybit/Keybit` (the folder containing `manifest.json`).
3. If the extension is already loaded, click **Reload** on its card instead. Updating from 1.0 asks Helium to allow access to all HTTP/HTTPS sites; KeyBit needs this to appear in login fields without a per-site approval. Open tabs receive KeyBit automatically after the reload.
4. Pin KeyBit if you want toolbar access, then create or unlock your vault.
5. Open **Open vault → Add login**. Enter the full website URL, username, password, environment, and optional notes.
6. Visit that website and click its username or password field. Select an account from the **KeyBit** dropdown, or press ↓ then Enter. Clicking a field that already has focus also opens the dropdown.

KeyBit is on for every website by default. To turn it off for one site, open the toolbar popup on that site and switch off **Show KeyBit in login fields on this site**. Sites you turned off are listed under **Settings → Websites**, where you can turn them back on.

With KeyBit unlocked, submit a login form normally. A small **Save this password?** card appears at the upper right, including after a same-origin redirect. Choose **Save password** or **Not now**. A changed password for an existing username offers **Update password**; identical saved credentials do not prompt again. The prompt follows form submission; KeyBit cannot verify whether the website accepted the login. It does not submit forms itself. Reload the extension and refresh existing website tabs after updating.

KeyBit does not replace Apple's native/iCloud menu or the browser's built-in password manager. If another dropdown appears over KeyBit's, disable **iCloud Passwords** at `helium://extensions` and turn off **Offer to save passwords** and **Sign in automatically** at `helium://password-manager/settings`. KeyBit never changes other password managers or browser settings automatically.

Chrome and Edge use `chrome://extensions` and `edge://extensions`. Chromium 127 or newer is required. Helium was tested; Chrome/Edge have not been manually verified.

## Included

- Create a vault with a master passphrase (minimum 12 characters); unlock and manually lock.
- AES-256-GCM encryption of the complete vault: names, URLs, usernames, passwords, notes, environments, and settings.
- Add, edit, delete, and search logins; production warnings; copy username/password.
- Configurable secure password generator in the login editor, including length and character groups.
- Exact-origin matching, conservative visible login-form detection, manual autofill, and field suggestions on every site, with a per-site off switch in the popup.
- Save/update prompts after supported login submissions, with explicit confirmation before encrypted storage.
- Auto-lock after 1, 5, 10, 15, or 30 minutes, or Never (the default for new vaults) with an explicit warning. Changes save as soon as you choose them. Existing vaults keep their stored choice.
- Settings split into Security, Websites, Backup, and Privacy tabs.
- Encrypted `.kvault` export and restore. Restore authenticates the backup before displaying a separate replacement confirmation, and leaves the restored vault locked.

Forgotten master passwords cannot be recovered. Keep encrypted backups and remember the master password used for each backup. Import replaces the current vault; it does not merge logins.

## Security and lifecycle

- Web Crypto derives a non-extractable AES-256 key using PBKDF2-HMAC-SHA-256, 600,000 iterations, and a fresh 16-byte random salt. Every encryption uses a fresh 12-byte IV and a 128-bit GCM tag. The canonical envelope header is authenticated as additional data. Work factors and file sizes are validated before decryption. See [OWASP's PBKDF2 guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
- `chrome.storage.local` contains only the encrypted envelope and the non-sensitive list of sites where the user turned KeyBit off. That list reveals those origins, but is separate from the encrypted website list inside credential records. Storage access is restricted to trusted extension contexts; sync/session storage is not used.
- The master password and key are never persisted or logged. Key and decrypted vault references live only in the service worker. Lock discards those references, clears open vault views, and cancels pending operations. JavaScript cannot guarantee physical memory erasure.
- **The auto-lock setting decides when the vault locks.** Chromium stops an idle extension worker after 30 seconds, which in 1.0 discarded the key early. While unlocked, the worker now makes a no-op extension API call every 20 seconds; [since Chrome 110 an extension API call resets the idle timer](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle). The keep-alive stops when the vault locks. This is a deliberate trade-off: with Never, the key stays in worker memory until manual lock, browser exit, or extension reload/update. It is still never written to storage. Open UI checks session status without counting polls as activity. Status checks, messages, and credential operations enforce expiry. A browser/extension restart always requires the master password.
- Scheme, exact hostname, and port must all match. Subdomains, HTTP vs HTTPS, localhost vs IP addresses, and development ports stay separate. There is no substring or parent-domain matching. Version 1 stores one website URL per login.
- Fill is an explicit user action. The worker rechecks the origin and targets the original top-level document ID; the injected function verifies its origin again. Iframes, hidden/disabled/readonly inputs, registration fields marked `new-password`, and ambiguous forms are not filled. Native setters plus bubbling input/change events support controlled forms. No form is submitted by KeyBit.
- Suggestions use an isolated extension-origin iframe in a closed shadow root. Account metadata is rendered in that frame, not the site's DOM. The content script receives no account list, master password, key, or notes. Only the selected username/password are sent to the matching top-level page when the user chooses an account. The panel cannot call general vault-management APIs; its short-lived token is bound to a permitted tab and document.
- On sites where KeyBit is on, a separate content script reads the submitted username/password only during a trusted form-submit event. It ignores registration/change-password fields, ambiguous forms, and cross-origin form actions. Pending credentials stay in worker memory for at most two minutes, never in local/session/sync storage. Dismissal, lock, expiry, turning the site off, site-access revocation, tab closure, or worker shutdown discards them. The save card receives only the username/site and a masked placeholder, never the password. Saving requires a bound extension frame, the active matching tab, an unlocked session, and an unchanged vault revision. Existing item names, URLs, notes, and environments are preserved during updates.
- The CSP allows only bundled scripts/styles/images, blocks connections and form submissions, and exposes only the suggestion and save-panel HTML as web-accessible entry points. The other vault pages are not web-accessible. No `eval`, remote fonts, HTML rendering of user data, or remote runtime libraries are used.
- Clipboard copying is explicit. **Clipboard contents are not automatically cleared**: avoiding clipboard-read access and avoiding overwriting something copied later is more reliable than claiming a timer guarantees clearing. Clipboard history/OS behavior is outside the extension's control.
- Simultaneous edits use a revision check. Storage failures preserve the previous encrypted vault; stale editors must reopen a record before saving.

This is a personal-use implementation with automated security checks, not an independently audited password manager. It cannot protect secrets from a compromised browser/OS or from a malicious website after you intentionally fill that site's credentials.

## Permissions

| Permission | Purpose |
| --- | --- |
| `storage` | Persist the encrypted vault and the list of sites where KeyBit is off. |
| `activeTab` | Inspect/fill the current website after invoking the toolbar popup. |
| `scripting` | Run bundled detection/fill scripts in the top-level document. |
| `clipboardWrite` | Copy a selected username/password after clicking Copy. |
| HTTP/HTTPS host access (all sites) | Show the login-field dropdown and save/update prompts on any website without a per-site approval. |

Host access to all HTTP/HTTPS sites is required as of 1.1, because the dropdown must already be running when you click a login field. The bundled content scripts detect login fields and draw the panels. They never receive the account list, master password, key, or notes, and they make no network requests. You can still restrict KeyBit's site access in the browser's extension details. The popup then asks for access to a site when you turn KeyBit on there. Chromium host permissions do not isolate ports, so KeyBit additionally checks the exact origin, including port, before opening suggestions or filling. No history, cookies, downloads, webRequest, or management permission is requested.

## Source layout

```text
manifest.json          Extension registration, icons, permissions, CSP
icons/                 Original vector logo and 16/32/48/128px PNG icons
src/
  background/          Trusted message routing, keep-alive while unlocked, per-site off switch, pending save prompts
  crypto/              Encoding, PBKDF2, authenticated encryption and backup parsing
  vault/               Schema, encrypted storage adapter, CRUD and session state
  matching/            Exact-origin URL matching
  generator/           Cryptographically secure, unbiased password generation
  content/             Form detection, native setters, submission capture, panel placement
  inline/              Isolated account dropdown and save/update card
  ui/                  Shared session handling, authentication, list controls and styles
  popup/               Current-site matching, Fill, per-site switch, lock and navigation
  vault-ui/            Full vault, search, login editor and password generator
  settings/            Tabbed auto-lock, website, backup and privacy settings
tests/
  *.test.js            Crypto, matching, generator and vault security tests
  browser-smoke.mjs    Real Helium UI/injection test in a temporary browser profile
  fixtures/            Plain, email, Bootstrap-style, dynamic and adversarial form pages
  frameworks/          Optional real React, Vue and jQuery compatibility fixtures
```

## Verification

Local test files under `tests/`, reports, and OS metadata are intentionally ignored by Git. These commands use the test files retained in this workspace; a fresh clone will not include them.

Run dependency-free unit checks with Node 22 or newer:

```sh
npm test
```

Run the browser checks (macOS Helium path is the default):

```sh
npm run test:browser
# Also exercise the real one-minute inactivity timer:
KEYBIT_TEST_IDLE=1 npm run test:browser
```

Set `KEYBIT_BROWSER` to another Chromium executable if needed. The test creates an isolated temporary profile, enables Developer mode, and removes the profile afterward. It includes a 45-second idle wait to prove the vault outlasts worker suspension when auto-lock is Never. It never opens the user's browser profile. Screenshot and encrypted test-backup artifacts remain in the printed temporary directory. The native site-permission prompt itself still needs a manual check in the user's interactive browser.

The optional real-framework checks use dependencies outside the extension:

```sh
keybit_test_deps="$(mktemp -d)"
npm install --prefix "$keybit_test_deps" react@19.3.0 react-dom@19.3.0 vue@3.5.43 jquery@4.0.0 esbuild@0.28.2
node tests/build-framework-fixtures.mjs "$keybit_test_deps" "$keybit_test_deps/fixtures"
KEYBIT_FRAMEWORK_FIXTURES="$keybit_test_deps/fixtures" npm run test:browser
```

On October 7, 2026, testing used headless Helium 0.18.3.1 / Chromium 154. Checks cover encryption and tampering, encrypted-at-rest storage, UI creation/search/edit, generator, matching, manual and inline fill, framework events without submission, ambiguous/iframe exclusion, backup authentication/replacement, actual backup download/file restore, wrong passwords, the actual one-minute inactivity lock, queued-operation cancellation, lock cleanup, permission isolation, and restart/reopen. Real React 19.3.0, Vue 3.5.43, and jQuery 4.0.0 form state received autofill. Popup, inline dropdown, vault, and desktop/narrow settings screenshots were inspected.

Save-prompt checks additionally cover real form submission through a same-origin HTTP 303 redirect, explicit encrypted save, duplicate suppression, update versus dismissal, pending-password cleanup on lock/expiry, stale revision rejection, tab/frame/origin authorization, exclusion of synthetic submissions/new-password fields/cross-origin actions, and upgrading older registered content scripts. Save/update card screenshots were inspected in the isolated browser profile.

On October 8, 2026, the 1.1 changes were tested with the same Helium build. Added checks cover suggestions on every site with no approval step (including a tab opened before install), reopening by clicking an already-focused field, scrolling without closing, the popup's per-site switch, Never as the new-vault default, immediate auto-lock saving despite a newer vault revision, the vault staying unlocked after 45 idle seconds with no KeyBit page or DevTools session open, and cleanup of 1.0's per-site scripts on upgrade. A control build with the keep-alive removed locked in the same idle check.

For interactive testing, serve `tests/fixtures` with `python3 -m http.server 8765 --bind 127.0.0.1 --directory tests/fixtures`, save a dummy credential for `http://127.0.0.1:8765`, and click a field at `http://127.0.0.1:8765/basic-login.html`. Confirm copy actions with dummy values, permission approval, backup download, and the Apple/iCloud coexistence behavior in your own browser.

## Current limits

Only top-level, conventional input-based login forms are supported. Save prompts require an unlocked vault and KeyBit to be on for the site. Forms that bypass the browser's submit event, cross-origin redirects/actions, username-first multi-step pages, shadow-DOM forms, cross-origin login iframes, browser-internal/protected pages, and sites that block embedded extension panels may require manually adding/copying the login. Multiple stored records with the same username require editing the intended record in the vault. No cloud sync, passkeys, TOTP, recovery, sharing, or automatic submission is included.
