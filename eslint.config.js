import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "keybit.zip"] },
  js.configs.recommended,
  {
    files: ["src/**/*.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...globals.browser, ...globals.webextensions } },
    // Clearing a variable that held a password ("password = ''") is deliberate: it drops the reference early.
    rules: { "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }], "no-empty": ["error", { allowEmptyCatch: true }], "no-useless-assignment": "off" }
  },
  {
    // Content scripts and the theme boot script are classic scripts, not modules.
    files: ["src/content/**/*.js", "src/peek/**/*.js", "src/ui/theme.js"],
    languageOptions: { sourceType: "script" }
  },
  {
    files: ["eslint.config.js", "scripts/**/*.mjs"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...globals.node, ...globals.browser, chrome: "readonly" } },
    rules: { "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }] }
  }
];
