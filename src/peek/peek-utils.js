// Peek: pure helpers shared by every Peek context. Loaded as a classic content script; the
// service worker and the Node tests import it for its side effect on globalThis.__keybitPeek.
// Nothing here may touch the vault, credentials, or chrome.storage — Peek is a separate domain.
(() => {
  const ns = (globalThis.__keybitPeek = { ...(globalThis.__keybitPeek ?? {}) });
  const TRIGGERS = ["click", "shift-click", "alt-click", "ctrl-shift-click", "long-press"];
  const SIZES = ["compact", "default", "large"];
  const DEFAULT_SETTINGS = {
    peekEnabled: true,
    peekTrigger: "click",
    peekSize: "default",
    peekMode: "overlay",
    peekBackdropClose: true,
    peekLoadingIndicator: true
  };
  const MAX_URL_LENGTH = 8192;

  // Stored values are preferences, not secrets; anything unexpected falls back to a default.
  function sanitizeSettings(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    return {
      peekEnabled: typeof source.peekEnabled === "boolean" ? source.peekEnabled : DEFAULT_SETTINGS.peekEnabled,
      peekTrigger: TRIGGERS.includes(source.peekTrigger) ? source.peekTrigger : DEFAULT_SETTINGS.peekTrigger,
      peekSize: SIZES.includes(source.peekSize) ? source.peekSize : DEFAULT_SETTINGS.peekSize,
      // Migrate the old floating-window preference: Peek always belongs to the current page.
      peekMode: "overlay",
      peekBackdropClose: typeof source.peekBackdropClose === "boolean" ? source.peekBackdropClose : DEFAULT_SETTINGS.peekBackdropClose,
      peekLoadingIndicator: typeof source.peekLoadingIndicator === "boolean" ? source.peekLoadingIndicator : DEFAULT_SETTINGS.peekLoadingIndicator
    };
  }

  // The only schemes Peek may embed. http+https also covers localhost, LAN hosts, and dev ports.
  // Rejects javascript:, data:, mailto:, tel:, file:, chrome:/helium:/about:/edge: internals,
  // chrome-extension:/moz-extension: URLs, empty hrefs, and overlong strings. Returns URL or null.
  function peekUrl(value, base) {
    if (typeof value !== "string" || !value.trim() || value.length > MAX_URL_LENGTH) return null;
    let url;
    try { url = new URL(value, base); } catch { return null; }
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url;
  }

  // Facebook/Messenger wrap outbound links in l.php. Resolve only that known redirect shape;
  // an arbitrary site's ?url= parameter can have an entirely different meaning.
  function destinationUrl(url) {
    let destination = url;
    const hosts = ["facebook.com", "www.facebook.com", "m.facebook.com", "l.facebook.com", "lm.facebook.com", "l.messenger.com"];
    for (let depth = 0; depth < 3; depth++) {
      if (!hosts.includes(destination.hostname) || destination.pathname !== "/l.php") break;
      const next = peekUrl(destination.searchParams.get("u"));
      if (!next || next.href === destination.href) break;
      destination = next;
    }
    return destination;
  }

  // Default Click is for leaving the current site. App routes, profiles, comments, pagination,
  // and www/mobile variants keep their normal behavior even if the site didn't mark up a nav.
  function isOutbound(url, currentHref) {
    const current = peekUrl(currentHref);
    if (!current) return false;
    const host = value => value.hostname.replace(/^(www|m|mobile)\./, "");
    return host(destinationUrl(url)) !== host(current);
  }

  // Drive has different routes for full pages and embeds. Its normal folder page returns 403
  // in a cross-site frame even for public folders; embeddedfolderview is the supported view.
  // Preserve resource keys/account selection and leave the original URL for Open in tab.
  function frameUrl(url) {
    const preview = new URL(url.href);
    if (preview.hostname === "drive.google.com") {
      const file = preview.pathname.match(/^(\/file\/(?:u\/\d+\/)?d\/[A-Za-z0-9_-]+)(?:\/view)?\/?$/);
      if (file) preview.pathname = `${file[1]}/preview`;
      const folder = preview.pathname.match(/^\/drive\/(?:u\/(\d+)\/)?folders\/([A-Za-z0-9_-]+)\/?$/);
      if (folder) {
        preview.pathname = "/embeddedfolderview";
        preview.searchParams.set("id", folder[2]);
        if (folder[1] && !preview.searchParams.has("authuser")) preview.searchParams.set("authuser", folder[1]);
        preview.hash = "list";
      }
    }
    return preview;
  }

  // "example.com" or "localhost:8080" — the label shown in the Peek toolbar.
  function displayHost(url) {
    return url.host;
  }

  // Same document, only the fragment changes: "#section" (or a bare "#") on the current page is
  // not a Peek. rawHref catches empty fragments, which URL normalizes away and url.hash misses.
  function hashOnlyNavigation(url, currentHref, rawHref = url.href) {
    try {
      const here = new URL(currentHref); here.hash = "";
      const there = new URL(url.href); there.hash = "";
      return here.href === there.href && (typeof rawHref === "string" ? rawHref : url.href).includes("#");
    } catch { return false; }
  }

  // A modifier click matches only when exactly the configured keys are held: Shift+Click does not
  // fire on Ctrl+Shift+Click, and plain/Cmd/Ctrl/middle clicks never reach this check.
  function matchesTrigger(trigger, event) {
    if (event.button !== 0) return false;
    switch (trigger) {
      case "click": return !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
      case "shift-click": return event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
      case "alt-click": return event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey;
      case "ctrl-shift-click": return event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
      default: return false; // "long-press" is timed in the link handler, not modifier-based.
    }
  }

  // The closest real <a href> — including inside an open shadow root when the caller passes the
  // first entry of event.composedPath(). Download links are never Peeked.
  function findAnchor(target) {
    const anchor = target instanceof Element ? target.closest("a[href]") : null;
    if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download")) return null;
    return anchor;
  }

  // Resolve an anchor's href against the page and apply every eligibility rule.
  function anchorUrl(anchor, baseURI, currentHref) {
    const href = anchor?.getAttribute("href");
    const raw = peekUrl(href, baseURI);
    const url = raw && destinationUrl(raw);
    if (!url || hashOnlyNavigation(url, currentHref, href)) return null;
    return url;
  }

  // For the plain-click trigger, links that are really site chrome — nav bars, menus, toolbars,
  // tab strips, popup-menu triggers — don't Peek: they're how the page works, not content to
  // preview. Modifier triggers are explicit intent and skip this filter.
  const UI_REGION = 'nav, [role="navigation"], [role="menubar"], [role="menu"], [role="toolbar"], [role="tablist"], [contenteditable]:not([contenteditable="false"])';
  const CONTROL_ROLES = '[role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], [role="switch"], [role="treeitem"], [role="option"], [role="combobox"]';
  const INNER_CONTROL = `button, input, select, textarea, summary, label, ${CONTROL_ROLES}, [contenteditable=""], [contenteditable="true"]`;
  function clickPeekAnchor(target) {
    const anchor = findAnchor(target);
    if (!anchor) return null;
    if ((anchor.hasAttribute("aria-haspopup") && anchor.getAttribute("aria-haspopup") !== "false") ||
        anchor.hasAttribute("aria-expanded") || anchor.getAttribute("aria-disabled") === "true" ||
        anchor.hasAttribute("onclick") || anchor.hasAttribute("data-toggle") || anchor.hasAttribute("data-bs-toggle") ||
        anchor.matches(CONTROL_ROLES) || anchor.closest(UI_REGION)) return null;
    // An interactive control nested inside a wrapped link keeps its own behavior.
    const control = target instanceof Element ? target.closest(INNER_CONTROL) : null;
    if (control && control !== anchor && anchor.contains(control)) return null;
    return anchor;
  }

  ns.utils = { TRIGGERS, SIZES, DEFAULT_SETTINGS, MAX_URL_LENGTH, sanitizeSettings,
    peekUrl, destinationUrl, isOutbound, frameUrl, displayHost, hashOnlyNavigation, matchesTrigger, findAnchor, anchorUrl, clickPeekAnchor };
})();
