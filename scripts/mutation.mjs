// Dependency-free mutation testing. For each source file under test, generate
// small semantic changes (flip a comparison, swap && and ||, change a number,
// drop a negation, ...), run the Node test suite against each mutant in a
// scratch copy of the repo, and report mutants that no test caught.
//
//   node scripts/mutation.mjs [--min 80] [--jobs N] [--files src/background/decide.ts,...]
//
// Lines containing a `mutation-ignore: <reason>` comment are skipped; use it only
// for equivalent mutants or tunable values, and say why.
//
// Browser-only code (src/content/index.ts, extract.ts, popup, options) is not
// mutated: the Node suite cannot execute it. Those are covered by test/browser.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_TARGETS = [
  "src/background/badge.ts",
  "src/background/cache.ts",
  "src/background/decide.ts",
  "src/background/gliner.ts",
  "src/background/index.ts",
  "src/background/jev.ts",
  "src/background/keystore.ts",
  "src/background/local.ts",
  "src/background/queue.ts",
  "src/content/tally.ts",
  "src/popup/reveal.ts",
  "src/shared/format.ts",
  "src/shared/settings.ts",
];
const TEST_CMD = ["--test", "--test-reporter=dot", "test/unit/**/*.test.ts", "test/integration/**/*.test.ts"];
const TIMEOUT_MS = 60_000;

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const minScore = Number(opt("min", "0"));
const jobs = Number(opt("jobs", String(Math.max(1, Math.min(8, availableParallelism() - 1)))));
const targets = opt("files", "") ? opt("files", "").split(",") : DEFAULT_TARGETS;

// ---- mutant generation ----

// Blank out string, template, and regex literals and trailing comments so
// operators inside them are not mutated. Returns a same-length line.
function mask(line) {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === "/" && line[i + 1] === "/") return out + " ".repeat(line.length - i);
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < line.length && line[j] !== c) j += line[j] === "\\" ? 2 : 1;
      out += c + " ".repeat(Math.max(0, Math.min(j, line.length) - i - 1)) + (j < line.length ? c : "");
      i = j + 1;
      continue;
    }
    const prev = out.trimEnd().slice(-1);
    if (c === "/" && (prev === "" || "(,=:!&|?;{[".includes(prev) || /\breturn$/.test(out.trimEnd()))) {
      let j = i + 1;
      let inClass = false;
      while (j < line.length && (line[j] !== "/" || inClass)) {
        if (line[j] === "\\") j++;
        else if (line[j] === "[") inClass = true;
        else if (line[j] === "]") inClass = false;
        j++;
      }
      if (j < line.length) {
        out += "/" + " ".repeat(j - i - 1) + "/";
        i = j + 1;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

const OPERATORS = [
  [/ === /g, " !== ", "equality"],
  [/ !== /g, " === ", "equality"],
  [/ >= /g, " > ", "boundary"],
  [/ <= /g, " < ", "boundary"],
  [/ > /g, " >= ", "boundary"],
  [/ < /g, " <= ", "boundary"],
  [/ && /g, " || ", "logical"],
  [/ \|\| /g, " && ", "logical"],
  [/ \?\? /g, " && ", "nullish"],
  [/ \+ /g, " - ", "arithmetic"],
  [/ - /g, " + ", "arithmetic"],
  [/ \* /g, " / ", "arithmetic"],
  [/\+\+/g, "--", "update"],
  [/\btrue\b/g, "false", "boolean"],
  [/\bfalse\b/g, "true", "boolean"],
  [/(?<=[\s(])!(?=[\w(.])/g, "", "negation"],
  [/\bcontinue;/g, ";", "statement"],
  [/\.some\(/g, ".every(", "method"],
  [/\.every\(/g, ".some(", "method"],
  [/Math\.max\(/g, "Math.min(", "method"],
  [/Math\.min\(/g, "Math.max(", "method"],
  [/\.startsWith\(/g, ".endsWith(", "method"],
  [/\.trim\(\)/g, "", "method"],
  [/\.toLowerCase\(\)/g, "", "method"],
];

function numberMutation(text) {
  if (text.includes(".")) {
    const v = Number(text);
    return String(Math.round((v + (v < 0.9 ? 0.1 : -0.1)) * 1000) / 1000);
  }
  return text === "0" ? "1" : String(Number(text) - 1);
}

const SKIP_LINE = /^\s*(\/\/|\*|\/\*|import\s|export\s+(type|interface)\s|interface\s|type\s|\|)/;

function mutantsFor(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  const out = [];
  let inInterface = false;
  lines.forEach((line, idx) => {
    if (/^(export\s+)?interface\s/.test(line)) inInterface = true;
    if (inInterface) {
      if (/^}/.test(line)) inInterface = false;
      return;
    }
    if (SKIP_LINE.test(line) || line.includes("mutation-ignore")) return;
    const m = mask(line);
    const add = (start, end, replacement, kind) => {
      const mutated = line.slice(0, start) + replacement + line.slice(end);
      if (mutated !== line) out.push({ file, line: idx + 1, kind, original: line.trim(), mutated: mutated.trim(), lineIdx: idx, text: mutated });
    };
    for (const [re, rep, kind] of OPERATORS) {
      for (const hit of m.matchAll(re)) add(hit.index, hit.index + hit[0].length, rep, kind);
    }
    for (const hit of m.matchAll(/(?<![\w.$])\d+(\.\d+)?(?![\w.])/g)) {
      add(hit.index, hit.index + hit[0].length, numberMutation(hit[0]), "number");
    }
  });
  return out.map((mu, i) => ({ ...mu, id: `${file}#${i}` }));
}

// ---- execution ----

function makeWorkspace() {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "qf-mutation-"));
  for (const p of ["src", "test", "package.json"]) cpSync(p, join(dir, p), { recursive: true });
  return dir;
}

function runTests(cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, TEST_CMD, { cwd, stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("timeout");
    }, TIMEOUT_MS);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? "survived" : "killed");
    });
  });
}

async function main() {
  const all = targets.flatMap(mutantsFor);
  console.log(`Generated ${all.length} mutants across ${targets.length} files; running with ${jobs} workers.`);

  const baselineDir = makeWorkspace();
  const baseline = await runTests(baselineDir);
  rmSync(baselineDir, { recursive: true, force: true });
  if (baseline !== "survived") {
    console.error("Baseline test run failed; fix the suite before mutation testing.");
    process.exit(2);
  }

  const results = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    const ws = makeWorkspace();
    try {
      while (next < all.length) {
        const mu = all[next++];
        const target = join(ws, mu.file);
        const original = readFileSync(mu.file, "utf8");
        const lines = original.split("\n");
        lines[mu.lineIdx] = mu.text;
        writeFileSync(target, lines.join("\n"));
        const status = await runTests(ws);
        writeFileSync(target, original);
        results.push({ ...mu, status });
        done++;
        if (process.stdout.isTTY) process.stdout.write(`\r${done}/${all.length}`);
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  if (process.stdout.isTTY) process.stdout.write("\n");

  const byFile = new Map();
  for (const r of results) {
    const f = byFile.get(r.file) ?? { total: 0, killed: 0 };
    f.total++;
    if (r.status !== "survived") f.killed++;
    byFile.set(r.file, f);
  }
  console.log("\nFile                                  Killed / Total   Score");
  for (const [file, f] of [...byFile].sort()) {
    console.log(`${file.padEnd(38)}${`${f.killed} / ${f.total}`.padStart(14)}   ${((100 * f.killed) / f.total).toFixed(1)}%`);
  }
  const killed = results.filter((r) => r.status !== "survived").length;
  const score = (100 * killed) / results.length;
  console.log(`\nMutation score: ${score.toFixed(1)}% (${killed}/${results.length} killed, ${results.filter((r) => r.status === "timeout").length} by timeout)`);

  const survivors = results.filter((r) => r.status === "survived").sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  if (survivors.length) {
    console.log(`\nSurvivors (${survivors.length}):`);
    for (const s of survivors) console.log(`  ${s.file}:${s.line} [${s.kind}]\n    - ${s.original}\n    + ${s.mutated}`);
  }

  mkdirSync("reports", { recursive: true });
  writeFileSync(
    "reports/mutation-report.json",
    JSON.stringify({ score, killed, total: results.length, survivors: survivors.map(({ text, lineIdx, ...s }) => s) }, null, 2),
  );
  if (score < minScore) {
    console.error(`\nScore ${score.toFixed(1)}% is below --min ${minScore}.`);
    process.exit(1);
  }
}

await main();
