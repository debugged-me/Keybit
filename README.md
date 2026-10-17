# KeyBit

A private, local-only Manifest V3 password manager for Helium and Chromium browsers (Chrome, Edge). No backend, account, build step, runtime dependencies, or telemetry.

The original brief is in [CLARK_VAULT_CODEX.md](CLARK_VAULT_CODEX.md). Later instructions renamed the product **KeyBit**, made it work on every site by default with Never as the default auto-lock (1.1), kept same-username logins on different sites apart with a friendlier design (1.2), and added everything in the 1.3 plan: import, Touch ID, 2FA codes, two-step and script sign-ins, projects, secure notes, folder backups, and store readiness (1.3). The 1.4 release added developer tools — open Shadow DOM and cross-origin iframe filling, a form inspector, project environment switching, a command palette, per-site rules, and a local Security Center. The icon source is [icons/keybit.svg](icons/keybit.svg).

## Load or update in Helium

1. Open `helium://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select `/Applications/XAMPP/xamppfiles/htdocs/Keybit/Keybit` (the folder containing `manifest.json`).
   - **If KeyBit is already loaded,** click **Reload** on its card instead. Open tabs pick up the new version automatically.
   - **If you update the folder but forget to reload,** KeyBit's pages show **Finish updating KeyBit** with a **Reload KeyBit** button.
3. Pin KeyBit (puzzle icon → pin), then create or unlock your vault. A fresh install opens a welcome page with these steps.
4. Visit a website and click its username or password field. Choose an account from the **KeyBit** dropdown, or press ↓ then Enter — KeyBit fills it and submits the sign-in for you.
5. Sign in normally on a site the first time. KeyBit offers to save the login, and you confirm.

**Keyboard shortcuts:** ⇧⌘K (Ctrl+Shift+K on Windows) opens the popup. ⌥⇧L (Alt+Shift+L) opens the dropdown on the page's login field. ⇧⌘J (Ctrl+Shift+J) opens the command palette on the page. Change them at `helium://extensions/shortcuts`; ⌘⇧L is reserved by the browser.

**Do not move or rename the KeyBit folder.** Chromium identifies an unpacked extension by its folder, so a moved copy is a different extension with an empty vault. Export a backup first if you need to move it.

KeyBit does not replace Apple's iCloud menu or the browser's own password manager. If another dropdown covers KeyBit's, disable **iCloud Passwords** at `helium://extensions` and turn off **Offer to save passwords** at `helium://password-manager/settings`.

Chromium 127 or newer is required. Helium and Google Chrome pass the full test suite; Edge uses the same engine and package.

## What you get

**Filling**
- The dropdown appears when you click a login field on any site, including a field that already has focus. It follows the field when the page scrolls.
- **Typing narrows the list**, and the account you used last comes first.
- **Two-step sign-ins:** on a username-only page, choosing the account fills it and continues to the password page, where the same account is listed first ("Continue").
- **2FA codes:** add a login's authenticator setup key — type it, paste the `otpauth://` link, or **Scan a QR image** (a screenshot of the site's setup QR, decoded entirely on-device). KeyBit then shows the 6-digit code in the login's details and in the dropdown on code fields, including six one-digit boxes.
- **Cards and IDs:** save a payment card or an ID (name, address, phone) in **Cards & IDs**. Focusing a card field or an address form shows the same dropdown — one click fills the number, expiry, CVV, or the whole address. Cards and IDs aren't site-bound; a masked number and cardholder name are all that ever leave the vault until you fill.
- **Lookalike-site warnings:** if a page's address only *resembles* a saved site — swapped letters, Cyrillic lookalikes, punycode, a one-letter typo — the dropdown leads with a warning instead of filling. Saved credentials never autofill on a different site; this adds the "wait, this isn't right" moment for the near-misses.
- **Sign-up and change-password fields** get a generated password in both fields.
- **Shadow DOM forms:** login fields inside *open* shadow roots — including nested roots and forms injected after page load — get the same detection, dropdown, and save prompts as ordinary fields. Closed shadow roots are never entered.
- **Cross-origin iframes:** a login form inside an iframe matches and fills against *the iframe's own origin*, never the parent page's. Each frame only ever receives credentials bound to its exact origin, and a frame that has navigated or been removed since you asked is refused.
- KeyBit is on for every site by default — there is nothing to switch on.

**Saving**
- KeyBit offers to save after you sign in. This works for normal forms, and for sites that sign in with a script button or the Enter key.
- **Same username, different site, never overwritten.**
  - Different domains, subdomains, ports, and http/https never match.
  - Local servers on the default port (XAMPP, MAMP, WAMP) treat each project folder as its own site. `localhost/srms-college` and `localhost/shop` stay apart.
- **The update card names the exact login it would change.** It offers Update, **Save as new**, or Not now. You pick when several logins share the username.
- **Each login keeps its last 5 passwords**, so a wrong update is easy to undo.

**Developer tools**
- **Command palette** (⇧⌘J / Ctrl+Shift+J): a keyboard-driven overlay on the page — search the vault, fill the matching login, generate a password, inspect the form, switch project environments, open KeyBit or the Security Center, create a note, lock. ↑↓ choose, Enter runs, Escape closes. While the vault is locked it shows only generic commands — never login names, project names, or anything else from the vault.
- **Login form inspector** (popup → site card, or the palette): reports how KeyBit sees the current page, frame by frame — which fields were found, their autocomplete hints, and common problems (missing `autocomplete`, `autocomplete="off"`, readonly/disabled fields, closed shadow roots, cross-origin frames). It lists structure only; typed values never appear.
- **Project environment switcher:** the popup offers environment chips under project logins that have more than one address. Switching keeps the current path, query, and fragment — `localhost/srms-college/registrar?tab` becomes `srms.example.com/registrar?tab` — and production chips are marked and ask for a second click before navigating (Settings can drop the confirmation). A project view's environment rows are editable; saved overrides merge with the addresses derived from the project's logins.
- **Site rules** (popup → ⚙ on the site card, or vault → Site rules): per-origin switches for what KeyBit offers — the site entirely, login suggestions, and save prompts — plus optional "include subdomains" widening. Turning a site off is now a rule, so customized sites appear together in Site rules; resetting a card restores the defaults. Rules are local preferences, not vault data.
- **Right-click menu:** on a link, **KeyBit → Preview with KeyBit**; on an editable field, **Fill with KeyBit**, **Generate password** (fills the field, and both fields on a sign-up form), and **Inspect login form**; on selected text, **Save as secure note** opens the vault's note editor with the text prefilled.

**Passkeys**
- When a site offers to create a passkey, a KeyBit card asks to keep it in the vault. The private key is encrypted with everything else on this device — no account, no sync service.
- Signing in with a saved passkey shows a card naming the site and account. "Not now" or "Use device passkey" hands the call to the browser's built-in handling, as does anything KeyBit can't answer (a credential it doesn't hold, or a site mismatch).
- A passkey only answers the site that created it: KeyBit checks the calling page's origin against the credential's relying party before signing, and the page never sees the private key.
- Passkeys live in their own **Passkeys** sidebar section and in `.kvault` backups. They stay out of CSV export, password health, and the login dropdown — they are not passwords.

**Organising**
- Every login has a site tile; a login can have up to 10 website addresses.
- **Favourites**, **secure notes**, and **projects**. A project's view groups its logins by environment: Production, Staging, Development, Local — and its **Environments** card lets you name the URL for each environment so the popup switcher can jump between them.
- Sort by name, recently used, or recently updated. Search covers logins and notes.
- **Security Center** scores the vault and shows its working — every factor lists its count and points, so "82%" reads as "−12 for two reused logins, +4 for two accounts with 2FA". Metric tiles count strong, weak, reused, duplicate, fresh/aging/old passwords, 2FA and passkey coverage, production logins, and what needs review. All of it is computed on this device; password age is flagged as a prompt to review, not a verdict.
- **Recently deleted** keeps deleted logins and notes for 30 days, then removes them forever. Restore them or empty the bin sooner.
- **Generator:** random (length and character groups) or memorable ("Acorn-Tulip-Rugby-Mango-Spoon7", from the EFF word list). Your choice is remembered for every Generate button and for sign-up fields.
- **Copied passwords and 2FA codes clear themselves from the clipboard after 30 seconds**, if you allow the optional clipboard-read permission. The timer runs in the background, so it works even if you close the popup right after copying — and it only clears when the clipboard still holds what KeyBit copied, so it never erases something else you copied since.

**One app window**
- **Sidebar:** All logins, Favorites, Secure notes, Cards & IDs, Passkeys, Recently deleted, Projects, Security Center, Generator, Import, Backup, and Settings. **Site rules** appears only while a site is customized. A **vault health** card at the bottom shows the Security Center score; click it to open the dashboard.
- **Keyboard:** ⌘K (Ctrl+K on Windows) jumps to search; / does the same when you're not typing.
- **Adding and editing happen in a dialog**, in the app and in the popup:
  - typing `example.com` is enough; KeyBit adds the http/https part;
  - a preview shows where the login will fill;
  - generate and show/hide sit inside the password field, with a strength meter;
  - you're warned about a duplicate username on the same site;
  - you're asked before unsaved typing is discarded.
- **Auto-lock** is the timer icon in the header (hover shows "Auto-lock: Never"). The vault stays unlocked while the browser runs — even across extension reloads — and only locking it yourself, quitting the browser, or an auto-lock timer you set will lock it.
- **Settings:**
  - lock when the computer locks or sleeps (off by default);
  - Touch ID or Windows Hello unlock;
  - change master password;
  - theme: System, Light, or Dark;
  - keyboard shortcuts;
  - whether switching to a production environment asks first.
- **Popup:**
  - shows this site's logins first, and searches all of them;
  - Fill, copy, and 2FA-code buttons;
  - a quick generator, and one-click fill for the current site;
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
- **Portable vault** (Backup → Portable vault): a `.kvault` backup as a single HTML file that opens in any browser — no KeyBit install needed. It contains only the encrypted data; type the master password and it decrypts locally, right in the file. For a lost laptop or an emergency, this is the vault that survives everything.
- **Plain-text CSV export** for moving to another password manager. It is not encrypted, so KeyBit asks before exporting — delete the file when the move is done.
- **Share one item** from its details with **Share…**: a `.kvault` file encrypted with a passphrase you choose for it, with no server involved. Send it any way you like — AirDrop, a message, a USB stick. The recipient merges it into their KeyBit vault like a backup. Anyone holding both the file and the passphrase can read the item; choose a different passphrase than your master password.
- **Recovery kit** (Settings → Recovery kit) splits vault recovery across people you trust — no account, no escrow service:
  - Creating a kit seals an encrypted copy of the vault into `keybit-recovery.kvault` and splits its passphrase into *N* shares (Shamir's scheme, over GF(256)). You pick the threshold: any *M* shares rebuild it; *M−1* shares reveal nothing at all.
  - Keep the file and the shares in different places — for example the file on a USB stick and the shares with family. A share alone, or even the file alone, opens nothing.
  - To recover, the locked screen's **Recover with shares** takes the file plus enough pasted shares, then asks for a new master password.
  - The kit is a snapshot of the vault **as it was when created** — make a fresh kit after big changes, and if a share is ever lost.
  - KeyBit never receives, stores, or transmits shares or kits — splitting and rebuilding happen entirely on your device.
- **No practical limit on logins.** A vault can hold up to 32 MB of login data, about 100,000 typical logins.

Without a backup or recovery kit, forgotten master passwords cannot be recovered.

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
  - per-site rules (origins and on/off switches — no credentials);
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
- **Isolation:** the dropdown, save card, and command palette are extension frames in a closed shadow root. The page's scripts never receive the account list or secrets. Generated passwords and 2FA codes reach the page only when you choose them. While locked, the palette's command list is built without touching vault data — no login or project names can leak into it.
- **Frames:** in iframes, each frame's dropdown is bound to that frame's own origin and document. Credentials are matched and sent only to the one frame whose address matches the login, and stale frames (navigated or removed mid-interaction) fail closed.
- **Site rules:** the per-site switches live outside the vault as origins plus on/off flags — no secrets. They gate suggestions, save prompts, and palette actions the same way everywhere.
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
| `clipboardRead` (optional) | Clear a copied password or code from the clipboard after 30 seconds. Only asked the first time you copy a secret. |
| `contextMenus` | Show KeyBit's right-click entries: fill or generate on a field, inspect a form, save a selection as a note. |

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
  background/          Messages, keep-alive, screen-lock lock, site rules, dropdown modes, save prompts, passkey ceremonies, last-used order, folder backups, palette tokens
  crypto/              Encoding, PBKDF2, AES-GCM, backup parsing, Touch ID key sealing
  vault/               Schema (logins, notes, passkeys, history, 2FA, project environments), storage, CRUD, import, merge, single-item shares, Shamir recovery kits, password change, security report, TOTP, WebAuthn encoding and ECDSA signing
  matching/            Exact-origin matching with project folders, cached
  generator/           Secure random and memorable passwords, remembered preferences, EFF word list
  import/              CSV and Bitwarden JSON parsers
  content/             Login, sign-up, username-step and 2FA field detection incl. open shadow roots; per-frame filling; submit, click and Enter capture; WebAuthn interception and passkey relay
  inline/              Dropdown (accounts, generated password, 2FA codes), save/update card, and passkey consent card
  developer/           Login form inspector page and per-frame form analysis
  command/             Command palette overlay, fuzzy search, and the command registry
  rules/               Per-site rule model (enabled / logins / save / generate / 2FA / cards, subdomain widening)
  ui/                  Shared styles and themes, tiles, icons, session client, sign-in and Touch ID, login dialog
  popup/               Current site, search, fill/copy/2FA, generator, keyboard use
  vault-ui/            App window: lists, projects and environment maps, details, Security Center, site rules, import, backup, settings
store/                 Listing text, templates, and generated store images
scripts/               release.mjs and store-assets.mjs
tests/                 Unit tests, browser tests (Helium/Chrome), restart test, accessibility audit, fixtures
```

## Verification

```sh
npm run check          # lint + type check + unit tests (Node 22+)
npm run test:browser   # UI, 1.3 features, browser restart, and filling regression tests
npm run test:a11y      # axe-core WCAG 2.1 A/AA audit of every screen, light and dark
KEYBIT_BROWSER="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run test:browser
```

All browser tests use isolated temporary profiles, never yours. Version 1.4 passed on Google Chrome 154:

- **Unit tests (71):** RFC 6238 2FA vectors, imports from five managers, duplicate handling, notes/projects/favourites/environments, master password change, merge, Touch ID sealing, passphrases, WebAuthn attestation/assertion signing, Shamir share split/combine and the full recovery-kit chain, lookalike-domain detection (confusables, punycode, typos), portable-viewer encryption, card/identity schema and summary safety, command-palette fuzzy search and locked-state command filtering, site-rule migration and gating, the explainable Security Center score, and 20,000-login scale.
- **Browser checks:**
  - the earlier 1.3 suite;
  - open, nested, and dynamic shadow-root login detection, filling, and save capture — plus closed-root safe failure;
  - same-origin and cross-origin iframe detection and filling bound to the iframe's origin, with navigated and removed frames refused;
  - the form inspector's per-frame report, autocomplete hints, and issue list;
  - environment switching that preserves path/query/fragment, marks production, and asks before navigating there;
  - the command palette: listing, filtering, production marking, on-site fill, and nothing sensitive while locked;
  - per-site rules gating dropdowns and save prompts — editable from the popup and managed in Site rules;
  - the Security Center's score, factor list, and metric tiles;
  - a full browser quit and relaunch.
- **Accessibility:** no WCAG 2.1 A/AA violations reported by axe-core on any screen — including the palette, inspector, and Site rules — in light or dark theme.

Not testable headlessly:
- a real fingerprint for Touch ID (the passkey flow was tested with a virtual authenticator);
- the operating system's screen lock (the setting and its handler are covered);
- the browser's own keyboard routing for shortcuts (the open-dropdown message is tested).

## Current limits

- **Firefox and Safari are not supported.** KeyBit's dropdown security binds each panel to one exact page document (`documentId`). Firefox's extension APIs don't offer that binding the same way, and Firefox isn't installed here for testing.
- **Pages that may need the login added or copied by hand:**
  - closed shadow-DOM forms (open roots work; closed ones are sealed by design);
  - login iframes on sites that block extension content scripts, or whose third-party frame KeyBit cannot reach;
  - browser-internal pages;
  - sites that block embedded extension panels.
- **Not included:** cloud sync and automatic form submission.
