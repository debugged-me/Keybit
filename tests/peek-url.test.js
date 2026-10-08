import test from "node:test";
import assert from "node:assert/strict";
await import("../src/peek/peek-utils.js");
const { peekUrl, destinationUrl, isOutbound, frameUrl, sanitizeSettings, hashOnlyNavigation, displayHost, DEFAULT_SETTINGS, TRIGGERS, SIZES } = globalThis.__keybitPeek.utils;

test("Peek allows HTTP and HTTPS, including localhost and development hosts", () => {
  for (const value of [
    "https://example.com",
    "http://example.com",
    "http://localhost:8080",
    "http://127.0.0.1:3000",
    "http://192.168.1.5/admin",
    "https://app.localhost:5173/dev",
    "http://staging.example.internal/login"
  ]) assert.ok(peekUrl(value) instanceof URL, value);
});

test("Peek rejects non-http(s), internal, and unsafe URLs", () => {
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,<b>x</b>",
    "mailto:test@example.com",
    "tel:+123456",
    "chrome://settings",
    "helium://extensions",
    "edge://settings",
    "about:blank",
    "file:///etc/passwd",
    "chrome-extension://abc/panel.html",
    "moz-extension://abc/panel.html",
    "",
    "   ",
    "not a url at all",
    `https://example.com/${"a".repeat(9000)}`
  ]) assert.equal(peekUrl(value), null, value);
});

test("Peek resolves relative links against the page and rejects bad bases", () => {
  const base = "https://example.com/path/page.html";
  assert.equal(peekUrl("/login", base)?.href, "https://example.com/login");
  assert.equal(peekUrl("next?q=1", base)?.href, "https://example.com/path/next?q=1");
  assert.equal(peekUrl("//other.test/x", base)?.href, "https://other.test/x");
  // A relative target without a base can never be previewed.
  assert.equal(peekUrl("/login"), null);
  assert.equal(peekUrl("relative/path"), null);
});

test("hash-only navigation on the same document is not a Peek", () => {
  const here = "https://example.com/docs/page";
  assert.equal(hashOnlyNavigation(new URL("https://example.com/docs/page#section"), here), true);
  assert.equal(hashOnlyNavigation(new URL("https://example.com/docs/page#"), here), true);
  // Same page without a fragment, a different page, or a different site are still Peekable.
  assert.equal(hashOnlyNavigation(new URL("https://example.com/docs/page"), here), false);
  assert.equal(hashOnlyNavigation(new URL("https://example.com/docs/other#x"), here), false);
  assert.equal(hashOnlyNavigation(new URL("https://other.com/docs/page#section"), here), false);
});

test("the toolbar label is the host with its port", () => {
  assert.equal(displayHost(new URL("https://example.com/a")), "example.com");
  assert.equal(displayHost(new URL("http://localhost:8080/a")), "localhost:8080");
});

test("Peek settings sanitize unknown or malformed values to defaults", () => {
  assert.deepEqual(sanitizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(sanitizeSettings("junk"), DEFAULT_SETTINGS);
  assert.deepEqual(sanitizeSettings({ peekTrigger: "ctrl-click", peekSize: "huge" }), DEFAULT_SETTINGS);
  assert.deepEqual(sanitizeSettings({ peekMode: "browser" }), DEFAULT_SETTINGS);
  assert.deepEqual(sanitizeSettings({
    peekEnabled: false, peekTrigger: "long-press", peekSize: "compact", peekMode: "window",
    peekBackdropClose: false, peekLoadingIndicator: false, extra: "ignored"
  }), { peekEnabled: false, peekTrigger: "long-press", peekSize: "compact", peekMode: "overlay", peekBackdropClose: false, peekLoadingIndicator: false });
  for (const trigger of TRIGGERS) assert.equal(sanitizeSettings({ peekTrigger: trigger }).peekTrigger, trigger);
  for (const size of SIZES) assert.equal(sanitizeSettings({ peekSize: size }).peekSize, size);
});

test("old floating-window preferences migrate to in-page Peek and Click remains the default", () => {
  assert.equal(sanitizeSettings({ peekMode: "window" }).peekMode, "overlay");
  assert.equal(sanitizeSettings({}).peekTrigger, "click");
});

test("ordinary clicks only preview outbound destinations, including Facebook link wrappers", () => {
  const here = "https://www.facebook.com/feed";
  for (const href of ["https://www.facebook.com/profile?id=7", "https://facebook.com/messages", "https://m.facebook.com/comments", "http://www.facebook.com:8080/feed"]) {
    assert.equal(isOutbound(new URL(href), here), false, href);
  }
  const drive = "https://drive.google.com/file/d/example/view?resourcekey=abc";
  const wrapped = new URL(`https://l.facebook.com/l.php?u=${encodeURIComponent(drive)}&h=tracking`);
  assert.equal(destinationUrl(wrapped).href, drive);
  assert.equal(isOutbound(wrapped, here), true);
  assert.equal(isOutbound(new URL(`https://l.facebook.com/l.php?u=${encodeURIComponent(here)}`), here), false);
  assert.equal(isOutbound(new URL("https://facebook.com.evil.test/page"), here), true);
  // Don't reinterpret unrelated query parameters or non-HTTP redirect destinations.
  const ordinary = new URL(`https://other.test/l.php?u=${encodeURIComponent(drive)}`);
  assert.equal(destinationUrl(ordinary).href, ordinary.href);
  const invalid = new URL("https://l.facebook.com/l.php?u=javascript%3Aalert(1)");
  assert.equal(destinationUrl(invalid).href, invalid.href);
});

test("Drive file viewers use the embeddable route without losing access keys or rewriting the original", () => {
  const original = new URL("https://drive.google.com/file/d/file_ABC-123/view?usp=sharing&resourcekey=key-123#page=2");
  assert.equal(frameUrl(original).href, "https://drive.google.com/file/d/file_ABC-123/preview?usp=sharing&resourcekey=key-123#page=2");
  assert.equal(original.pathname, "/file/d/file_ABC-123/view");
  assert.equal(frameUrl(new URL("https://drive.google.com/file/u/1/d/file_123/view?authuser=1")).pathname, "/file/u/1/d/file_123/preview");
  for (const href of ["https://drive.google.com/uc?id=abc&export=download", "https://drive.google.com/file/d/abc/preview", "https://docs.google.com/document/d/abc/edit", "https://drive.google.com.evil.test/file/d/abc/view"]) {
    assert.equal(frameUrl(new URL(href)).href, href);
  }
});

test("Drive folders use the list embed instead of the full app route that returns 403 in a frame", () => {
  const original = new URL("https://drive.google.com/drive/folders/folder_ABC-123?usp=sharing&resourcekey=key-123");
  const embedded = frameUrl(original);
  assert.equal(embedded.pathname, "/embeddedfolderview");
  assert.equal(embedded.searchParams.get("id"), "folder_ABC-123");
  assert.equal(embedded.searchParams.get("resourcekey"), "key-123");
  assert.equal(embedded.hash, "#list");
  assert.equal(original.pathname, "/drive/folders/folder_ABC-123");
  assert.equal(original.searchParams.has("id"), false);
  const account = frameUrl(new URL("https://drive.google.com/drive/u/2/folders/folder_123/"));
  assert.equal(account.searchParams.get("authuser"), "2");
  const explicitAccount = frameUrl(new URL("https://drive.google.com/drive/u/2/folders/folder_123?authuser=example%40gmail.com"));
  assert.equal(explicitAccount.searchParams.get("authuser"), "example@gmail.com");
  for (const href of ["https://drive.google.com/drive/my-drive", "https://drive.google.com/embeddedfolderview?id=abc#grid", "https://drive.google.com.evil.test/drive/folders/abc", "https://other.test/drive/folders/abc"]) {
    assert.equal(frameUrl(new URL(href)).href, href);
  }
});
