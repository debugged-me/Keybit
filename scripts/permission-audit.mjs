import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const baseline = JSON.parse(await readFile(new URL("security/permissions.json", root), "utf8"));
const unique = values => [...new Set(values ?? [])].sort();
const normalized = manifest => ({
  permissions: unique(manifest.permissions),
  optionalPermissions: unique(manifest.optional_permissions),
  hostPermissions: unique(manifest.host_permissions),
  optionalHostPermissions: unique(manifest.optional_host_permissions),
  contentMatches: unique((manifest.content_scripts ?? []).flatMap(script => script.matches ?? []))
});

let failed = false;
for (const [file, expected] of Object.entries(baseline)) {
  const manifest = JSON.parse(await readFile(new URL(file, root), "utf8"));
  const actual = normalized(manifest);
  if (JSON.stringify(actual) === JSON.stringify(expected)) continue;
  failed = true;
  process.stderr.write(`Unexpected extension permission change in ${file}.\nExpected: ${JSON.stringify(expected)}\nActual:   ${JSON.stringify(actual)}\n`);
}
if (failed) {
  process.stderr.write("Review the permission change, update security/permissions.json intentionally, and explain it in the release notes.\n");
  process.exitCode = 1;
} else process.stdout.write(`Permission baseline passed for ${Object.keys(baseline).length} manifests.\n`);
