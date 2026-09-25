// Dependency-free mutation testing. For each source file under test, generate
// small semantic changes (flip a comparison, swap and/or, change a number, drop
// a negation, ...), run that language's test suite against each mutant in a
// scratch copy of the repo, and report mutants that no test caught.
//
//   node scripts/mutation.mjs [--suite js|python|all] [--min 80] [--jobs N] [--files a.ts,b.py]
//
// Lines containing a `mutation-ignore: <reason>` comment are skipped; use it only
// for equivalent mutants or tunable values, and say why.
//
// Browser-only code (src/content/index.ts, extract.ts, popup, options pages) is
// not mutated: the Node suite cannot execute it. Those are covered by
// test/browser. The Python suite needs local-server/.venv and permission to
// bind a local port (its HTTP tests start a real server).
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const TIMEOUT_MS = 90_000;

// ---- per-language rules ----

const JS_OPERATORS = [
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

const PY_OPERATORS = [
  [/ == /g, " != ", "equality"],
  [/ != /g, " == ", "equality"],
  [/ >= /g, " > ", "boundary"],
  [/ <= /g, " < ", "boundary"],
  [/ > /g, " >= ", "boundary"],
  [/ < /g, " <= ", "boundary"],
  [/ and /g, " or ", "logical"],
  [/ or /g, " and ", "logical"],
  [/\bnot (?!in\b)/g, "", "negation"],
  [/ not in /g, " in ", "membership"],
  [/(?<!not) in (?=[\w(\[{"'])/g, " not in ", "membership"],
  [/ is None/g, " is not None", "identity"],
  [/ is not None/g, " is None", "identity"],
  [/ \+ /g, " - ", "arithmetic"],
  [/ - /g, " + ", "arithmetic"],
  [/ \* /g, " / ", "arithmetic"],
  [/\bTrue\b/g, "False", "boolean"],
  [/\bFalse\b/g, "True", "boolean"],
  [/\.strip\(\)/g, "", "method"],
  [/\bcontinue\b/g, "pass", "statement"],
  [/\breturn$/g, "pass", "statement"],
];

// Blank out string literals and trailing comments so operators inside them are
// not mutated. Returns a same-length line.
function maskLine(line, { commentStart, regex }) {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (line.startsWith(commentStart, i)) return out + " ".repeat(line.length - i);
    if (c === '"' || c === "'" || (c === "`" && regex)) {
      let j = i + 1;
      while (j < line.length && line[j] !== c) j += line[j] === "\\" ? 2 : 1;
      out += c + " ".repeat(Math.max(0, Math.min(j, line.length) - i - 1)) + (j < line.length ? c : "");
      i = j + 1;
      continue;
    }
    const prev = out.trimEnd().slice(-1);
    if (regex && c === "/" && (prev === "" || "(,=:!&|?;{[".includes(prev) || /\breturn$/.test(out.trimEnd()))) {
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

const SUITES = {
  js: {
    targets: [
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
    ],
    operators: JS_OPERATORS,
    mask: { commentStart: "//", regex: true },
    skip: /^\s*(\/\/|\*|\/\*|import\s|export\s+(type|interface)\s|interface\s|type\s|declare\s|\|)/,
    blockStart: /^(export\s+)?interface\s/,
    blockEnd: /^}/,
    command: [process.execPath, "--test", "--test-reporter=dot", "test/unit/**/*.test.ts", "test/integration/**/*.test.ts"],
    cwd: ".",
  },
  python: {
    targets: ["local-server/quiet_feed_local/app.py", "local-server/quiet_feed_local/__main__.py"],
    operators: PY_OPERATORS,
    mask: { commentStart: "#", regex: false },
    skip: /^\s*(#|import\s|from\s|@|class\s)/,
    // Docstrings and other triple-quoted blocks.
    triple: true,
    command: [".venv/bin/python", "-m", "unittest", "discover", "-s", "tests", "-t", "."],
    cwd: "local-server",
  },
};

function numberMutation(text) {
  if (text.includes(".")) {
    const v = Number(text);
    return String(Math.round((v + (v < 0.9 ? 0.1 : -0.1)) * 1000) / 1000);
  }
  return text === "0" ? "1" : String(Number(text) - 1);
}

function mutantsFor(file, suite) {
  const lines = readFileSync(file, "utf8").split("\n");
  const out = [];
  let inBlock = false;
  let inTriple = false;
  lines.forEach((line, idx) => {
    if (suite.triple) {
      const quotes = (line.match(/"""|'''/g) || []).length;
      if (inTriple || quotes > 0) {
        if (quotes % 2 === 1) inTriple = !inTriple;
        return;
      }
    }
    if (suite.blockStart?.test(line)) inBlock = true;
    if (inBlock) {
      if (suite.blockEnd.test(line)) inBlock = false;
      return;
    }
    if (suite.skip.test(line) || line.includes("mutation-ignore")) return;
    const m = maskLine(line, suite.mask);
    const add = (start, end, replacement, kind) => {
      const mutated = line.slice(0, start) + replacement + line.slice(end);
      if (mutated !== line) out.push({ file, line: idx + 1, kind, original: line.trim(), mutated: mutated.trim(), lineIdx: idx, text: mutated });
    };
    for (const [re, rep, kind] of suite.operators) {
      for (const hit of m.matchAll(re)) add(hit.index, hit.index + hit[0].length, rep, kind);
    }
    for (const hit of m.matchAll(/(?<![\w.$])\d+(\.\d+)?(?![\w.])/g)) {
      add(hit.index, hit.index + hit[0].length, numberMutation(hit[0]), "number");
    }
  });
  return out;
}

// ---- execution ----

function makeWorkspace() {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "qf-mutation-"));
  for (const p of ["src", "test", "scripts", "package.json"]) cpSync(p, join(dir, p), { recursive: true });
  if (existsSync("local-server")) {
    cpSync("local-server", join(dir, "local-server"), {
      recursive: true,
      filter: (src) => !/(^|\/)(\.venv|__pycache__)(\/|$)/.test(src),
    });
    if (existsSync("local-server/.venv")) symlinkSync(resolve("local-server/.venv"), join(dir, "local-server/.venv"));
  }
  return dir;
}

function runTests(ws, suite) {
  return new Promise((resolveRun) => {
    const [cmd, ...cmdArgs] = suite.command;
    const child = spawn(cmd.startsWith(".") ? join(ws, suite.cwd, cmd) : cmd, cmdArgs, { cwd: join(ws, suite.cwd), stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveRun("timeout");
    }, TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      resolveRun("error");
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolveRun(code === 0 ? "survived" : "killed");
    });
  });
}

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const minScore = Number(opt("min", "0"));
const jobs = Number(opt("jobs", String(Math.max(1, Math.min(8, availableParallelism() - 1)))));
const fileFilter = opt("files", "") ? opt("files", "").split(",") : null;
const suiteNames = opt("suite", "all") === "all" ? Object.keys(SUITES) : [opt("suite", "all")];

async function main() {
  const planned = [];
  for (const name of suiteNames) {
    const suite = SUITES[name];
    if (!suite) throw new Error(`unknown suite ${name}`);
    if (name === "python" && !existsSync("local-server/.venv")) {
      console.log("Skipping the python suite: local-server/.venv does not exist (see README).");
      continue;
    }
    const targets = fileFilter ? suite.targets.filter((t) => fileFilter.includes(t)) : suite.targets;
    for (const t of targets) for (const m of mutantsFor(t, suite)) planned.push({ ...m, suite: name });
  }
  console.log(`Generated ${planned.length} mutants (${suiteNames.join(", ")}); running with ${jobs} workers.`);

  // Every suite must pass unmutated first.
  const baseline = makeWorkspace();
  for (const name of new Set(planned.map((m) => m.suite))) {
    if ((await runTests(baseline, SUITES[name])) !== "survived") {
      rmSync(baseline, { recursive: true, force: true });
      console.error(`Baseline ${name} test run failed; fix the suite before mutation testing.`);
      process.exit(2);
    }
  }
  rmSync(baseline, { recursive: true, force: true });

  const results = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    const ws = makeWorkspace();
    try {
      while (next < planned.length) {
        const mu = planned[next++];
        const target = join(ws, mu.file);
        const original = readFileSync(mu.file, "utf8");
        const lines = original.split("\n");
        lines[mu.lineIdx] = mu.text;
        writeFileSync(target, lines.join("\n"));
        const status = await runTests(ws, SUITES[mu.suite]);
        writeFileSync(target, original);
        results.push({ ...mu, status });
        done++;
        if (process.stdout.isTTY) process.stdout.write(`\r${done}/${planned.length}`);
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
    if (r.status === "killed" || r.status === "timeout") f.killed++;
    byFile.set(r.file, f);
  }
  console.log("\nFile                                          Killed / Total   Score");
  for (const [file, f] of [...byFile].sort()) {
    console.log(`${file.padEnd(46)}${`${f.killed} / ${f.total}`.padStart(14)}   ${((100 * f.killed) / f.total).toFixed(1)}%`);
  }
  // A mutant whose test run could not start proves nothing, so it does not count as killed.
  const killed = results.filter((r) => r.status === "killed" || r.status === "timeout").length;
  const score = results.length ? (100 * killed) / results.length : 100;
  const count = (s) => results.filter((r) => r.status === s).length;
  console.log(`\nMutation score: ${score.toFixed(1)}% (${killed}/${results.length} killed, ${count("timeout")} by timeout, ${count("error")} failed to start)`);

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
