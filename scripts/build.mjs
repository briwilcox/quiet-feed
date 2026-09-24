import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

for (const f of ["manifest.json", "popup/popup.html", "options/options.html", "shared/ui.css"]) {
  cpSync(`src/${f}`, `dist/${f}`);
}

const ctx = await esbuild.context({
  entryPoints: {
    background: "src/background/index.ts",
    content: "src/content/index.ts",
    "popup/popup": "src/popup/popup.ts",
    "options/options": "src/options/options.ts",
  },
  outdir: "dist",
  bundle: true,
  format: "esm",
  target: "chrome120",
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
