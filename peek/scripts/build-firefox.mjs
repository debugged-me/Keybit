// Copies the extension into dist/firefox with manifest.firefox.json swapped in as the manifest.
// Load it via about:debugging → This Firefox → Load Temporary Add-on.
import { cpSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "firefox");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const entry of ["src", "icons"]) cpSync(join(root, entry), join(out, entry), { recursive: true });
copyFileSync(join(root, "manifest.firefox.json"), join(out, "manifest.json"));
console.log(`Firefox build ready at ${out}`);
