# PeekBit

Peek at links without leaving the page — a Yab-inspired preview experience as a
standalone extension. **Shift + Click** opens a refined floating card, while
**Option/Alt + Click** opens the link beside the page you are reading.

Lives in the same repository as KeyBit (`../`) but is fully self-contained: its own
manifest, sources, icons and scripts. Load it as a separate unpacked extension.

## Install (Chrome / Edge / Brave / Arc)

1. Open `chrome://extensions` and enable **Developer mode**.
2. **Load unpacked** → select this `peek/` folder.

## Usage

- `Shift` + `Click` any `http(s)` link → opens a floating Peek.
- `Option/Alt` + `Click` a link → opens it beside the current page.
- Shift+Click another link → the card navigates to it (one card at a time).
- Drag the address capsule to move the card; drag the bottom-right grip to resize.
- In-card controls: back · forward · reload.
- Floating controls: close · keep as tab · open beside · copy address.
- `Esc` or clicking the dimmed backdrop closes the peek.
- Toolbar icon → configure Link Peek, Option-click, and the live address display.
- Ordinary sign-in and account routes are attempted inside Peek, including
  GitHub login and signup pages. Dedicated identity-provider and payment hosts
  still use a normal tab because their session flows require a top-level page.

## How it works

- A content script intercepts Shift+Click on links in the capture phase and also
  suppresses the text selection Shift+Click would start. It runs at
  `document_start` so its listeners are registered before the page's own
  handlers — this matters on sites (e.g. Google Search) that swallow click
  events aggressively. It also scans the full `composedPath()` so links inside
  open shadow roots are found.
- A minimal copy also runs inertly in ordinary page frames. Only the frame that
  the service worker identifies as the active Peek intercepts a plain
  cross-site link, waits for the destination-scoped framing rule, and then
  navigates. Same-site links and inactive frames retain normal page behavior.
- On every extension-worker startup, including an unpacked-extension reload,
  the service worker pushes the content script into already-open tabs and their
  frames (`chrome.scripting`), so stale invalidated scripts are replaced without
  requiring every page to be refreshed.
- Runtime messages accept both Chrome's callback response and Promise response.
  If the worker is briefly unavailable, Peek still attempts the URL rather than
  incorrectly presenting it as a policy-blocked address.
- Belt-and-suspenders: if a navigation target is still created right after a
  peek request (e.g. a browser that handles Shift+Click at the OS level), the
  background closes the stray window/tab automatically.
- The overlay is a Shadow-DOM card containing a sandboxed `<iframe>`
  (`allow-scripts allow-same-origin allow-forms allow-modals allow-popups
  allow-popups-to-escape-sandbox allow-downloads`), so it's isolated from the
  host page's CSS and can't navigate your tab.
- While a safe Peek is open, the service worker enables one
  `declarativeNetRequest` **session rule** for that source tab and exact target
  domain. It removes framing headers only from matching preview requests. The
  rule follows cross-domain navigation (with one automatic retry if the first
  response wins the rule-update race) and is removed when Peek or the tab closes.
- Links inside the preview navigate within the preview; popups escape the
  sandbox into real tabs.

## Limitations

- Sites that forbid framing via `<meta>` CSP or JS frame-busting can still
  refuse — the card shows a fallback with an "Open in new tab" button.
- The iframe is a third-party context. PeekBit now attempts ordinary login and
  account routes, but a site can still refuse a login or omit session cookies;
  use **Keep as tab** if that happens.
- `Esc` doesn't reach the card while the iframe has keyboard focus — use the
  backdrop or the close button.
- Dedicated identity-provider and payment hosts use the safe handoff with an
  explicit “Keep as tab” action instead.

## Firefox

```
node scripts/build-firefox.mjs
```

Then `about:debugging` → **This Firefox** → **Load Temporary Add-on** → pick
`peek/dist/firefox/manifest.json`.

## Icons

`icons/*.png` are generated — run `node scripts/make-icons.mjs` to rebuild them
(pure Node, no dependencies). `icons/peek.svg` is the source artwork.

## Files

```
peek/
  manifest.json           Chrome/Edge MV3 manifest
  manifest.firefox.json   Firefox MV3 manifest (gecko settings, scripts bg)
  src/
    content.js            Shift+Click interception + peek card (shadow DOM)
    background.js         DNR session rules lifecycle + tab actions
    popup.html/.css/.js   Enable/disable toggle
  scripts/
    make-icons.mjs        PNG icon generator (no deps)
    build-firefox.mjs     Copies to dist/firefox with the Firefox manifest
  icons/                  Generated PNGs + peek.svg source
```
