# Keybit — Codex Project Brief

## 1. Project Goal

Build a **private, local-first password manager as a Manifest V3 Chromium browser extension**.

Primary target browser:

- Helium Browser

Secondary compatibility targets:

- Google Chrome
- Microsoft Edge
- Other Chromium-based browsers supporting Manifest V3

The first version is for **personal/private use** and will be loaded as an **unpacked extension**. It does **not** need Chrome Web Store publishing.

The primary problem to solve is:

> Detect login forms reliably, securely store credentials in an encrypted local vault, and allow the user to manually autofill saved credentials.

Do not build a cloud service in Version 1.

---

# 2. Core Principles

The implementation must prioritize:

1. **Security**
2. **Simplicity**
3. **Local-first storage**
4. **Minimal permissions**
5. **No telemetry**
6. **No remote code**
7. **No unnecessary dependencies**
8. **Clear separation between UI, vault, crypto, and page-injection logic**
9. **Compatibility with Chromium Manifest V3**
10. **Easy testing in Helium using Load Unpacked**

Do not add unrelated features unless explicitly requested.

---

# 3. Version 1 Scope

Version 1 must support:

- Master password
- Encrypted local vault
- Lock/unlock vault
- Add credential manually
- Edit credential
- Delete credential
- Search credentials
- Save:
  - Name
  - Website URL
  - Username/email
  - Password
  - Notes
- Password generator
- Detect login forms
- Show matching credentials for the current site
- Manual autofill
- Copy username
- Copy password
- Auto-lock after inactivity
- Lock manually
- Basic settings
- Export encrypted backup
- Import encrypted backup

Version 1 must remain **local-only**.

---

# 4. Explicitly Out of Scope for Version 1

Do NOT implement yet:

- Cloud synchronization
- User registration
- Remote API
- CodeIgniter backend
- MySQL backend
- Password sharing
- Team vaults
- Mobile application
- Safari extension
- Firefox extension
- Passkeys
- TOTP/2FA generation
- Biometric unlock
- Account recovery
- Social login
- Browser store publishing
- Automatic credential submission
- Automatic form submission after autofill
- AI features

These may be considered after Version 1 is stable.

---

# 5. Security Requirements

This is a password manager. Security requirements are mandatory.

## 5.1 Never Store Plaintext Credentials

Never persist:

- Master password
- Derived encryption key
- Plaintext passwords
- Plaintext notes
- Plaintext vault contents

Persistent storage must contain only encrypted vault data and the metadata needed to decrypt it.

---

## 5.2 Do Not Invent Cryptography

Use established browser cryptographic APIs or a well-maintained audited library.

Preferred initial implementation:

- Web Crypto API
- AES-256-GCM for authenticated encryption
- PBKDF2-HMAC-SHA-256 for initial key derivation if staying dependency-free

PBKDF2 must use:

- A cryptographically random salt
- A high iteration count appropriate for current browsers
- SHA-256
- 256-bit derived key

The iteration count must be stored with the encrypted vault so it can be upgraded later.

If Argon2id is introduced later, use a reputable maintained implementation and create a migration strategy.

Never implement AES, SHA, PBKDF2, Argon2, or random-number generation manually.

Use:

```javascript
crypto.getRandomValues(...)
```

for cryptographically secure randomness.

---

# 6. Vault Design

Prefer encrypting the **entire logical vault payload as one authenticated encrypted object** rather than encrypting only password fields.

Example logical plaintext before encryption:

```json
{
  "version": 1,
  "items": [
    {
      "id": "uuid",
      "type": "login",
      "name": "SRMS Production",
      "urls": [
        "https://srms.example.com"
      ],
      "username": "admin@example.com",
      "password": "secret",
      "notes": "",
      "createdAt": "ISO-8601",
      "updatedAt": "ISO-8601"
    }
  ],
  "settings": {
    "autoLockMinutes": 10
  }
}
```

Persistent storage should resemble:

```json
{
  "formatVersion": 1,
  "kdf": {
    "name": "PBKDF2",
    "hash": "SHA-256",
    "iterations": 600000,
    "salt": "base64"
  },
  "cipher": {
    "name": "AES-GCM",
    "iv": "base64"
  },
  "ciphertext": "base64"
}
```

The exact iteration count may be benchmarked and adjusted, but it must be intentionally expensive enough to slow offline password guessing without making normal unlocks unusable.

---

# 7. Master Password Behavior

The master password must:

- Never be saved to storage
- Never be logged
- Never be sent over the network
- Never be exposed to content scripts
- Be converted into an encryption key only in the trusted extension context
- Be cleared from memory references when the vault is locked as far as practical in JavaScript

When the extension is locked:

- Decrypted vault data must be discarded
- Derived encryption key references must be discarded
- Autofill must stop working
- Content scripts must not receive credential secrets

---

# 8. Browser Permissions

Follow least privilege.

Start with only the permissions actually required.

Possible Manifest V3 permissions:

```json
{
  "permissions": [
    "storage",
    "activeTab",
    "scripting"
  ]
}
```

Avoid requesting:

```text
<all_urls>
```

unless it is genuinely required for the final autofill design.

If broad host permissions become necessary, explain why before adding them.

Do not request:

- history
- downloads
- cookies
- webRequest
- management

unless a future feature specifically requires them.

---

# 9. Domain Matching Rules

Credential matching must be strict.

Never use unsafe matching such as:

```javascript
url.includes("facebook")
```

Use URL parsing:

```javascript
const url = new URL(input);
const origin = url.origin;
const hostname = url.hostname;
```

Examples:

Saved:

```text
https://facebook.com
```

Must NOT match:

```text
https://facebook-login-security.example.com
```

Initial matching strategy:

1. Parse stored URL.
2. Parse current page URL.
3. Match exact hostname by default.
4. Optionally support subdomain matching only through an explicit helper.
5. Never match based on arbitrary substring checks.

Create a dedicated module for URL/origin matching.

---

# 10. Development Environment Support

The user develops web applications and frequently uses environments such as:

```text
localhost
127.0.0.1
192.168.x.x
development domains
staging domains
production domains
```

The password manager should allow separate credentials for:

```text
SRMS
├── Local
├── Staging
└── Production
```

Credentials must never be automatically mixed across environments.

For development IP addresses, match exact host/IP unless the user explicitly configures an additional URL for the same credential.

---

# 11. Production Warning

Add an optional visual warning for credentials identified as production credentials.

Example:

```text
⚠ PRODUCTION
```

A credential item may optionally contain:

```json
{
  "environment": "production"
}
```

Allowed values:

```text
local
development
staging
production
other
```

The warning is informational only.

Do not prevent autofill.

---

# 12. Autofill Rules

Version 1 should use **manual autofill**.

Desired flow:

```text
Visit website
    ↓
Content script detects login form
    ↓
User opens extension
    ↓
Extension displays matching account(s)
    ↓
User clicks "Fill"
    ↓
Username/password are inserted
```

Do NOT automatically fill credentials immediately when a page loads.

Do NOT automatically submit the form.

This reduces accidental credential exposure and makes debugging easier.

---

# 13. Login Field Detection

The content script should look for standard login fields.

Examples:

```html
<input autocomplete="username">
<input type="email">
<input type="text">
<input type="password" autocomplete="current-password">
```

Detection should consider:

- `type`
- `name`
- `id`
- `autocomplete`
- associated `<label>`
- form relationship
- visibility
- disabled state
- readonly state

Password fields are the strongest login-form signal.

Prefer standards-based fields first.

---

# 14. Autofill Compatibility

When setting values, some modern frameworks require more than:

```javascript
input.value = value;
```

Implement a helper that:

1. Uses the native input value setter where necessary.
2. Dispatches appropriate events.

Potential events:

```text
input
change
```

Do not simulate keystrokes unless necessary.

Test against:

- Plain HTML forms
- Bootstrap forms
- jQuery applications
- React login forms
- Vue login forms if practical

---

# 15. Iframe Safety

Do not blindly inject credentials into arbitrary iframes.

Version 1 should prefer the top-level page.

If iframe support is later added:

- Validate iframe origin
- Match credentials against the iframe origin
- Never assume the parent origin applies to the iframe

---

# 16. Suggested Folder Structure

Use a clean structure similar to:

```text
Keybit/
│
├── manifest.json
│
├── README.md
│
├── src/
│   ├── background/
│   │   └── service-worker.js
│   │
│   ├── content/
│   │   ├── content.js
│   │   ├── form-detector.js
│   │   └── autofill.js
│   │
│   ├── crypto/
│   │   ├── crypto.js
│   │   ├── kdf.js
│   │   └── encoding.js
│   │
│   ├── vault/
│   │   ├── vault.js
│   │   ├── storage.js
│   │   └── schema.js
│   │
│   ├── matching/
│   │   └── url-matcher.js
│   │
│   ├── generator/
│   │   └── password-generator.js
│   │
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.css
│   │   └── popup.js
│   │
│   ├── unlock/
│   │   ├── unlock.html
│   │   ├── unlock.css
│   │   └── unlock.js
│   │
│   ├── vault-ui/
│   │   ├── vault.html
│   │   ├── vault.css
│   │   └── vault.js
│   │
│   └── settings/
│       ├── settings.html
│       ├── settings.css
│       └── settings.js
│
├── icons/
│
└── tests/
    ├── crypto.test.js
    ├── matcher.test.js
    └── generator.test.js
```

The exact structure may be adjusted if there is a clear technical reason.

---

# 17. Extension UI

Keep the interface minimal and clean.

Preferred visual direction:

- Modern
- Compact
- Light mode initially
- Neutral colors
- No unnecessary animations
- Clear locked/unlocked state
- Clear production warning

Example popup:

```text
┌──────────────────────────────┐
│ 🔐 CLARk Vault               │
├──────────────────────────────┤
│ srms.example.com             │
│                              │
│ 👤 admin@example.com         │
│              [ Fill ]        │
│                              │
│ + Add Login                  │
├──────────────────────────────┤
│ 🔒 Lock              ⚙      │
└──────────────────────────────┘
```

Locked state:

```text
┌──────────────────────────────┐
│ 🔐 CLARk Vault               │
├──────────────────────────────┤
│ Master Password              │
│ [••••••••••••••••••]        │
│                              │
│          [ Unlock ]          │
└──────────────────────────────┘
```

---

# 18. Password Generator

Version 1 generator should support:

- Length
- Uppercase
- Lowercase
- Numbers
- Symbols

Example configuration:

```text
Length:        24
Uppercase:     Yes
Lowercase:     Yes
Numbers:       Yes
Symbols:       Yes
```

Use cryptographically secure randomness.

Never use:

```javascript
Math.random()
```

for password generation.

Use:

```javascript
crypto.getRandomValues()
```

Avoid modulo bias where practical.

---

# 19. Clipboard Handling

Copy username/password buttons may be implemented.

For password copying:

- Show a short confirmation
- Never log copied values
- Prefer clearing the clipboard after a configurable delay if technically reliable and not disruptive
- Do not claim the clipboard is guaranteed to be cleared because other applications or OS behavior may interfere

Default clipboard-clear setting can be:

```text
30 seconds
```

but make it configurable.

---

# 20. Auto-Lock

Add an inactivity-based vault lock.

Default:

```text
10 minutes
```

Settings options:

```text
1 minute
5 minutes
10 minutes
15 minutes
30 minutes
Never
```

"Never" should display a warning.

Also lock when:

- User clicks Lock
- Extension/browser lifecycle makes retaining sensitive state unsafe

Do not assume Manifest V3 service workers remain alive indefinitely.

Design state handling around service-worker suspension.

---

# 21. Manifest V3 Service Worker Consideration

Manifest V3 service workers are ephemeral.

Do not rely on a global JavaScript variable surviving forever.

Design the unlock/session mechanism carefully.

Do not persist raw derived encryption keys into normal extension storage.

If temporary session storage is used, confirm its behavior and threat model before implementation.

Document any security compromise clearly.

---

# 22. Storage

Preferred initial persistent storage:

```text
chrome.storage.local
```

Store only:

- Encrypted vault
- KDF metadata
- Encryption metadata
- Non-sensitive extension preferences when appropriate

Do not store decrypted vault objects persistently.

IndexedDB may be used later if vault size or performance requires it.

---

# 23. Encrypted Backup

Version 1 should support exporting an encrypted backup.

Example filename:

```text
Keybit-backup-2026-10-07.cvault
```

The backup must contain the already encrypted vault structure.

Never export plaintext credentials.

Import flow:

1. User chooses backup.
2. Validate file structure.
3. Ask for master password.
4. Attempt authenticated decryption.
5. Reject malformed or tampered data.
6. Ask before replacing the current vault.

Never silently overwrite the current vault.

---

# 24. Error Handling

Use clear user-facing errors.

Examples:

```text
Incorrect master password or corrupted vault.
```

```text
No saved login matches this website.
```

```text
This page does not contain a supported login form.
```

```text
The selected backup is invalid or corrupted.
```

Do not expose stack traces or crypto internals in normal UI.

---

# 25. Logging Rules

Never log:

- Master password
- Derived key
- Passwords
- Decrypted notes
- Complete decrypted vault
- Encryption keys

Development logging may include:

```text
Vault unlocked successfully
3 credentials loaded
Current hostname: example.com
1 matching credential found
```

but never secrets.

---

# 26. Network Rules

Version 1 should make **zero intentional network requests**.

The extension must not:

- Send telemetry
- Call analytics
- Call an API
- Fetch remote JavaScript
- Load remote fonts
- Load remote CSS
- Download external assets at runtime

Bundle all required code/assets locally.

This is important for both security and Manifest V3 compliance.

---

# 27. Content Security Policy

Use a strict extension Content Security Policy.

Do not use:

```javascript
eval()
```

Do not use inline JavaScript if avoidable.

Do not load scripts from CDNs.

All extension JavaScript must be bundled locally.

---

# 28. Recommended Development Order

Implement in the following order.

## Phase 1 — Skeleton

Create:

- Manifest V3 configuration
- Popup
- Options/settings page
- Service worker
- Content script
- Basic styling

Acceptance:

- Extension loads successfully in Helium
- Popup opens
- No console errors
- No unnecessary permissions

---

## Phase 2 — Crypto Layer

Implement:

- Random salt generation
- PBKDF2 key derivation
- AES-256-GCM encryption
- AES-256-GCM decryption
- Base64 encoding helpers

Acceptance:

- Encrypt/decrypt round trip succeeds
- Wrong password fails authentication
- Modified ciphertext fails authentication
- Salt and IV are randomized

---

## Phase 3 — Vault

Implement:

- Create new vault
- Unlock vault
- Lock vault
- Save encrypted vault
- Add login
- Edit login
- Delete login
- Search login

Acceptance:

- Plaintext credentials do not appear in persistent storage
- Vault can be reopened after browser restart
- Wrong master password cannot decrypt vault

---

## Phase 4 — Password Generator

Implement secure password generation.

Acceptance:

- Uses `crypto.getRandomValues`
- User can configure length and character groups
- Generated passwords satisfy selected settings

---

## Phase 5 — URL Matching

Implement strict matching.

Acceptance:

Saved:

```text
https://example.com
```

Matches:

```text
https://example.com/login
```

Does NOT match:

```text
https://example.com.attacker.test
```

Test localhost and IP addresses separately.

---

## Phase 6 — Form Detection

Implement detection of:

- Username fields
- Email fields
- Password fields
- Current-password autocomplete
- Common login form patterns

Acceptance:

Works with a normal HTML login form.

---

## Phase 7 — Manual Autofill

Implement:

```text
Open popup
→ find matching credential
→ click Fill
→ populate login form
```

Acceptance:

- Correct username inserted
- Correct password inserted
- `input` and `change` events fire when needed
- Form is NOT automatically submitted

---

## Phase 8 — Auto-Lock

Implement inactivity timeout and manual lock.

Acceptance:

- Decrypted vault is unavailable after lock
- Autofill fails safely while locked
- User must re-enter master password

---

## Phase 9 — Backup / Restore

Implement encrypted backup and restore.

Acceptance:

- Export contains no plaintext password data
- Valid backup can be restored
- Invalid/tampered backup is rejected

---

## Phase 10 — Hardening

Review:

- Permissions
- CSP
- DOM injection
- XSS
- URL matching
- iframe behavior
- clipboard behavior
- storage
- secret leakage
- console logging
- error handling

Do not add new features during this phase.

---

# 29. Testing Requirements

At minimum create tests for:

## Crypto

- Correct password decrypts
- Incorrect password fails
- Modified ciphertext fails
- Random IV differs between encryptions
- Random salt is generated

## URL Matching

Test:

```text
example.com
www.example.com
login.example.com
example.com.attacker.test
localhost
127.0.0.1
192.168.1.10
```

## Password Generator

Verify:

- Correct length
- Required groups included
- No use of `Math.random`

## Vault

Verify:

- CRUD operations
- Serialization
- Encryption before storage
- Lock clears decrypted state

---

# 30. Test Pages

Create local test fixtures under:

```text
tests/fixtures/
```

Examples:

```text
basic-login.html
email-login.html
bootstrap-login.html
dynamic-login.html
multiple-password-fields.html
```

Use these instead of testing only against third-party websites.

---

# 31. Manual Helium Testing

After implementation:

1. Open:

```text
helium://extensions
```

2. Enable:

```text
Developer mode
```

3. Click:

```text
Load unpacked
```

4. Select the project root containing:

```text
manifest.json
```

5. Pin the extension.

6. Test against local login pages.

7. Inspect:
   - Popup console
   - Service worker console
   - Page console

Do not publish to a store during Version 1 development.

---

# 32. Suggested First-Run Flow

When no vault exists:

```text
Welcome to CLARk Vault
        ↓
Create Master Password
        ↓
Confirm Master Password
        ↓
Create encrypted vault
        ↓
Vault Dashboard
```

Require a reasonable minimum master-password length.

Do not enforce arbitrary complexity rules such as mandatory uppercase + symbol combinations.

Prefer length.

Suggested minimum:

```text
12 characters
```

Display guidance encouraging a long unique passphrase.

---

# 33. Existing Vault Flow

```text
Open extension
      ↓
Vault locked
      ↓
Enter master password
      ↓
Decrypt
      ↓
Show credentials for current website
```

---

# 34. Add Credential Flow

```text
+ Add Login
      ↓
Name
Website
Username
Password
Environment
Notes
      ↓
Save
      ↓
Encrypt entire vault
      ↓
Persist encrypted vault
```

---

# 35. Data Model

Suggested credential model:

```javascript
{
  id: "uuid",
  type: "login",
  name: "SRMS Production",
  urls: [
    "https://srms.example.com"
  ],
  username: "admin@example.com",
  password: "...",
  notes: "",
  environment: "production",
  createdAt: "2026-10-07T00:00:00.000Z",
  updatedAt: "2026-10-07T00:00:00.000Z"
}
```

Use UUIDs generated with:

```javascript
crypto.randomUUID()
```

when available.

---

# 36. Code Quality Rules

Codex should follow these rules:

- Keep modules small and focused.
- Avoid giant files.
- Avoid duplicate code.
- Use descriptive function names.
- Validate all external input.
- Escape user-controlled text before inserting it into HTML.
- Prefer DOM APIs over string-based HTML injection.
- Do not use `innerHTML` with untrusted data.
- Do not silently catch security-related errors.
- Add concise comments where security decisions are not obvious.
- Do not over-engineer.
- Do not add frameworks unless they provide a clear benefit.
- Prefer vanilla HTML/CSS/JavaScript for Version 1.
- Keep the project easy to inspect manually.

---

# 37. Security Review Checklist

Before calling Version 1 complete, verify:

- [ ] Master password is never stored
- [ ] Master password is never logged
- [ ] Derived key is never persisted in plaintext
- [ ] Vault is encrypted at rest
- [ ] Notes are encrypted
- [ ] Usernames are encrypted
- [ ] Website list is encrypted inside vault payload
- [ ] AES-GCM authentication failures are handled
- [ ] Random salt is used
- [ ] Random IV is used
- [ ] Secure random generator is used
- [ ] No `Math.random()` for passwords/crypto
- [ ] No remote JavaScript
- [ ] No analytics
- [ ] No telemetry
- [ ] No external API requests
- [ ] No plaintext export
- [ ] Strict URL matching is implemented
- [ ] Phishing-like hostname tests pass
- [ ] No automatic form submission
- [ ] No credentials sent to content scripts until user explicitly requests Fill
- [ ] Iframes are handled conservatively
- [ ] CSP is restrictive
- [ ] Permissions are minimal
- [ ] Console logs contain no secrets
- [ ] UI rendering does not introduce XSS
- [ ] Tampered backup files are rejected
- [ ] Vault locks correctly

---

# 38. Definition of Done — Version 1

Version 1 is complete when the user can:

1. Load the extension unpacked in Helium.
2. Create a master password.
3. Create an encrypted vault.
4. Add a login.
5. Close/restart the browser.
6. Unlock the vault again.
7. Visit a matching website.
8. See the stored account in the extension popup.
9. Click Fill.
10. Have username and password populate correctly.
11. Lock the vault.
12. Confirm credentials are inaccessible while locked.
13. Generate a secure password.
14. Export an encrypted backup.
15. Restore the encrypted backup.

All of the above must work without any backend server.

---

# 39. Future Version 2 Ideas

Only after Version 1 is stable:

- Better saved-login prompt
- Detect changed passwords
- Multiple URLs per credential
- Improved subdomain policies
- Secure notes
- Card records
- Identity records
- Better vault organization
- Tags/folders
- Dark mode
- Optional Argon2id migration
- Security audit improvements

---

# 40. Future Version 3 Ideas

Potential later architecture:

```text
                   ┌──────────────────┐
                   │ Desktop Vault UI │
                   └────────┬─────────┘
                            │
                     encrypted data
                            │
             ┌──────────────┴──────────────┐
             │                             │
      ┌──────▼───────┐              ┌──────▼───────┐
      │ Chromium     │              │ Mobile App   │
      │ Extension    │              │ Future       │
      └──────────────┘              └──────────────┘
```

Possible future encrypted sync:

```text
Client
  ↓
Encrypt locally
  ↓
Encrypted blob
  ↓
Server
```

The future server should never receive plaintext vault contents or the master password.

---

# 41. Future Sync Backend

If sync is ever added, a future API may use:

- PHP
- CodeIgniter 3
- MySQL/MariaDB

Possible endpoints:

```text
POST /api/vault/sync
GET  /api/vault
POST /api/device/register
POST /api/device/revoke
```

The server should store only encrypted vault blobs and synchronization metadata.

Do not implement these endpoints in Version 1.

---

# 42. Codex Working Instructions

When working on this project:

1. Read this entire file first.
2. Do not skip security requirements.
3. Work one phase at a time.
4. Before making a major architectural change, explain the reason.
5. Keep changes minimal and auditable.
6. Do not introduce a backend unless explicitly requested.
7. Do not add cloud services.
8. Do not add telemetry.
9. Do not use remote dependencies at runtime.
10. Do not implement custom cryptographic primitives.
11. If uncertain about a security-sensitive design decision, stop and explain the tradeoff before implementing it.
12. Preserve working behavior when adding later phases.
13. Add tests for security-critical helpers.
14. Keep the extension loadable as an unpacked Manifest V3 extension throughout development.

---

# 43. First Codex Task

Start with **Phase 1 only**.

Create the initial Manifest V3 extension skeleton with:

```text
manifest.json
src/background/service-worker.js
src/content/content.js
src/popup/popup.html
src/popup/popup.css
src/popup/popup.js
src/settings/settings.html
src/settings/settings.css
src/settings/settings.js
README.md
```

Requirements:

- No framework
- Vanilla HTML/CSS/JavaScript
- No network requests
- No remote dependencies
- Minimal permissions
- Clean modern popup
- Locked-state placeholder UI
- Settings page placeholder
- Content script that detects whether the page contains a password field, but does NOT read or store its value
- Service worker that starts without errors

After Phase 1:

1. Show the final folder structure.
2. Explain each file briefly.
3. Confirm the extension can be loaded with **Load unpacked**.
4. Do not start Phase 2 until requested.

---

# 44. Suggested Initial Prompt for Codex

Copy/paste this into Codex after placing this Markdown file in the project root:

```text
Read CLARK_VAULT_CODEX.md completely and follow it as the authoritative project specification.

Implement Phase 1 only.

Do not implement encryption, credential storage, autofill, cloud sync, or any future phase yet.

Keep the extension Manifest V3 compatible with Helium, Chrome, and Edge. Use vanilla HTML, CSS, and JavaScript, minimal permissions, no telemetry, no remote dependencies, and no network requests.

After implementation, review the generated code for permission problems, Manifest V3 issues, unsafe DOM usage, and console errors. Then show me the folder structure and tell me exactly how to load it as an unpacked extension in Helium.
```

---

# 45. Project Name

Working name:

```text
CLARk Vault
```

This can be renamed later without changing the architecture.
