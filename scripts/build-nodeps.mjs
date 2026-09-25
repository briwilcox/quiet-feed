// Fallback build that needs no npm packages: strips TypeScript types with
// Node's built-in stripper (Node 23.2+) and rewrites .ts imports to .js.
// Use `npm run build` (esbuild) when dependencies are installed.
import { stripTypeScriptTypes } from "node:module";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const SRC = "src";
const OUT = process.env.QF_DIST || "dist"; // tests build into a temporary folder
rmSync(OUT, { recursive: true, force: true });

function strip(file) {
  return stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "strip" });
}

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

// Module contexts (service worker, popup, options): one .js per .ts.
for (const file of walk(SRC)) {
  const rel = relative(SRC, file);
  const out = join(OUT, rel.replace(/\.ts$/, ".js"));
  mkdirSync(dirname(out), { recursive: true });
  if (rel.startsWith("content/")) continue;
  if (file.endsWith(".ts")) {
    writeFileSync(out, strip(file).replace(/(from\s+["'][^"']+)\.ts(["'])/g, "$1.js$2"));
  } else {
    cpSync(file, out);
  }
}
writeFileSync(join(OUT, "background.js"), 'import "./background/index.js";\n');
// Stamp this build so pages can tell when the running service worker is older.
const buildId = new Date().toISOString();
writeFileSync(join(OUT, "shared/build.js"), `export const BUILD_ID = ${JSON.stringify(buildId)};\n`);

// Content scripts cannot be ES modules: inline the content modules into one
// classic script. They import only types and each other, never shared runtime code.
const dropImports = (code) => code.replace(/^import[^;]*;\s*$/gm, "");
const helpers = readdirSync(join(SRC, "content"))
  .filter((f) => f.endsWith(".ts") && f !== "index.ts")
  .sort()
  .map((f) => dropImports(strip(join(SRC, "content", f))).replace(/^export\s+/gm, ""));
const main = dropImports(strip(join(SRC, "content/index.ts")));
writeFileSync(join(OUT, "content.js"), `(() => {\n${helpers.join("\n")}\n${main}\n})();\n`);

console.log("Built dist/ without dependencies");
