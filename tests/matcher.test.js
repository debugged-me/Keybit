import test from "node:test";
import assert from "node:assert/strict";
import { matchesUrl, parseWebsite, loginScope, scopeLabel, scopeUrl } from "../src/matching/url-matcher.js";

test("matches exact origins including development ports and schemes", () => {
  for (const host of ["example.com", "www.example.com", "login.example.com", "localhost", "127.0.0.1", "192.168.1.10", "[::1]"]) {
    assert.equal(matchesUrl(`https://${host}`, `https://${host}/login?q=1`), true);
  }
  assert.equal(matchesUrl("https://EXAMPLE.com:443", "https://example.com"), true);
  for (const hostile of ["https://example.com.attacker.test", "https://login.example.com", "https://www.example.com", "http://example.com", "https://example.com:8443", "https://example.com@attacker.test", "javascript:alert(1)"]) {
    assert.equal(matchesUrl("https://example.com", hostile), false);
  }
  assert.equal(matchesUrl("http://localhost:8000", "http://localhost:8080"), false);
  assert.equal(matchesUrl("http://127.0.0.1", "http://localhost"), false);
  assert.equal(matchesUrl("http://192.168.1.10", "http://192.168.1.11"), false);
  assert.throws(() => parseWebsite("https://user:password@example.com"));
  assert.throws(() => parseWebsite("file:///etc/passwd"));
});

test("project folders on local web servers keep same-origin apps apart", () => {
  // XAMPP-style: one origin, one app per folder.
  assert.equal(loginScope("http://localhost/srms-college/admin/login.php"), "/srms-college/");
  assert.equal(scopeUrl("http://localhost/srms-college/admin/login.php?next=1"), "http://localhost/srms-college/");
  assert.equal(scopeLabel("http://localhost/srms-college/login.php"), "localhost/srms-college");
  assert.equal(matchesUrl("http://localhost/srms-college/", "http://localhost/srms-college/login.php"), true);
  assert.equal(matchesUrl("http://localhost/srms-college/", "http://localhost/srms-college"), true);
  assert.equal(matchesUrl("http://localhost/srms-college/", "http://localhost/other-app/login.php"), false);
  assert.equal(matchesUrl("http://localhost/srms-college/", "http://localhost/srms-college-v2/login.php"), false);
  assert.equal(matchesUrl("http://127.0.0.1/shop/", "http://127.0.0.1/blog/"), false);
  // Root files and bare origins cover the whole server, as before.
  assert.equal(loginScope("http://localhost/login.php"), "/");
  assert.equal(matchesUrl("http://localhost/", "http://localhost/other-app/login.php"), true);
  // Dev servers on their own port and normal websites stay whole-site.
  assert.equal(loginScope("http://localhost:8000/login"), "/");
  assert.equal(matchesUrl("http://localhost:8000/login", "http://localhost:8000/admin"), true);
  assert.equal(loginScope("https://example.com/account/login"), "/");
  assert.equal(matchesUrl("https://example.com/account/login", "https://example.com/signin"), true);
  assert.equal(scopeLabel("https://example.com/account/login"), "example.com");
});

test("the version constant matches the manifest", async () => {
  const { readFile } = await import("node:fs/promises");
  const { VERSION } = await import("../src/version.js");
  assert.equal(VERSION, JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8")).version);
});

test("lookalike domains are caught: confusables, punycode, typos — but not legit variants", async () => {
  const { lookalikeOf } = await import("../src/matching/lookalike.js");
  const saved = ["paypal.com", "apple.com", "github.com", "amazon.com"];
  // Digit and letter substitutions
  assert.equal(lookalikeOf("paypa1.com", saved), "paypal.com");
  assert.equal(lookalikeOf("githud.com", saved), "github.com"); // one-letter typo
  assert.equal(lookalikeOf("pay-pal.com", saved), "paypal.com"); // hyphen squat
  // Cyrillic homograph, both raw and in its punycode spelling (аррӏе.com = xn--80ak6aa92e)
  assert.equal(lookalikeOf("\u0430\u0440\u0440\u04cf\u0435.com", saved), "apple.com");
  assert.equal(lookalikeOf("xn--80ak6aa92e.com", saved), "apple.com");
  // Subdomains of a lookalike domain still warn; the exact site never does.
  assert.equal(lookalikeOf("login.paypa1.com", saved), "paypal.com");
  assert.equal(lookalikeOf("www.paypal.com", saved), null);
  assert.equal(lookalikeOf("paypal.com", saved), null);
  // Legit differences are quiet: country TLDs and unrelated names.
  assert.equal(lookalikeOf("amazon.de", saved), null);
  assert.equal(lookalikeOf("amazon.co.uk", saved), null);
  assert.equal(lookalikeOf("127.0.0.1", saved), null);
  assert.equal(lookalikeOf("fixture.test", saved), null);
  assert.equal(lookalikeOf("totallydifferent.io", saved), null);
});
