// Usage: npm run release -- 1.4.0
// Sets every public version reference, runs all checks, and builds keybit-<version>.zip.
// with only what the extension needs (manifest.json, icons/, src/).
import { readFile, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) { console.error("Usage: npm run release -- <major.minor.patch>"); process.exit(1); }
const json = async (file, change) => { const data = JSON.parse(await readFile(file, "utf8")); change(data); await writeFile(file, JSON.stringify(data, null, 2) + "\n"); };
await json("manifest.json", manifest => { manifest.version = version; });
await json("manifest.firefox.json", manifest => { manifest.version = version; });
await json("package.json", pkg => { pkg.version = version; });
await json("package-lock.json", lock => { lock.version = version; if (lock.packages?.[""]) lock.packages[""].version = version; });
const versionFile = await readFile("src/version.js", "utf8");
await writeFile("src/version.js", versionFile.replace(/VERSION = "[^"]+"/, `VERSION = "${version}"`));
const readme = await readFile("README.md", "utf8");
await writeFile("README.md", readme.replace(/version-[\d.]+-2E6B4F/, `version-${version}-2E6B4F`).replace(/alt="Version [\d.]+"/, `alt="Version ${version}"`));
execFileSync("npm", ["run", "check"], { stdio: "inherit" });
const zip = `keybit-${version}.zip`;
await rm(zip, { force: true });
execFileSync("zip", ["-qr", zip, "manifest.json", "icons", "src", "-x", "*.DS_Store"], { stdio: "inherit" });
console.log(`\nCreated ${zip}. Upload it at https://chrome.google.com/webstore/devconsole (and Edge Add-ons).`);
