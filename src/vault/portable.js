// A portable vault: the encrypted envelope baked into a single self-contained HTML file
// that decrypts itself with WebCrypto — the vault, readable on any computer with just the
// master password, no KeyBit install needed. The file holds only ciphertext; opening it
// without the password reveals nothing. Item text is rendered via textContent so stored
// logins can never inject markup into the page.

const PAGE_START = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KeyBit portable vault</title>
<style>
  :root { color-scheme: light dark; --accent: #2e6b4f; --surface: #fff; --text: #1c2321; --muted: #5a6660; --border: #dfe5e1; --warn-bg: #fcf0d3; --warn-text: #7a4d08; }
  @media (prefers-color-scheme: dark) { :root { --surface: #1a201d; --text: #e6ebe8; --muted: #9aa8a1; --border: #33403a; --warn-bg: #3d3315; --warn-text: #edd08a; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; font: 400 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--border); color: var(--text); display: grid; place-items: center; padding: 24px; }
  .card { width: min(560px, 100%); padding: 32px 30px; border-radius: 18px; background: var(--surface); box-shadow: 0 10px 40px #0002; }
  .gate { text-align: center; }
  h1 { margin: 0 0 4px; font-size: 21px; letter-spacing: -.3px; }
  .sub { margin: 0 0 18px; color: var(--muted); font-size: 13px; }
  label { display: block; margin: 14px 0 6px; font-size: 12.5px; font-weight: 600; text-align: left; }
  input[type=password] { width: 100%; padding: 10px 12px; border: 1.5px solid var(--border); border-radius: 9px; background: var(--surface); color: var(--text); font: inherit; }
  input[type=password]:focus { border-color: var(--accent); outline: none; }
  button.primary { width: 100%; margin-top: 14px; padding: 11px; border: 0; border-radius: 9px; background: var(--accent); color: #fff; font: 600 14px/1 inherit; cursor: pointer; }
  button.primary:hover { filter: brightness(1.08); }
  .msg { min-height: 18px; margin: 10px 0 0; color: #b2493a; font-size: 12.5px; }
  .warn { margin: 14px 0 0; padding: 9px 12px; border-radius: 9px; background: var(--warn-bg); color: var(--warn-text); font-size: 12px; text-align: left; }
  #vault { width: min(720px, 100%); }
  #vault > header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 14px; }
  #vault h1 { font-size: 19px; }
  #count { color: var(--muted); font-size: 12.5px; }
  .item { margin: 0 0 10px; padding: 14px 16px; border-radius: 12px; background: var(--surface); box-shadow: 0 1px 6px #0001; }
  .item h3 { margin: 0; font-size: 14.5px; display: flex; align-items: center; gap: 8px; }
  .tag { padding: 1px 7px; border-radius: 999px; background: var(--warn-bg); color: var(--warn-text); font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .4px; }
  .row { display: flex; gap: 10px; margin-top: 6px; font-size: 13px; }
  .row .k { width: 84px; flex-shrink: 0; color: var(--muted); font-size: 11.5px; padding-top: 1px; text-transform: uppercase; letter-spacing: .4px; }
  .row .v { flex: 1; word-break: break-word; }
  .row .v code { font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .row .v button { margin-left: 8px; border: 0; background: none; color: var(--accent); font-size: 11.5px; font-weight: 600; cursor: pointer; padding: 0; }
  .notes { white-space: pre-wrap; }
  .foot { margin-top: 20px; color: var(--muted); font-size: 11px; text-align: center; }
</style>
</head>
<body>
<main class="card gate" id="gate-card">
  <h1>KeyBit portable vault</h1>
  <p class="sub">This file is your encrypted vault. Enter the master password it was exported with — the file opens itself, offline, on any computer.</p>
  <form id="gate" autocomplete="off">
    <label for="pw">Master password</label>
    <input id="pw" type="password" autocomplete="off" required autofocus>
    <button class="primary" type="submit">Unlock this file</button>
  </form>
  <p class="msg" id="msg" role="alert"></p>
  <p class="warn">Anyone who gets this file <strong>and</strong> its password can read everything in it. Store it like a backup — encrypted, but sensitive.</p>
</main>
<div id="vault" hidden>
  <header><h1 id="vault-title">Your vault</h1><span id="count"></span></header>
  <div id="items"></div>
  <p class="foot">Exported from KeyBit — a snapshot, not a live copy. Passkey private keys are stored but not shown.</p>
</div>
<script>
"use strict";
const ENVELOPE = `;

const PAGE_END = `;
const b64d = text => Uint8Array.from(atob(text), ch => ch.charCodeAt(0));
const encoder = new TextEncoder();
const msg = text => { document.getElementById("msg").textContent = text; };
function row(key, value, secret) {
  const line = document.createElement("div");
  line.className = "row";
  const k = document.createElement("span"); k.className = "k"; k.textContent = key;
  const v = document.createElement("span"); v.className = "v";
  if (secret) {
    const code = document.createElement("code");
    code.textContent = "•".repeat(Math.min(12, value.length));
    const toggle = document.createElement("button");
    toggle.type = "button"; toggle.textContent = "Show";
    toggle.addEventListener("click", () => {
      const shown = toggle.textContent === "Hide";
      code.textContent = shown ? "•".repeat(Math.min(12, value.length)) : value;
      toggle.textContent = shown ? "Show" : "Hide";
    });
    v.append(code, toggle);
  } else { if (value.includes("\n")) v.classList.add("notes"); v.textContent = value; }
  line.append(k, v);
  return line;
}
function render(payload) {
  const items = (payload.items || []).filter(item => !item.deletedAt)
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  document.getElementById("count").textContent = items.length + (items.length === 1 ? " item" : " items");
  const list = document.getElementById("items");
  for (const item of items) {
    const card = document.createElement("section");
    card.className = "item";
    const head = document.createElement("h3");
    head.textContent = item.name || "Untitled";
    if (item.type && item.type !== "login") {
      const tag = document.createElement("span");
      tag.className = "tag"; tag.textContent = { note: "Note", passkey: "Passkey", card: "Card", identity: "ID" }[item.type] ?? item.type;
      head.append(tag);
    }
    card.append(head);
    if (item.type === "note") { if (item.notes) card.append(row("Notes", item.notes)); }
    else if (item.type === "passkey") {
      card.append(row("Signs in to", item.rpId || ""));
      if (item.userName) card.append(row("Account", item.userName));
      card.append(row("Key", "Stored — private keys are not shown in this view."));
    } else if (item.type === "card") {
      if (item.cardholder) card.append(row("Name on card", item.cardholder));
      if (item.number) card.append(row("Number", item.number, true));
      if (item.expiryMonth) card.append(row("Expiry", String(item.expiryMonth).padStart(2, "0") + "/" + item.expiryYear));
      if (item.cvv) card.append(row("Security code", item.cvv, true));
      if (item.brand) card.append(row("Brand", item.brand));
      if (item.notes) card.append(row("Notes", item.notes));
    } else if (item.type === "identity") {
      const name = [item.firstName, item.lastName].filter(Boolean).join(" ");
      if (name) card.append(row("Name", name));
      if (item.email) card.append(row("Email", item.email));
      if (item.phone) card.append(row("Phone", item.phone));
      const address = [item.address, [item.city, item.region, item.postal].filter(Boolean).join(", "), item.country].filter(Boolean).join("\n");
      if (address) card.append(row("Address", address));
      if (item.company) card.append(row("Company", item.company));
      if (item.notes) card.append(row("Notes", item.notes));
    } else {
      if (item.urls && item.urls.length) card.append(row("Site", item.urls.join(", ")));
      if (item.username) card.append(row("Username", item.username));
      if (item.password) card.append(row("Password", item.password, true));
      if (item.totp) card.append(row("2FA", "A setup key is stored (codes are generated inside KeyBit)."));
      if (item.notes) card.append(row("Notes", item.notes));
    }
    list.append(card);
  }
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "sub"; empty.textContent = "This vault copy is empty.";
    list.append(empty);
  }
  document.getElementById("gate-card").hidden = true;
  document.getElementById("vault").hidden = false;
}
document.getElementById("gate").addEventListener("submit", async event => {
  event.preventDefault(); msg("");
  const password = document.getElementById("pw").value;
  if (!password) { msg("Enter the master password."); return; }
  const button = event.target.querySelector("button");
  button.disabled = true; button.textContent = "Unlocking…";
  try {
    const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: b64d(ENVELOPE.kdf.salt), iterations: ENVELOPE.kdf.iterations }, material, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const aad = encoder.encode(JSON.stringify({ formatVersion: ENVELOPE.formatVersion, kdf: ENVELOPE.kdf, cipher: ENVELOPE.cipher }));
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(ENVELOPE.cipher.iv), additionalData: aad, tagLength: 128 }, key, b64d(ENVELOPE.ciphertext));
    render(JSON.parse(new TextDecoder().decode(plain)));
    document.getElementById("pw").value = "";
  } catch { msg("Wrong password or a damaged file."); }
  finally { button.disabled = false; button.textContent = "Unlock this file"; }
});
</script>
</body>
</html>
`;

// The envelope is embedded verbatim; "<" is escaped so vault text can never break out of
// the script block (JSON is all base64 anyway, but the escape makes it structurally safe).
export function portableHtml(envelope) {
  return PAGE_START + JSON.stringify(envelope).replace(/</g, "\\u003c") + PAGE_END;
}
