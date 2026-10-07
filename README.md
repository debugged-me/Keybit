# KeyBit

A private, local-only Manifest V3 password manager for Helium and Chromium browsers (Chrome, Edge). No backend, account, build step, runtime dependencies, telemetry, or network requests.

The original brief is in [CLARK_VAULT_CODEX.md](CLARK_VAULT_CODEX.md). Later instructions renamed the product **KeyBit**, made it work on every site by default with Never as the default auto-lock (1.1), kept same-username logins on different sites apart with a friendlier design (1.2), and added everything in the 1.3 plan: import, Touch ID, 2FA codes, two-step and script sign-ins, projects, secure notes, folder backups, and store readiness (1.3). The icon source is [icons/keybit.svg](icons/keybit.svg).

## Load or update in Helium

1. Open `helium://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select `/Applications/XAMPP/xamppfiles/htdocs/Keybit/Keybit` (the folder containing `manifest.json`).
   - **If KeyBit is already loaded,** click **Reload** on its card instead. Open tabs pick up the new version automatically.
   - **If you update the folder but forget to reload,** KeyBit's pages show **Finish updating KeyBit** with a **Reload KeyBit** button.
3. Pin KeyBit (puzzle icon → pin), then create or unlock your vault. A fresh install opens a welcome page with these steps.
4. Visit a website and click its username or password field. Choose an account from the **KeyBit** dropdown, or press ↓ then Enter.
5. Sign in normally. KeyBit offers to save the login, and you confirm.

**Keyboard shortcuts:** ⇧⌘K (Ctrl+Shift+K on Windows) opens the popup. ⌥⇧L (Alt+Shift+L) opens the dropdown on the page's login field. Change them at `helium://extensions/shortcuts`; ⌘⇧L is reserved by the browser.

**Do not move or rename the KeyBit folder.** Chromium identifies an unpacked extension by its folder, so a moved copy is a different extension with an empty vault. Export a backup first if you need to move it.

KeyBit does not replace Apple's iCloud menu or the browser's own password manager. If another dropdown covers KeyBit's, disable **iCloud Passwords** at `helium://extensions` and turn off **Offer to save passwords** at `helium://password-manager/settings`.

Chromium 127 or newer is required. Helium and Google Chrome pass the full test suite; Edge uses the same engine and package.

## What you get

**Filling**
- The dropdown appears when you click a login field on any site, including a field that already has focus. It follows the field when the page scrolls.
- **Typing narrows the list**, and the account you used last comes first.
- **Two-step sign-ins:** on a username-only page, KeyBit fills the username. On the password page that follows, the same account is listed first ("Continue").
- **2FA codes:** add a login's authenticator setup key. KeyBit then shows the 6-digit code in the login's details and in the dropdown on code fields, including six one-digit boxes.
- **Sign-up and change-password fields** get a generated password in both fields.
- To turn KeyBit off for one site, use the switch in the toolbar popup.

**Saving**
- KeyBit offers to save after you sign in. This works for normal forms, and for sites that sign in with a script button or the Enter key.
- **Same username, different site, never overwritten.**
  - Different domains, subdomains, ports, and http/https never match.
  - Local servers on the default port (XAMPP, MAMP, WAMP) treat each project folder as its own site. `localhost/srms-college` and `localhost/shop` stay apart.
- **The update card names the exact login it would change.** It offers Update, **Save as new**, or Not now. You pick when several logins share the username.
- **Each login keeps its last 5 passwords**, so a wrong update is easy to undo.

**Organising**
- Every login has a site tile; a login can have up to 10 website addresses.
- **Favourites**, **secure notes**, and **projects**. A project's view groups its logins by environment: Production, Staging, Development, Local.
- Sort by name, recently used, or recently updated. Search covers logins and notes.
- **Weak & reused** lists passwords that need attention. The check runs on this device.
- **Generator:** random (length and character groups) or memorable ("Acorn-Tulip-Rugby-Mango-Spoon7", from the EFF word list). Your choice is remembered for every Generate button and for sign-up fields.

**One app window**
- **Sidebar:** All logins, Favorites, Secure notes, Projects, Weak & reused, Generator, Import, Backup, and Settings. **Sites turned off** appears only while a site is off.
- **Adding and editing happen in a dialog**, in the app and in the popup:
  - typing `example.com` is enough; KeyBit adds the http/https part;
  - a preview shows where the login will fill;
  - generate and show/hide sit inside the password field, with a strength meter;
  - you're warned about a duplicate username on the same site;
  - you're asked before unsaved typing is discarded.
- **Auto-lock** is the timer icon in the header (hover shows "Auto-lock: Never").
- **Settings:**
  - lock when the computer locks or sleeps (on by default);
  - Touch ID or Windows Hello unlock;
  - change master password;
  - theme: System, Light, or Dark;
  - keyboard shortcuts.
- **Popup:**
  - shows this site's logins first, and searches all of them;
  - Fill, copy, and 2FA-code buttons;
  - a quick generator, and the per-site switch;
  - / searches, ↑↓ move, Enter fills.
- **Notices** appear at the top centre.

**Getting logins in and keeping them**
- **Import** from Chrome, Helium, Edge, Apple Passwords, 1Password, LastPass, Dashlane, and others (CSV), or Bitwarden (CSV or unencrypted JSON).
  - A preview shows what will be added. Duplicates are skipped.
  - An entry without a website is kept as a secure note, not dropped.
- **Encrypted `.kvault` backups:**
  - **Export** downloads a copy.
  - **Automatic backup** writes a fresh encrypted copy to a folder you choose (for example iCloud Drive or Dropbox) after every change.
  - **Restore** can **merge** (adds logins, newer copies win, nothing deleted) or **replace** the vault.
  - A reminder appears when there's no backup from the last 30 days.
- **No practical limit on logins.** A vault can hold up to 32 MB of login data, about 100,000 typical logins.

Forgotten master passwords cannot be recovered.

## Keeping your logins

- **Restarting the browser or the computer keeps everything.**
  - The vault is saved on disk in your browser profile, encrypted.
  - After a restart, KeyBit is locked until you unlock it.
  - `tests/restart-persistence.mjs` checks this by quitting and relaunching the browser.
- **Removing KeyBit from the browser deletes its vault.** This is how Chromium handles extension storage. Keep a backup; automatic folder backup does this for you.
- **A copy of KeyBit installed another way starts empty**, for example a moved folder or the Web Store version. Restore or merge your backup there.

## Speed and lightness

On a 20,000-login vault, measured in headless Helium against version 1.2:

| | 1.2 | 1.3 |
| --- | --- | --- |
| Vault status check (pages poll this) | ~23 ms | 0.3 ms |
| Matching logins for a page | ~50 ms | ~7 ms |
| Dropdown appearing after a click | ~440 ms | ~40 ms |
| KeyBit woken by ordinary page loads | Yes | No |

What changed:
- **Cached checks:** status no longer reads the whole vault from storage, and saved addresses are parsed once.
- **Quiet pages:** pages no longer ask KeyBit about pending save prompts on every load; KeyBit tells the one tab that needs it instead.
- **Less background work:**
  - the dropdown and pages poll less often;
  - the word list loads only when a memorable password is made;
  - field detection only scans the field types that can match.

## Security and lifecycle

- **Encryption:** Web Crypto derives a non-extractable AES-256 key using PBKDF2-HMAC-SHA-256 with 600,000 iterations and a fresh 16-byte salt. Every encryption uses a fresh 12-byte IV. The envelope header is authenticated. Decoding runs in linear time on large vaults. See [OWASP's PBKDF2 guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
- **What is encrypted:** everything inside the vault, including notes, 2FA secrets, password history, projects, and favourites.
- **What `chrome.storage.local` also holds** (none of it secret):
  - sites turned off;
  - last-used times keyed by random login IDs;
  - generator and theme choices;
  - backup timestamps;
  - the Touch ID record.

  The automatic-backup folder handle lives in IndexedDB.
- **The master password** is never stored. The key exists only in the background worker's memory while unlocked.
- **Locking happens:**
  - when the auto-lock time passes;
  - when you click Lock;
  - **when the computer's screen locks or it sleeps** (on by default);
  - when the browser quits or KeyBit reloads.

  While unlocked, a tiny keep-alive stops Chromium suspending the worker early.
- **Touch ID / Windows Hello:**
  - Turning it on creates a passkey for KeyBit.
  - Its PRF output, released only after the fingerprint or face check, seals the vault key.
  - Changing the master password or replacing the vault turns it off.
  - The master password is never stored.
- **Matching and filling:**
  - Scheme, exact host, and port must match, plus the project folder on local servers.
  - Filling is always your choice. The worker rechecks the page and targets the original document.
  - KeyBit never submits forms.
- **Isolation:** the dropdown and save card are extension frames in a closed shadow root. The page's scripts never receive the account list or secrets. Generated passwords and 2FA codes reach the page only when you choose them.
- **Save prompts:**
  - Submitted values are read only on a trusted submit, click, or Enter, and held in memory for at most two minutes.
  - Updates always use the login you confirmed.
  - A change-password form can only update a login for that exact site or project folder.
- **Content Security Policy:** bundled code only, with network connections blocked. Icons are fixed inline SVG, and user data is never rendered as HTML.

This is a personal-use implementation with automated security checks, not an independently audited password manager.

## Permissions

| Permission | Why KeyBit needs it |
| --- | --- |
| HTTP/HTTPS host access (all sites) | Show the dropdown in login fields and offer to save passwords on any website. |
| `scripting` | Fill the chosen login, and add KeyBit to tabs already open at install. |
| `storage` | Save the encrypted vault on this device. |
| `unlimitedStorage` | Keep large vaults from hitting the storage quota. |
| `idle` | Lock when the computer's screen locks. |
| `activeTab` | Let the popup work on the current tab if you restrict KeyBit's site access. |
| `clipboardWrite` | Copy a username, password, or code when you click Copy. |

None of these shows an extra warning beyond site access. No history, cookies, downloads, webRequest, tabs, or management permission.

## Publishing

1. Run `npm run release -- 1.3.1`. It sets the version everywhere, runs lint, type checking and unit tests, and builds `keybit-1.3.1.zip` containing only `manifest.json`, `icons/`, and `src/`.
2. Run `npm run store:assets` to regenerate the store screenshots and promo images in `store/assets/` from the real extension.
3. Copy the listing text, permission justifications, and privacy answers from [store/listing.md](store/listing.md).
4. Host [PRIVACY.md](PRIVACY.md) with its contact line filled in, and link it as the privacy policy.
5. **Move your own logins to the store version.** The store copy has a new extension ID and starts empty:
   1. Export a backup from the unpacked copy.
   2. Restore or merge it into the store copy.
   3. Then remove the unpacked copy.
6. **Edge Add-ons** accepts the same zip.

## Source layout

```text
manifest.json          Registration, permissions, shortcuts, CSP
icons/                 Logo and PNG icons
src/
  background/          Messages, keep-alive, screen-lock lock, site switch, dropdown modes, save prompts, last-used order, folder backups
  crypto/              Encoding, PBKDF2, AES-GCM, backup parsing, Touch ID key sealing
  vault/               Schema (logins, notes, history, 2FA), storage, CRUD, import, merge, password change, health, TOTP
  matching/            Exact-origin matching with project folders, cached
  generator/           Secure random and memorable passwords, remembered preferences, EFF word list
  import/              CSV and Bitwarden JSON parsers
  content/             Login, sign-up, username-step and 2FA field detection; filling; submit, click and Enter capture
  inline/              Dropdown (accounts, generated password, 2FA codes) and save/update card
  ui/                  Shared styles and themes, tiles, icons, session client, sign-in and Touch ID, login dialog
  popup/               Current site, search, fill/copy/2FA, generator, keyboard use
  vault-ui/            App window: lists, projects, details, import, backup, settings
store/                 Listing text, templates, and generated store images
scripts/               release.mjs and store-assets.mjs
tests/                 Unit tests, browser tests (Helium/Chrome), restart test, accessibility audit, fixtures
.github/workflows/     CI: lint, type check, unit, browser, and accessibility tests on Chrome
```

## Verification

```sh
npm run check          # lint + type check + unit tests (Node 22+)
npm run test:browser   # UI test, 1.3 feature test, then the browser restart test
npm run test:a11y      # axe-core WCAG 2.1 A/AA audit of every screen, light and dark
KEYBIT_BROWSER="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run test:browser
```

All browser tests use isolated temporary profiles, never yours. On October 8, 2026, version 1.3 passed:

- **Unit tests (22):** RFC 6238 2FA vectors, imports from five managers, duplicate handling, notes/projects/favourites, master password change, merge, Touch ID sealing, passphrases, and 20,000-login scale.
- **Browser checks (43, on both Helium 0.18.3.1 and Google Chrome 154):**
  - the earlier suite;
  - welcome and import;
  - projects with live 2FA codes;
  - Touch ID with a virtual authenticator, and master password change;
  - automatic folder backup, written by the background worker;
  - merge restore;
  - script-button and Enter sign-ins, two-step sign-ins, and 2FA fills (one field and six boxes);
  - dropdown filtering and recently-used order;
  - popup keyboard use;
  - a full browser quit and relaunch.
- **Accessibility:** no WCAG 2.1 A/AA violations reported by axe-core on any screen, in light or dark theme.

Not testable headlessly:
- a real fingerprint for Touch ID (the passkey flow was tested with a virtual authenticator);
- the operating system's screen lock (the setting and its handler are covered);
- the browser's own keyboard routing for shortcuts (the open-dropdown message is tested).

## Current limits

- **Firefox and Safari are not supported.** KeyBit's dropdown security binds each panel to one exact page document (`documentId`). Firefox's extension APIs don't offer that binding the same way, and Firefox isn't installed here for testing.
- **Pages that may need the login added or copied by hand:**
  - shadow-DOM forms;
  - cross-origin login iframes;
  - browser-internal pages;
  - sites that block embedded extension panels.
- **Not included:** passkey storage for websites, cloud sync, sharing, and automatic form submission.
