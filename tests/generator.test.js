import test from "node:test";
import assert from "node:assert/strict";
import { generatePassword, GROUPS } from "../src/generator/password-generator.js";

test("secure generator satisfies selected length and every selected group", () => {
  const previous = Math.random;
  Math.random = () => { throw new Error("Insecure randomness"); };
  try {
    for (let i = 0; i < 100; i++) {
      const password = generatePassword({ length: 24 });
      assert.equal(password.length, 24);
      for (const group of Object.values(GROUPS)) assert.ok([...password].some(char => group.includes(char)));
    }
    assert.match(generatePassword({ length: 32, uppercase: false, lowercase: false, symbols: false }), /^\d{32}$/);
    assert.throws(() => generatePassword({ uppercase: false, lowercase: false, numbers: false, symbols: false }));
    assert.throws(() => generatePassword({ length: 7 }));
  } finally { Math.random = previous; }
});
