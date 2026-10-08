# Arc-Style Peek Integration — Codex Specification

## 1. Purpose

Extend the existing Chromium Manifest V3 password-manager extension with an **Arc Browser-style Peek feature**.

This must remain inside the **same existing extension/project folder**.

Do **not** create a separate browser extension project.

The goal is:

> When the user activates Peek on a link, show the target page in a floating overlay above the current page instead of immediately opening a new tab.

The original page must remain visible underneath.

The Peek feature should feel similar to Arc Browser Peek while remaining compatible with:

- Helium Browser
- Google Chrome
- Microsoft Edge
- Other Chromium-based Manifest V3 browsers where possible

---

# 2. Important Security Boundary

The extension already contains a password manager.

Peek requires broader access to webpages than a password manager ideally should.

Therefore, even though both features live in the same extension, they must be treated as **separate security domains in code**.

The Peek module must NEVER have direct access to:

- Master password
- Derived encryption key
- Decrypted vault
- Saved passwords
- Saved notes
- Full credential objects
- Vault decryption functions that expose secrets
- Internal password-manager state

The password-manager module must NEVER send credential secrets to Peek code.

Conceptually:

```text
Existing Extension
│
├── Password Manager
│   ├── crypto
│   ├── vault
│   ├── autofill
│   └── popup
│
└── Peek
    ├── link detection
    ├── overlay
    ├── iframe preview
    ├── fallback handling
    └── settings
```

Shared code should be limited to safe utilities such as DOM helpers, URL parsing helpers, settings helpers, and theme tokens.

---

# 3. Core Peek Behavior

Desired flow:

```text
Current webpage
      ↓
User activates Peek on a link
      ↓
Floating preview opens over current page
      ↓
Target website loads inside the preview
      ↓
User can interact with the preview
      ↓
User closes Peek
      ↓
Original page remains exactly where it was
```

Do not navigate the original tab when Peek succeeds.

Do not open a new normal tab when Peek succeeds.

---

# 4. Visual Target

```text
┌───────────────────────────────────────────────┐
│ Original webpage                             │
│                                               │
│      ╭─────────────────────────────────╮      │
│      │ example.com              ↗  ×   │      │
│      │─────────────────────────────────│      │
│      │                                 │      │
│      │       Live webpage preview      │      │
│      │                                 │      │
│      │                                 │      │
│      ╰─────────────────────────────────╯      │
│                                               │
└───────────────────────────────────────────────┘
```

The background page should remain visible with a subtle dimmed backdrop.

---

# 5. Version 1 Scope

Implement:

- Modifier-click Peek trigger
- Link interception
- Floating modal overlay
- Live iframe preview
- Close button
- Open in normal tab button
- Escape key closes Peek
- Click outside closes Peek
- Loading state
- Error/fallback state
- Configurable trigger
- Configurable Peek size
- Remember settings locally
- Safe URL validation
- Restore page scrolling when Peek closes
- Multiple Peek prevention
- Basic accessibility
- Graceful fallback when iframe embedding fails

Do not build browser-source modifications yet.

---

# 6. Explicitly Out of Scope

Do NOT implement yet:

- Native Chromium WebContents embedding
- Helium source-code modifications
- Browser fork
- Tab-strip modifications
- Native window compositor changes
- Arc Spaces clone
- Arc sidebar clone
- Split view
- Picture-in-picture web pages
- Mobile support
- Safari support
- Firefox-specific implementation
- Cloud synchronization
- AI summarization inside Peek

---

# 7. Technical Limitation

An extension cannot perfectly reproduce Arc's native implementation.

The initial implementation will use:

```text
Injected overlay
      ↓
iframe
      ↓
Target webpage
```

Some websites will block iframe embedding through `Content-Security-Policy: frame-ancestors` or `X-Frame-Options`.

This is expected.

Do not attempt to bypass these protections.

Do not strip CSP.

Do not modify security headers.

Do not proxy third-party pages through another server.

Instead use a safe fallback.

---

# 8. Fallback Behavior

When a page cannot be shown inside Peek:

```text
╭────────────────────────────────────╮
│ Preview unavailable                │
│                                    │
│ This website does not allow        │
│ embedded previews.                 │
│                                    │
│ [ Open in New Tab ]     [ Close ]  │
╰────────────────────────────────────╯
```

Do not silently redirect the current page.

Do not automatically open a new tab without user interaction.

---

# 9. Trigger Behavior

Default trigger:

```text
Shift + Click
```

Reason:

- Does not replace normal clicking
- Easy to discover
- Avoids hijacking Command+Click behavior on macOS

Make the trigger configurable.

Possible options:

```text
Shift + Click
Option + Click
Alt + Click
Ctrl + Shift + Click
Long Press
```

Do not override normal Command+Click / Ctrl+Click unless explicitly configured.

---

# 10. Link Eligibility

Peek should only trigger for valid navigational links.

Support:

```html
<a href="https://example.com/page">
```

and relative links:

```html
<a href="/login">
```

Resolve relative links using:

```javascript
new URL(href, document.baseURI)
```

Do not Peek:

- `javascript:` URLs
- `data:` URLs
- `mailto:` URLs
- `tel:` URLs
- empty links
- hash-only navigation
- browser-internal URLs
- extension URLs
- links explicitly marked as downloads

Allow only `http:` and `https:` in Version 1.

---

# 11. Existing Folder Integration

Do not create a new root project.

Add Peek modules inside the existing extension.

Suggested structure:

```text
existing-extension/
│
├── manifest.json
├── README.md
├── CLARK_VAULT_CODEX.md
├── PEEK_INTEGRATION_CODEX.md
│
├── src/
│   ├── background/
│   │   └── service-worker.js
│   ├── content/
│   │   ├── content.js
│   │   ├── form-detector.js
│   │   └── autofill.js
│   ├── crypto/
│   ├── vault/
│   ├── matching/
│   ├── generator/
│   ├── popup/
│   ├── unlock/
│   ├── vault-ui/
│   ├── settings/
│   └── peek/
│       ├── peek-controller.js
│       ├── peek-link-handler.js
│       ├── peek-overlay.js
│       ├── peek-frame.js
│       ├── peek.css
│       ├── peek-settings.js
│       └── peek-utils.js
│
└── tests/
    ├── crypto.test.js
    ├── matcher.test.js
    ├── generator.test.js
    ├── peek-url.test.js
    └── peek-trigger.test.js
```

Adjust paths to match the existing project.

Do not restructure working password-manager code unnecessarily.

---

# 12. Manifest Strategy

Before changing permissions, inspect the current `manifest.json`.

Preserve all existing password-manager behavior.

Add only permissions required by Peek.

Prefer optional host permissions when technically practical.

Avoid immediately adding:

```json
"host_permissions": ["<all_urls>"]
```

without reviewing alternatives.

---

# 13. Permission Tradeoff

Automatic Peek interception on arbitrary websites generally requires content scripts to run on those websites.

If broad host access becomes necessary:

1. Explain why.
2. Use it only for Peek-related page access.
3. Keep password-manager secrets isolated.
4. Never expose decrypted vault state globally.
5. Keep communication message-based and explicitly scoped.

If possible, prefer:

```json
"optional_host_permissions": [
  "http://*/*",
  "https://*/*"
]
```

and request access through a clear user action/settings flow.

---

# 14. Content Script Separation

Do not merge all logic into one giant content script.

Preferred pattern:

```text
content.js
│
├── password manager bootstrap
└── peek bootstrap
```

Example:

```javascript
initPasswordManagerFeatures();
initPeekFeature();
```

Do not pass vault objects between them.

---

# 15. Peek Overlay DOM

Create one root container with a unique prefix.

Example IDs/classes:

```text
cv-peek-host
cv-peek-root
cv-peek-backdrop
cv-peek-window
cv-peek-toolbar
cv-peek-frame
cv-peek-close
cv-peek-open-tab
```

Avoid common class names such as `modal`, `container`, `button`, or `overlay`.

---

# 16. Shadow DOM

Prefer mounting the Peek UI inside a Shadow DOM.

Example:

```javascript
const host = document.createElement("div");
host.id = "cv-peek-host";

const shadow = host.attachShadow({ mode: "closed" });
```

Benefits:

- Prevent host-site CSS from breaking Peek
- Prevent Peek styles from affecting the host page
- Reduce selector collisions

If closed Shadow DOM makes development difficult, open Shadow DOM may be used initially.

---

# 17. Overlay Structure

Recommended:

```text
cv-peek-host
└── shadowRoot
    ├── backdrop
    └── peek-window
        ├── toolbar
        │   ├── site title
        │   ├── hostname
        │   ├── open-in-tab
        │   └── close
        ├── loading
        └── iframe
```

---

# 18. Sizing

Default desktop size:

```text
width: min(1100px, 90vw)
height: min(760px, 85vh)
```

Responsive:

```text
width: 94vw
height: 88vh
```

Do not render outside the viewport.

---

# 19. Visual Style

Preferred style:

- Rounded corners
- Subtle shadow
- Dimmed backdrop
- Compact toolbar
- Minimal visual noise
- Short smooth transitions
- Respect reduced-motion preference

Do not copy Arc trademarks, logos, or proprietary visual assets.

---

# 20. Animation

Suggested:

```text
Opening:
opacity 0 → 1
scale 0.97 → 1

Closing:
opacity 1 → 0
scale 1 → 0.98
```

Target duration:

```text
120–180ms
```

Respect:

```css
@media (prefers-reduced-motion: reduce)
```

---

# 21. Background Scroll Lock

When Peek opens:

- Prevent background scrolling
- Preserve current scroll position

When Peek closes:

- Restore original overflow state
- Do not forcibly scroll the page

---

# 22. Closing Peek

Peek must close when:

- User clicks ×
- User presses Escape
- User clicks backdrop

Optional setting:

```text
Close on backdrop click
```

Default: enabled.

---

# 23. Open in Full Tab

Toolbar button:

```text
Open in Tab ↗
```

Use a namespaced message:

```javascript
chrome.runtime.sendMessage({
  type: "PEEK_OPEN_TAB",
  url
});
```

The background service worker must validate the URL again before opening it.

Do not trust content-script input blindly.

---

# 24. Service Worker Messages

Use dedicated Peek message types:

```text
PEEK_OPEN_TAB
PEEK_GET_SETTINGS
PEEK_SAVE_SETTINGS
```

Keep password-manager messages separately namespaced.

Never let Peek handlers accept vault commands.

---

# 25. Message Validation

Validate every message before acting.

Reject malformed messages.

Never execute arbitrary commands received from a content script.

---

# 26. Iframe Creation

Create the iframe dynamically only after valid user activation.

Example:

```javascript
const frame = document.createElement("iframe");
frame.src = safeUrl;
frame.referrerPolicy = "strict-origin-when-cross-origin";
```

Do not use `srcdoc` with untrusted HTML.

---

# 27. Iframe Security

Respect the browser Same-Origin Policy.

Do not attempt to read cross-origin iframe contents.

Do not attempt origin bypass tricks.

Do not weaken browser security settings.

Do not strip CSP or X-Frame-Options.

---

# 28. Loading State

Before load:

```text
Loading example.com…
```

After approximately 8–12 seconds:

```text
Still loading…
[ Open in New Tab ]
```

Do not automatically close Peek.

A normal iframe `load` event does not guarantee the page successfully rendered, so blocked-frame detection is best-effort only.

---

# 29. Navigation Inside Peek

Allow normal navigation inside the iframe where browser policies permit it.

For Version 1, display the initially requested hostname.

Do not fake cross-origin navigation tracking if it cannot be observed safely.

---

# 30. Forms Inside Peek

Do not automatically invoke password-manager autofill inside the Peek iframe in Version 1.

Treat Peek and autofill as separate flows initially.

Future integration can be reviewed separately.

---

# 31. Password Manager Isolation

Critical rule:

The Peek iframe must never receive password-manager secrets automatically.

Never do:

```javascript
frame.contentWindow.postMessage(vaultData, "*");
```

Never do:

```javascript
frame.contentWindow.postMessage(password, "*");
```

Do not inject credentials merely because Peek contains a login form.

---

# 32. Host Page Security

Treat all webpage content as untrusted.

The host page must not be able to:

- Read Peek extension settings directly
- Access password-manager secrets
- Invoke privileged extension operations arbitrarily
- Manipulate extension internal state

Do not expose sensitive state through DOM attributes.

---

# 33. DOM Rendering

Use `textContent` for page-derived content.

Avoid `innerHTML` with untrusted website strings.

---

# 34. Multiple Peek Instances

Allow only one Peek window at a time in Version 1.

If another Peek is activated while one is open:

```text
Replace current Peek content
```

or close and reopen.

Do not stack unlimited overlays.

---

# 35. Nested Peek

Do not support nested Peek inside Peek in Version 1.

---

# 36. Settings Integration

Do not create a second settings page if the extension already has one.

Add a Peek section:

```text
Peek
────────────────────────────

Enable Peek              [✓]

Trigger:
[ Shift + Click ▼ ]

Preview Size:
○ Compact
● Default
○ Large

Close on backdrop click  [✓]

Show loading indicator   [✓]
```

Store non-sensitive Peek settings in `chrome.storage.local`.

---

# 37. Default Settings

```json
{
  "peekEnabled": true,
  "peekTrigger": "shift-click",
  "peekSize": "default",
  "peekBackdropClose": true,
  "peekLoadingIndicator": true
}
```

---

# 38. Accessibility

Support:

- Escape to close
- Visible focus states
- `role="dialog"`
- `aria-modal="true"`
- Descriptive button labels
- Logical tab order

When Peek opens, move focus into Peek.

When Peek closes, restore focus to the source link when practical.

---

# 39. Prevent Page Interference

Only call `event.preventDefault()` when:

- Peek is enabled
- Trigger matches
- Target is an eligible link
- URL is valid
- Peek is actually going to open

Do not block ordinary link behavior unnecessarily.

---

# 40. Respect Existing Link Behavior

Do not intercept:

- download links
- non-http(s) links
- right click
- middle click by default
- drag operations
- hash-only navigation
- links when configured modifier does not match

---

# 41. Development App Support

Peek should work with:

```text
localhost
127.0.0.1
192.168.x.x
custom local domains
development servers
staging systems
production systems
```

Allow both HTTP and HTTPS for development.

---

# 42. New Files to Add

Prefer adding:

```text
src/peek/
├── peek-controller.js
├── peek-link-handler.js
├── peek-overlay.js
├── peek-frame.js
├── peek.css
├── peek-settings.js
└── peek-utils.js
```

Tests:

```text
tests/
├── peek-url.test.js
└── peek-trigger.test.js
```

Modify existing files only where necessary:

```text
manifest.json
src/content/content.js
src/background/service-worker.js
src/settings/*
```

---

# 43. Module Responsibilities

## peek-controller.js

- Initialization
- Open/close orchestration
- State
- Replacing current Peek
- Connecting handler and overlay

## peek-link-handler.js

- Detecting configured modifier clicks
- Finding closest anchor
- Validating eligibility
- Resolving URL
- Calling controller

## peek-overlay.js

- Shadow DOM host
- Backdrop
- Dialog
- Toolbar
- Close interactions
- Focus management
- Accessible UI

## peek-frame.js

- Creating iframe
- Loading states
- Timeout state
- URL assignment
- Frame cleanup

## peek-settings.js

- Defaults
- Loading settings
- Saving settings
- Validating setting values

## peek-utils.js

- URL parsing
- Supported-protocol checks
- Link eligibility
- Hostname display

Must contain no password-manager logic.

---

# 44. Integration Order

## Phase P1 — Inspect Existing Extension

Before coding:

1. Read `manifest.json`.
2. Read existing content-script architecture.
3. Read service-worker message handlers.
4. Read current settings implementation.
5. Identify current permissions.
6. Identify how modules are loaded/bundled.

Do not overwrite working password-manager behavior.

## Phase P2 — Peek UI Only

Implement the overlay and open/close behavior without external URLs.

Acceptance:

- Floating dialog appears
- Background dims
- Close button works
- Escape works
- Backdrop close works
- Shadow DOM isolates styles
- Existing password manager still works

## Phase P3 — Safe Link Trigger

Implement Shift+Click on valid links.

Acceptance:

- Normal click stays normal
- Shift+Click opens Peek
- `mailto:` ignored
- `javascript:` ignored
- download links ignored

## Phase P4 — Iframe Preview

Load validated HTTP/HTTPS URL in iframe.

Acceptance:

- Original page remains
- Target loads inside Peek
- Closing Peek returns to original page
- No new tab is created

## Phase P5 — Fallback UX

Add `Open in New Tab`.

## Phase P6 — Settings

Add Peek settings into existing settings UI.

## Phase P7 — Hardening

Review:

- permissions
- URL validation
- XSS
- message validation
- password-manager isolation
- CSS isolation
- event listener cleanup
- memory leaks
- accessibility

---

# 45. Testing Requirements

Allowed URLs:

```text
https://example.com
http://example.com
http://localhost:8080
http://127.0.0.1:3000
http://192.168.1.5/admin
```

Rejected:

```text
javascript:alert(1)
data:text/html,...
mailto:test@example.com
tel:+123456
chrome://settings
helium://extensions
file:///etc/passwd
```

Test trigger behavior for:

```text
normal click
Shift+Click
Alt+Click
Ctrl+Click
Meta+Click
middle click
right click
```

Only the configured trigger should activate Peek.

---

# 46. Manual Browser Tests

Test in Helium first.

Then optionally test Chrome and Edge.

Test against:

- Simple static website
- GitHub
- Google search result
- Local application
- SRMS development page
- A site that blocks iframe embedding

Do not assume every site can be embedded.

---

# 47. Security Review Checklist

Before calling Peek complete:

- [ ] No password-manager secret is accessible from Peek modules
- [ ] Peek code never receives decrypted vault objects
- [ ] Only HTTP/HTTPS URLs are allowed
- [ ] `javascript:` URLs are rejected
- [ ] `data:` URLs are rejected
- [ ] Browser-internal URLs are rejected
- [ ] Link text uses `textContent`
- [ ] No unsafe `innerHTML` with page-derived data
- [ ] Messages are namespaced
- [ ] Messages are validated
- [ ] Background worker revalidates URLs
- [ ] No CSP/X-Frame-Options bypass
- [ ] No remote proxy workaround
- [ ] No automatic new-tab fallback
- [ ] No automatic credential autofill inside Peek
- [ ] Shadow DOM or equivalent style isolation works
- [ ] Event listeners are cleaned up
- [ ] Iframe is removed on close
- [ ] Background scroll state is restored
- [ ] Escape closes Peek
- [ ] Focus handling works
- [ ] Existing password manager still works
- [ ] Existing autofill still works
- [ ] Existing vault locking still works

---

# 48. Definition of Done

Peek Version 1 is complete when:

1. Existing password-manager features still work.
2. User visits a webpage.
3. User Shift+Clicks an eligible link.
4. Original page remains loaded underneath.
5. Floating Peek overlay appears.
6. Target page loads inside the overlay where embedding is allowed.
7. No normal tab is created automatically.
8. User can close Peek with ×.
9. User can close Peek with Escape.
10. User can open target in a full tab manually.
11. Unsupported URLs are ignored safely.
12. Sites that cannot embed fail gracefully.
13. No vault/password secrets are exposed to Peek code.
14. Peek can be disabled in Settings.

---

# 49. Future Improvements

After Version 1 is stable:

- Draggable Peek window
- Resizable Peek
- Back/forward controls
- Refresh
- Copy URL
- Multiple size presets
- Remember last size
- Link hover preview indicator
- Optional long-press trigger
- Per-site Peek enable/disable
- Better blocked-frame detection
- Native-looking macOS animation

Do not implement these before Version 1 works.

---

# 50. Future Native Helium Integration

If iframe restrictions become too limiting, the next architectural step is a Helium/Chromium source modification using native browser web contents.

Conceptually:

```text
Chromium Tab
│
├── Current WebContents
│
└── Temporary Peek WebContents
```

That could provide a much closer Arc-style experience without iframe embedding restrictions.

This is outside the current extension integration.

---

# 51. Codex Rules

Codex must:

1. Read the existing project before editing.
2. Preserve current password-manager functionality.
3. Use the existing project structure where reasonable.
4. Keep Peek code modular.
5. Never expose vault secrets to Peek.
6. Do not replace existing crypto.
7. Do not change encryption format.
8. Do not add a backend.
9. Do not add network services.
10. Do not attempt CSP bypasses.
11. Do not create a second extension.
12. Do not create a second root project folder.
13. Add only necessary permissions.
14. Explain any broad host permission before adding it.
15. Validate all URLs.
16. Revalidate privileged URLs in the service worker.
17. Keep code Manifest V3 compatible.
18. Prefer vanilla JavaScript unless the current extension already uses a framework.
19. Keep UI consistent with the existing extension where practical.
20. Review security after implementation.

---

# 52. First Codex Prompt

```text
Read PEEK_INTEGRATION_CODEX.md completely.

This Peek feature must be integrated into the existing password-manager extension. Do not create a second project or another extension.

First inspect the current manifest.json, service worker, content scripts, settings page, and existing module structure.

Preserve all existing password-manager behavior.

Implement only Phase P1 and Phase P2 first:

1. Inspect the current architecture and permissions.
2. Add a modular src/peek/ structure that fits the existing project.
3. Implement the isolated Shadow DOM Peek overlay UI.
4. Add open/close behavior for development testing.
5. Support close button, Escape, backdrop click, focus handling, scroll locking, and cleanup.
6. Do NOT load external URLs yet.
7. Do NOT add broad host permissions yet.
8. Do NOT modify the vault format, crypto layer, autofill flow, or credential storage.
9. Ensure Peek code cannot access master passwords, derived keys, decrypted vault data, or credential objects.

After implementation:
- show every changed file,
- explain any manifest changes,
- confirm existing password-manager behavior was preserved,
- review for console errors, unsafe DOM usage, and event-listener leaks,
- then stop before Phase P3.
```

---

# 53. Second Codex Prompt

```text
Continue PEEK_INTEGRATION_CODEX.md with Phase P3 and Phase P4 only.

Implement the configurable Shift+Click link trigger and iframe-based Peek loading.

Requirements:
- only HTTP/HTTPS,
- safe URL parsing with new URL(),
- ignore download/mailto/tel/javascript/data/browser-internal links,
- normal click behavior must remain unchanged,
- original page must stay loaded,
- Peek must open as the existing floating overlay,
- do not automatically open a new tab,
- do not bypass CSP or X-Frame-Options,
- do not expose password-manager secrets,
- do not auto-fill credentials inside the Peek iframe,
- keep permissions minimal.

After implementation, test using normal links, relative links, localhost, and a known iframe-blocked site, then report limitations and stop before adding more features.
```

---

# 54. Desired End Result

```text
Helium Browser
│
└── Existing Extension
    │
    ├── Password Manager
    │   ├── encrypted vault
    │   ├── password generator
    │   ├── site matching
    │   └── autofill
    │
    └── Peek
        ├── Shift+Click link
        ├── floating preview
        ├── iframe web page
        ├── Open in Tab
        └── safe fallback
```

Both features live in one extension, but password data must remain isolated from Peek.
