// Peek: pure helpers shared by every Peek context. A classic script with no DOM access at load:
// content scripts load it in every frame, the Peek page loads it with a <script> tag, and the
// service worker and the Node tests import it for its side effect on globalThis.__keybitPeek.
// Nothing here may touch the vault, credentials, or chrome.storage — Peek is a separate domain.
(() => {
  const ns = (globalThis.__keybitPeek = { ...(globalThis.__keybitPeek ?? {}) });
  const TRIGGERS = ["click", "shift-click", "alt-click", "ctrl-shift-click", "long-press"];
  const SIZES = ["compact", "default", "large"];
  // window.name of the previewed page's frame, set before insertion: the MAIN-world history shim
  // only runs in frames with this name.
  const PEEK_FRAME_NAME = "keybit-peek-frame";
  const DEFAULT_SETTINGS = {
    peekEnabled: true,
    peekTrigger: "click",
    peekSize: "default",
    peekMode: "overlay",
    peekBackdropClose: true,
    peekLoadingIndicator: true,
    peekUnblock: true
  };
  const MAX_URL_LENGTH = 8192;
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const XLINK_NS = "http://www.w3.org/1999/xlink";

  // Stored values are preferences, not secrets; anything unexpected falls back to a default.
  function sanitizeSettings(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const flag = key => (typeof source[key] === "boolean" ? source[key] : DEFAULT_SETTINGS[key]);
    return {
      peekEnabled: flag("peekEnabled"),
      peekTrigger: TRIGGERS.includes(source.peekTrigger) ? source.peekTrigger : DEFAULT_SETTINGS.peekTrigger,
      peekSize: SIZES.includes(source.peekSize) ? source.peekSize : DEFAULT_SETTINGS.peekSize,
      // Migrate the old floating-window preference: Peek always belongs to the current page.
      peekMode: "overlay",
      peekBackdropClose: flag("peekBackdropClose"),
      peekLoadingIndicator: flag("peekLoadingIndicator"),
      peekUnblock: flag("peekUnblock")
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

  // Link wrappers of big sites resolve to where they lead, so Click judges (and Peek loads) the
  // real destination instead of a tracking hop. Only these exact host + path shapes are trusted:
  // an arbitrary site's ?url= parameter can mean something else entirely.
  const TLD = "(?:[a-z]{2,3}|co\\.[a-z]{2}|com\\.[a-z]{2})";
  const REDIRECTORS = [
    { host: new RegExp(`^(?:www\\.)?google\\.${TLD}$`), path: /^\/url$/, params: ["q", "url"] },
    { host: /^(?:(?:www|m|l|lm)\.)?facebook\.com$/, path: /^\/l\.php$/, params: ["u"] },
    { host: /^l\.messenger\.com$/, path: /^\/l\.php$/, params: ["u"] },
    { host: /^l\.instagram\.com$/, path: /^\/$/, params: ["u"] },
    { host: /^l\.threads\.(?:net|com)$/, path: /^\/$/, params: ["u"] },
    { host: /^(?:(?:www|m)\.)?youtube\.com$/, path: /^\/redirect$/, params: ["q"] },
    { host: /^out\.reddit\.com$/, path: /^\//, params: ["url"] },
    { host: /^slack-redir\.net$/, path: /^\/link$/, params: ["url"] },
    { host: /^steamcommunity\.com$/, path: /^\/linkfilter\/?$/, params: ["url", "u"] },
    { host: /^away\.vk\.com$/, path: /^\/away\.php$/, params: ["to"] },
    { host: /^(?:www\.)?linkedin\.com$/, path: /^\/redir\/redirect\/?$/, params: ["url"] },
    { host: /^duckduckgo\.com$/, path: /^\/l\/?$/, params: ["uddg"] },
    { host: /^t\.umblr\.com$/, path: /^\/redirect$/, params: ["z"] },
    { host: new RegExp(`^(?:www\\.)?pinterest\\.${TLD}$`), path: /^\/offsite\/?$/, params: ["url"] },
    { host: /^medium\.com$/, path: /^\/r\/?$/, params: ["url"] }
  ];
  function destinationUrl(url) {
    let destination = url;
    for (let depth = 0; depth < 3; depth++) {
      const rule = REDIRECTORS.find(({ host, path }) => host.test(destination.hostname) && path.test(destination.pathname));
      // Google search results carry an empty q= next to the real url=, so take the first that parses.
      const next = rule?.params.map(name => peekUrl(destination.searchParams.get(name))).find(Boolean);
      if (!next || next.href === destination.href) break;
      destination = next;
    }
    return destination;
  }

  // Multi-part public suffixes and shared hosting domains, where a site sits one label deeper.
  // A deliberately short stand-in for the Public Suffix List: enough for Click's same-site check.
  const MULTI_PART_SUFFIXES = new Set([
    "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.jp", "co.nz", "co.in", "com.br", "com.mx",
    "co.za", "com.sg", "com.my", "com.ph", "com.tr", "com.cn", "com.hk", "com.tw", "co.kr",
    "github.io", "gitlab.io", "vercel.app", "netlify.app", "pages.dev", "herokuapp.com", "web.app", "firebaseapp.com",
    "blogspot.com", "appspot.com", "azurewebsites.net", "cloudfront.net", "workers.dev", "glitch.me", "onrender.com", "fly.dev"
  ]);
  // Approximate registrable domain: "docs.github.com" → "github.com", "news.bbc.co.uk" → "bbc.co.uk",
  // "alice.github.io" stays itself. IP addresses, localhost, and single-label hosts compare as-is.
  function siteKey(hostname) {
    const host = String(hostname ?? "").toLowerCase().replace(/\.$/, "");
    if (!host.includes(".") || host.includes(":") || /^\d+(?:\.\d+){3}$/.test(host)) return host;
    // www/mobile/AMP variants are the same site — but never strip down to a bare suffix.
    const labels = host.replace(/^(?:www|m|mobile|amp)\.(?=[^.]+\.)/, "").split(".");
    return labels.slice(labels.length > 2 && MULTI_PART_SUFFIXES.has(labels.slice(-2).join(".")) ? -3 : -2).join(".");
  }

  // Default Click is for leaving the current site. Subdomains, www/mobile variants, app routes,
  // profiles, comments, and pagination keep their normal behavior even without a marked-up nav.
  function isOutbound(url, currentHref) {
    const current = peekUrl(String(currentHref ?? ""));
    const target = url instanceof URL ? url : peekUrl(url);
    if (!current || !target) return false;
    return siteKey(destinationUrl(target).hostname) !== siteKey(current.hostname);
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

  // "example.com" or "localhost:8080" — the label shown in the Peek pill. A leading "www." is
  // noise, unless dropping it would leave a bare suffix ("www.com").
  function displayHost(url) {
    return url.host.replace(/^www\.(?=[^.:]+\.)/, "");
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

  // DOM helpers are duck-typed (nodeType/localName/getAttribute) rather than instanceof checks, so
  // they work for nodes from any frame or realm — and in the Node tests with plain objects.
  const isElement = node => node?.nodeType === 1 && typeof node.getAttribute === "function";

  // The raw href of a link: <a>/<area>, or an SVG <a> (href, else the legacy xlink:href — what
  // href.baseVal reflects). null when the node isn't a link at all, "" for an empty href.
  function anchorHref(el) {
    if (!isElement(el)) return null;
    if (el.namespaceURI === SVG_NS) {
      if (el.localName !== "a") return null;
      return el.hasAttribute("href") ? el.getAttribute("href") : el.getAttributeNS?.(XLINK_NS, "href") ?? null;
    }
    return el.namespaceURI === HTML_NS && (el.localName === "a" || el.localName === "area") ? el.getAttribute("href") : null;
  }

  // A node and its ancestors in the composed tree (a shadow root steps to its host) — the shape of
  // event.composedPath() for callers that only have a node.
  function pathFrom(node) {
    const path = [];
    for (let current = node; current && path.length < 1000; current = current.nodeType === 11 ? current.host : current.parentNode) path.push(current);
    return path;
  }

  // The link a click follows, from event.composedPath(): the innermost <a>/<area>/SVG <a> with an
  // href, so links in open shadow roots, image maps, and SVG all count. The browser activates that
  // innermost link, so when it is a download or has an empty href the click stays native (null).
  function anchorFromPath(path) {
    for (const node of Array.isArray(path) ? path : []) {
      const href = anchorHref(node);
      if (href === null) continue;
      return href.trim() && !node.hasAttribute("download") ? node : null;
    }
    return null;
  }

  // The link around a node, for callers without an event (the palette's focused link).
  function findAnchor(target) {
    return anchorFromPath(pathFrom(target));
  }

  // Resolve a link's raw href against the page and apply every eligibility rule: http(s) only,
  // known redirect wrappers resolved, and same-page fragment links left alone.
  function anchorUrl(anchor, baseURI, currentHref) {
    const href = anchorHref(anchor);
    const raw = peekUrl(href, baseURI);
    if (!raw) return null;
    const url = destinationUrl(raw);
    return hashOnlyNavigation(url, currentHref, url === raw ? href : url.href) ? null : url;
  }

  // For the plain-click trigger, links that are really site chrome — nav bars, menus, toolbars,
  // tab strips, popup-menu triggers, editors — and controls nested inside a link keep their native
  // behavior: they're how the page works, not content to preview. Modifier triggers are explicit
  // intent and skip this filter. The composed path (not closest()) lets shadow DOM links be judged
  // by the page region they're shown in.
  const UI_ROLES = ["navigation", "menubar", "menu", "toolbar", "tablist"];
  const CONTROL_ROLES = ["button", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "switch", "treeitem", "option",
    "combobox", "checkbox", "radio", "slider", "spinbutton", "textbox", "searchbox"];
  const CONTROL_TAGS = ["button", "input", "select", "textarea", "summary", "label"];
  // ARIA follows the first role token; contenteditable="false" (or an invalid value) isn't editing.
  const role = node => (node.getAttribute("role") ?? "").trim().split(/\s+/)[0].toLowerCase();
  const editable = node => ["", "true", "plaintext-only"].includes(node.getAttribute("contenteditable")?.trim().toLowerCase());
  function isControlLink(anchor, path) {
    if (!isElement(anchor)) return true;
    const popup = anchor.getAttribute("aria-haspopup");
    if ((popup !== null && popup !== "false") || anchor.hasAttribute("aria-expanded") || anchor.getAttribute("aria-disabled") === "true" ||
        anchor.hasAttribute("onclick") || anchor.hasAttribute("data-toggle") || anchor.hasAttribute("data-bs-toggle") ||
        CONTROL_ROLES.includes(role(anchor))) return true;
    const route = Array.isArray(path) && path.includes(anchor) ? path : pathFrom(anchor);
    const at = route.indexOf(anchor);
    return route.some((node, index) => isElement(node) && (index < at
      // Between the click target and the link: an interactive control keeps its own behavior.
      ? CONTROL_TAGS.includes(node.localName) || CONTROL_ROLES.includes(role(node)) || editable(node)
      // The link itself and everything around it: site chrome and editable content.
      : node.localName === "nav" || UI_ROLES.includes(role(node)) || editable(node)));
  }

  // The plain-click anchor for a node, for callers without an event path.
  function clickPeekAnchor(target) {
    const path = pathFrom(target);
    const anchor = anchorFromPath(path);
    return anchor && !isControlLink(anchor, path) ? anchor : null;
  }

  ns.utils = { TRIGGERS, SIZES, PEEK_FRAME_NAME, DEFAULT_SETTINGS, MAX_URL_LENGTH, sanitizeSettings, peekUrl, destinationUrl,
    siteKey, isOutbound, frameUrl, displayHost, hashOnlyNavigation, matchesTrigger, anchorHref, anchorFromPath, findAnchor,
    anchorUrl, isControlLink, clickPeekAnchor };
})();
