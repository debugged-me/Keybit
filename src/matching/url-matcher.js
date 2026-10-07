export function parseWebsite(value) {
  if (typeof value !== "string" || value.length > 2048) throw new Error("Enter a valid website URL.");
  let url;
  try { url = new URL(value); } catch { throw new Error("Enter a full URL, such as https://example.com."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !url.hostname || url.hostname.endsWith(".")) {
    throw new Error("Use an HTTP or HTTPS URL without embedded credentials.");
  }
  return url;
}

export function matchesUrl(saved, current) {
  try { return parseWebsite(saved).origin === parseWebsite(current).origin; } catch { return false; }
}

export function matchesCredential(item, current) {
  return item.urls.some(url => matchesUrl(url, current));
}
