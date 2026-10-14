import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shellQuote } from "../src/util.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const windows = process.platform === "win32";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "unfix e2e "));
  const write = (p: string, s: string) => {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), s);
  };
  const commit = (msg: string) => {
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", msg], { cwd: dir });
  };
  const testFile = (expr: string) =>
    `import {test} from "node:test";\nimport assert from "node:assert";\nimport {add} from "../src/add.js";\ntest("a", () => assert.equal(${expr}));\n`;

  execFileSync("git", ["init", "-q"], { cwd: dir });
  write("package.json", '{"type":"module","scripts":{"test":"node --test"}}\n');
  write("src/add.js", "export const add = (a, b) => a - b;\n");
  write("test/add.test.js", testFile("add(0, 0), 0"));
  commit("initial");
  write("src/add.js", "export const add = (a, b) => a + b;\n");
  write("test/add.test.js", testFile("add(2, 2), 4"));
  commit("fix: add subtracts instead of adding\n\nadd(2, 2) returns 0.");
  return dir;
}

// Agents are small node scripts so this runs the same on every OS.
function agents() {
  const dir = mkdtempSync(join(tmpdir(), "unfix agents "));
  const script = (name: string, body: string) => {
    const p = join(dir, name);
    writeFileSync(p, `import fs from "node:fs";\n${body}\n`);
    return p;
  };
  const fix = `fs.writeFileSync("src/add.js", fs.readFileSync("src/add.js", "utf8").replace("a - b", "a + b"));`;

  const good = script("good.mjs", fix);
  const cheat = script("cheat.mjs", `fs.writeFileSync("test/add.test.js", 'import {test} from "node:test"; test("x", () => {});');`);
  const peek = script("peek.mjs", `
    import { execSync } from "node:child_process";
    const log = execSync("git log --all --oneline").toString();
    fs.writeFileSync(process.env.UNFIX_PROBLEM_FILE + ".seen", String(log.trim().split("\\n").length));`);

  // A stand-in for the real \`claude\` CLI: reads the prompt on stdin, fixes the bug,
  // and prints JSON with a cost like the real one does.
  const fake = script("fake-claude.mjs", `
    const prompt = fs.readFileSync(0, "utf8");
    if (!prompt.includes("add subtracts")) { console.error("no prompt on stdin"); process.exit(3); }
    ${fix}
    console.log(JSON.stringify({ type: "result", total_cost_usd: 0.42 }));`);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  if (windows) writeFileSync(join(bin, "claude.cmd"), `@node "${fake}" %*\r\n`);
  else {
    writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec node "${fake}" "$@"\n`);
    chmodSync(join(bin, "claude"), 0o755);
  }
  return { dir, bin, good, cheat, peek };
}

const unfix = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", ...env } });

const results = (dir: string, label: string) => JSON.parse(readFileSync(join(dir, ".unfix", "runs", `${label}.json`), "utf8")).results;

test("mine → validate → run → compare, in a path with spaces", () => {
  const dir = repo();
  const a = agents();
  try {
    assert.match(unfix(dir, ["mine"]), /1 new task/);
    assert.match(unfix(dir, ["validate"]), /1 of 1 usable/);

    unfix(dir, ["run", "--agent", "cmd", "--cmd", `node ${shellQuote(a.cheat)}`, "--label", "cheat"]);
    unfix(dir, ["run", "--agent", "cmd", "--cmd", `node ${shellQuote(a.good)} {problem_file}`, "--label", "good"]);
    assert.equal(results(dir, "cheat")[0].solved, false, "editing the tests must not count");
    assert.equal(results(dir, "good")[0].solved, true);

    const cmp = JSON.parse(unfix(dir, ["compare", "cheat", "good", "--json"]));
    assert.equal(cmp.deltaPP, 100);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    rmSync(a.dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("the agent can't see the fix in git history", () => {
  const dir = repo();
  const a = agents();
  try {
    unfix(dir, ["mine"]);
    unfix(dir, ["run", "--agent", "cmd", "--include-unvalidated", "--cmd", `node ${shellQuote(a.peek)}`, "--label", "peek"]);
    const id = results(dir, "peek")[0].id;
    const seen = readFileSync(join(dir, ".unfix", "runs", "peek", `${id}.problem.md.seen`), "utf8");
    assert.equal(seen, "1");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    rmSync(a.dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("--agent claude-code gets the prompt on stdin and reports cost", () => {
  const dir = repo();
  const a = agents();
  try {
    unfix(dir, ["mine"]);
    unfix(dir, ["validate"]);
    // Windows spells it Path, and env keys there are case-insensitive, so replace whichever exists.
    const key = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    unfix(dir, ["run", "--agent", "claude-code", "--label", "cc"], { [key]: a.bin + delimiter + process.env[key] });
    const [r] = results(dir, "cc");
    assert.equal(r.solved, true, JSON.stringify(r));
    assert.equal(r.costUsd, 0.42);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    rmSync(a.dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
