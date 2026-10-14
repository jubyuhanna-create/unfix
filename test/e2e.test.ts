import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "unfix-e2e-"));
  const write = (p: string, s: string) => {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), s);
  };
  const commit = (msg: string) => {
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", msg], { cwd: dir });
  };
  execFileSync("git", ["init", "-q"], { cwd: dir });
  write("package.json", '{"type":"module","scripts":{"test":"node --test"}}');
  write("src/add.js", "export const add = (a, b) => a - b;\n");
  write("test/add.test.js", 'import {test} from "node:test";import assert from "node:assert";import {add} from "../src/add.js";\ntest("a",()=>assert.equal(add(0,0),0));\n');
  commit("initial");
  write("src/add.js", "export const add = (a, b) => a + b;\n");
  write("test/add.test.js", 'import {test} from "node:test";import assert from "node:assert";import {add} from "../src/add.js";\ntest("a",()=>assert.equal(add(2,2),4));\n');
  commit("fix: add subtracts instead of adding");
  return dir;
}

const unfix = (cwd: string, ...args: string[]) => execFileSync("node", [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });

test("mine → validate → run → compare", () => {
  const dir = repo();
  try {
    assert.match(unfix(dir, "mine"), /1 new task/);
    assert.match(unfix(dir, "validate"), /1 of 1 usable/);

    const agents = join(dir, "..", `agents-${Date.now()}`);
    mkdirSync(agents);
    writeFileSync(join(agents, "good.sh"), "#!/bin/sh\nsed -i.bak 's/a - b/a + b/' src/add.js && rm src/add.js.bak\n");
    // Rewrites the test to always pass. The grader should throw that away.
    writeFileSync(join(agents, "cheat.sh"), "#!/bin/sh\necho 'import {test} from \"node:test\";test(\"x\",()=>{})' > test/add.test.js\n");
    chmodSync(join(agents, "good.sh"), 0o755);
    chmodSync(join(agents, "cheat.sh"), 0o755);

    unfix(dir, "run", "--agent", "cmd", "--cmd", join(agents, "cheat.sh"), "--label", "cheat");
    unfix(dir, "run", "--agent", "cmd", "--cmd", join(agents, "good.sh"), "--label", "good");

    const cheat = JSON.parse(readFileSync(join(dir, ".unfix/runs/cheat.json"), "utf8"));
    const good = JSON.parse(readFileSync(join(dir, ".unfix/runs/good.json"), "utf8"));
    assert.equal(cheat.results[0].solved, false);
    assert.equal(good.results[0].solved, true);

    const cmp = JSON.parse(unfix(dir, "compare", "cheat", "good", "--json"));
    assert.equal(cmp.deltaPP, 100);
    rmSync(agents, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
