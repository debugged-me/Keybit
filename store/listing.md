# Chrome Web Store listing: KeyBit

Copy these fields into the Developer Dashboard. Images are in `store/assets/` (regenerate with `npm run store:assets`).

## Store listing

**Name:** KeyBit

**Summary** (132 characters max):
A private password manager that keeps your logins on your device, fills them in one click, and never overwrites the wrong one.

**Category:** Productivity → Tools

**Language:** English

**Description:**

KeyBit is a password manager that runs entirely in your browser. Your logins are encrypted on your device with your master password. There is no account, no server, no sync service, and no tracking.

Fill in one click
• Click a sign-in field and choose an account from KeyBit's dropdown, or press ↓ and Enter.
• Works with two-step sign-ins (username first, password next) and fills 2FA codes from your authenticator secrets.
• Sign-up pages get a strong generated password, filled into both password fields.

Saves without surprises
• After you sign in, KeyBit offers to save the login.
• When a password changes, it names the exact login it would update, and you can Save as new instead.
• Different websites, and different projects on the same local server, never overwrite each other.
• Each login keeps its last five passwords, so a wrong update is easy to undo.

Organised and calm
• Search, favourites, secure notes, and projects that group local, staging, and production logins.
• Weak & reused shows passwords that need attention, checked on your device.
• A generator for random or memorable passwords.
• Light and dark themes.

Yours, on your device
• AES-256-GCM encryption with a key derived from your master password (PBKDF2, 600,000 iterations).
• Optional Touch ID or Windows Hello unlock. Your master password is never stored.
• Locks when your computer locks, plus an optional inactivity timer.
• Encrypted backups, automatic backups to a folder you choose, and import from Chrome, Apple Passwords, Bitwarden, 1Password, LastPass, and more.

KeyBit makes no network requests. Removing it from your browser deletes its vault, so keep a backup.

## Privacy practices

**Single purpose:** KeyBit stores the user's website logins on their device and fills them into sign-in forms.

**Permission justifications:**

| Permission | Justification |
| --- | --- |
| Host permissions (http://\*/\*, https://\*/\*) | KeyBit must already be running when the user clicks a sign-in field on any website, to show the account dropdown and to offer to save a submitted password. Its page scripts only detect sign-in, sign-up, and 2FA fields and draw KeyBit's own panels. |
| scripting | Fills the account the user chose into the page, and adds KeyBit to tabs that were already open when it was installed. |
| storage | Saves the encrypted vault and a few non-secret preferences on the device. |
| unlimitedStorage | Large vaults must never fail to save because of the browser's default storage quota. |
| idle | Locks the vault when the computer's screen locks, as the user expects of a password manager. |
| activeTab | Lets the toolbar popup work on the current tab if the user restricts KeyBit's site access in the browser. |
| clipboardWrite | Copies a username, password, or 2FA code when the user clicks Copy. |

**Remote code:** No. All code is in the package. There is no `eval` and no remote script.

**Data usage:** KeyBit handles authentication information (usernames, passwords, 2FA secrets) and website addresses only on the user's device. It does not collect, transmit, sell, or share any user data. Tick "Authentication information" and "Website content" as handled, and certify that the data is not sold, not used for unrelated purposes, and not used for creditworthiness.

**Privacy policy URL:** a hosted copy of [PRIVACY.md](../PRIVACY.md), with its contact line filled in.

## Notes for the reviewer

1. Install, then create a vault in the welcome page that opens (any 12+ character master password).
2. Open **Add login**, enter `https://example.com`, a username, and a password, and save.
3. Visit any sign-in page on that site, or a local test page, and click the username field: KeyBit's dropdown lists the account.
4. Submit a sign-in form: KeyBit offers to save the login.

KeyBit makes no network requests; the extension pages' Content Security Policy blocks all connections (`connect-src 'none'`).
