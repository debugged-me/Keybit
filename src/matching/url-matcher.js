export function parseWebsite(value) {
  if (value instanceof URL) value = value.href;
  if (typeof value !== "string" || value.length > 2048) throw new Error("Enter a valid website URL.");
  let url;
  try { url = new URL(value); } catch { throw new Error("Enter a full URL, such as https://example.com."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !url.hostname || url.hostname.endsWith(".")) {
    throw new Error("Use an HTTP or HTTPS URL without embedded credentials.");
  }
  return url;
}

// Local web servers on the default port (XAMPP, MAMP, WAMP) host one project per folder:
// http://localhost/srms-college/ and http://localhost/shop/ are different apps on one origin.
const LOCAL_HOST = /^(?:localhost|.+\.localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:.]+\])$/i;
export function usesFolders(url) { return LOCAL_HOST.test(url.hostname) && url.port === ""; }
export function isLocalHost(url) { return /^(?:localhost|.+\.localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(url.hostname); }

// The part of an origin a login belongs to: a project folder such as "/srms-college/", or "/" for the whole site.
export function loginScope(value) {
  const url = parseWebsite(value);
  if (!usesFolders(url)) return "/";
  const segments = url.pathname.split("/").filter(Boolean);
  // A file at the server root (http://localhost/login.php) belongs to the root project.
  if (!segments.length || (segments.length === 1 && !url.pathname.endsWith("/") && segments[0].includes("."))) return "/";
  return `/${segments[0]}/`;
}

// The URL to store for a login made on this page: the origin plus its project folder, if any.
export function scopeUrl(value) {
  const url = parseWebsite(value);
  return `${url.origin}${loginScope(url)}`;
}

// A short, human label such as "example.com" or "localhost/srms-college".
export function scopeLabel(value) {
  const url = parseWebsite(value);
  const scope = loginScope(url);
  return url.host + (scope === "/" ? "" : scope.slice(0, -1));
}

export function matchesUrl(saved, current) {
  try {
    const login = parseWebsite(saved);
    const page = parseWebsite(current);
    if (login.origin !== page.origin) return false;
    const scope = loginScope(login);
    return scope === "/" || page.pathname === scope.slice(0, -1) || page.pathname.startsWith(scope);
  } catch { return false; }
}

export function matchesCredential(item, current) {
  return item.urls.some(url => matchesUrl(url, current));
}

// More specific logins (a project folder) sort before whole-site logins.
export function specificity(item) { return Math.max(...item.urls.map(url => { try { return loginScope(url).length; } catch { return 0; } })); }
