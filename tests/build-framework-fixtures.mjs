// Optional test-only bundles. Libraries are installed outside the extension directory.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const dependencies = process.argv[2];
const output = process.argv[3];
if (!dependencies || !output) throw new Error('Usage: node tests/build-framework-fixtures.mjs <dependency-directory> <output-directory>');
const {build} = await import(pathToFileURL(resolve(dependencies, 'node_modules/esbuild/lib/main.js')));
await mkdir(output, {recursive:true});
for (const name of ['react', 'vue', 'jquery']) {
  await build({entryPoints:[fileURLToPath(new URL(`./frameworks/${name}.js`, import.meta.url))], outfile:join(output,`framework-${name}.js`),
    nodePaths:[resolve(dependencies,'node_modules')], bundle:true, format:'iife',
    define:{'process.env.NODE_ENV':'"production"',__VUE_OPTIONS_API__:'true',__VUE_PROD_DEVTOOLS__:'false',__VUE_PROD_HYDRATION_MISMATCH_DETAILS__:'false'}});
  await writeFile(join(output,`framework-${name}.html`),`<!doctype html><title>${name} login fixture</title><link rel="stylesheet" href="fixture.css"><main><h1>${name} login</h1><div id="mount"></div></main><script src="framework-${name}.js"></script>`);
}
