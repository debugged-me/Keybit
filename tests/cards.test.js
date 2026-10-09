import test from "node:test";
import assert from "node:assert/strict";
import { Vault } from "../src/vault/vault.js";
import { decryptVault } from "../src/crypto/crypto.js";
import { cardBrand, createItem, expiryDisplay, duplicateKey } from "../src/vault/schema.js";

function memoryStorage() {
  let data = null;
  return { async read() { return structuredClone(data); }, async write(value) { data = structuredClone(value); } };
}
const password = "a unique test passphrase";

test("card and identity items validate, normalize, and derive brand", () => {
  const card = createItem({ type: "card", name: "Work Visa", cardholder: "Ada Lovelace", number: "4242 4242 4242 4242", expiryMonth: "4", expiryYear: 2029, cvv: "123", notes: "" });
  assert.equal(card.brand, "Visa");
  assert.equal(card.number, "4242424242424242", "Spaces are stripped");
  assert.equal(expiryDisplay(card), "04/2029");
  assert.equal(cardBrand("5555555555554444"), "Mastercard");
  assert.equal(cardBrand("378282246310005"), "Amex");
  assert.equal(cardBrand("123456789012"), "Card");
  for (const bad of [
    { number: "4242" },                       // too short for a PAN
    { number: "424242424242x" },              // non-digit
    { expiryMonth: 13 }, { expiryMonth: 0 },  // no such month
    { cvv: "12" }, { cvv: "12345" },          // 3–4 digits only
  ]) assert.throws(() => createItem({ type: "card", name: "C", number: "4242424242424242", expiryMonth: 4, expiryYear: 2029, cvv: "123", ...bad }), /invalid/i);

  const identity = createItem({ type: "identity", name: "Home", firstName: "Ada", lastName: "Lovelace", email: "ada@example.test", phone: "+1 555 0100", address: "12 Analytical Way", city: "London", region: "London", postal: "N1", country: "United Kingdom", company: "Engines Ltd" });
  assert.equal(identity.firstName, "Ada");
  assert.equal(duplicateKey(identity), "identity\nAda\nLovelace\nada@example.test");
  assert.equal(duplicateKey(card), "card\n4242424242424242\n4/2029");
});

test("cards and identities list with display-safe fields only", async () => {
  const vault = new Vault(memoryStorage());
  let state = await vault.create(password);
  state = await vault.saveItem(state.session, state.revision, { type: "card", name: "Visa", cardholder: "Ada", number: "4242424242424242", expiryMonth: 4, expiryYear: 2029, cvv: "999" });
  state = await vault.saveItem(state.session, state.revision, { type: "identity", name: "Ada L", firstName: "Ada", lastName: "Lovelace", email: "ada@example.test", address: "secret street", city: "London", country: "UK" });
  const cards = vault.list(state.session).filter(item => item.type === "card");
  assert.equal(cards[0].last4, "4242");
  assert.equal(cards[0].brand, "Visa");
  assert.equal("number" in cards[0] || "cvv" in cards[0], false, "PAN and CVV stay out of summaries");
  const ids = vault.list(state.session).filter(item => item.type === "identity");
  assert.equal(ids[0].fullName, "Ada Lovelace");
  assert.equal("address" in ids[0], false, "Street address stays out of summaries");
  // Search finds a card by its last four or holder, an ID by name or email.
  assert.equal(vault.list(state.session, "4242").filter(item => item.type === "card").length, 1);
  assert.equal(vault.list(state.session, "ada@").filter(item => item.type === "identity").length, 1);
  // A URL-filtered list never surfaces cards: they are not site-bound.
  assert.equal(vault.list(state.session, "", "https://shop.example/checkout").filter(item => item.type === "card").length, 0);
});

test("CSV export skips cards and IDs; a shared card round-trips through the backup path", async () => {
  const storage = memoryStorage();
  const vault = new Vault(storage);
  let state = await vault.create(password);
  state = await vault.saveItem(state.session, state.revision, { type: "card", name: "Visa", cardholder: "Ada", number: "4242424242424242", expiryMonth: 4, expiryYear: 2029, cvv: "123" });
  state = await vault.saveItem(state.session, state.revision, { type: "identity", name: "Ada", firstName: "Ada", email: "ada@example.test" });
  // Plain-text CSV never includes cards or IDs — only logins and notes.
  assert.doesNotMatch(vault.exportCsv(state.session), /4242|ada@example/);
  // A card shared as a .kvault keeps its secrets and gets a fresh id.
  const cardId = vault.list(state.session).find(item => item.type === "card").id;
  const { payload } = await decryptVault(await vault.shareItem(state.session, cardId, "a share passphrase"), "a share passphrase");
  assert.equal(payload.items[0].number, "4242424242424242");
  assert.equal(payload.items[0].cvv, "123");
  assert.notEqual(payload.items[0].id, cardId);
  // Trash/restore keeps the fields intact.
  const before = vault.list(state.session).length;
  state = await vault.deleteItem(state.session, state.revision, cardId);
  assert.equal(vault.list(state.session).filter(item => item.type === "card").length, 0);
  assert.equal(vault.listDeleted(state.session).length, 1);
  state = await vault.restoreItem(state.session, state.revision, cardId);
  assert.equal(vault.list(state.session).length, before);
  assert.equal(vault.item(state.session, cardId).number, "4242424242424242", "Restored card keeps its fields");
});
