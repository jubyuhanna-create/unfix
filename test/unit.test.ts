import { test } from "node:test";
import assert from "node:assert/strict";
import { isTestFile, isNoise, isTestCode, testCommand } from "../src/project.js";
import { cleanMessage, candidates } from "../src/mine.js";
import { gitSince, type Commit } from "../src/git.js";
import { invocation } from "../src/agents.js";
import { median, slug, shellQuote } from "../src/util.js";

test("recognises test files across ecosystems", () => {
  for (const p of ["src/a.test.ts", "lib/__tests__/x.js", "tests/test_api.py", "pkg/http_test.go", "spec/user_spec.rb", "src/test/java/FooTest.java"])
    assert.ok(isTestFile(p), p);
  for (const p of ["src/index.ts", "lib/contest.js", "attest.py"]) assert.ok(!isTestFile(p), p);
});

test("fixtures live in tests/ but aren't runnable test code", () => {
  assert.ok(isTestFile("tests/fixtures/data.json"));
  assert.ok(!isTestCode("tests/fixtures/data.json"));
  assert.ok(isTestCode("tests/test_api.py"));
});

test("ignores lockfiles and docs", () => {
  assert.ok(isNoise("package-lock.json"));
  assert.ok(isNoise("docs/guide.md"));
  assert.ok(!isNoise("src/main.rs"));
});

test("test command fills in files and dirs", () => {
  assert.equal(testCommand({ test: "npx vitest run {files}" }, ["src/a.test.ts", "tests/fixtures/x.json"]), "npx vitest run src/a.test.ts");
  assert.equal(testCommand({ test: "go test {dirs}" }, ["pkg/http/a_test.go", "pkg/http/b_test.go"]), "go test ./pkg/http");
  assert.equal(testCommand({ test: "pytest {files}" }, ["tests/it's.py"]), `pytest 'tests/it'\\''s.py'`);
});

test("commit messages lose trailers and PR numbers", () => {
  assert.equal(cleanMessage("fix: thing (#42)", "Details.\n\nSigned-off-by: a <a@b>"), "fix: thing\n\nDetails.");
});

const commit = (subject: string, files: [string, number][]): Commit => ({
  sha: "b".repeat(40),
  parent: "a".repeat(40),
  date: "2026-01-01T00:00:00Z",
  subject,
  body: "",
  files: files.map(([path, n]) => ({ path, added: n, removed: 0 })),
});

test("candidates need both code and tests", () => {
  const opts = { since: "1y", max: 10, maxFiles: 4, maxLines: 200 };
  const got = candidates(
    [
      commit("fix: a", [["src/a.ts", 3], ["src/a.test.ts", 5]]),
      commit("fix: only tests", [["src/a.test.ts", 5]]),
      commit("fix: only code", [["src/a.ts", 5]]),
      commit("fix: huge", [["src/a.ts", 900], ["src/a.test.ts", 5]]),
      commit("Revert \"fix: a\"", [["src/a.ts", 3], ["src/a.test.ts", 5]]),
      commit("add feature", [["src/b.ts", 3], ["src/b.test.ts", 5]]),
    ],
    opts
  );
  assert.deepEqual(got.map((g) => g.commit.subject), ["fix: a"]);
  assert.equal(candidates([commit("add feature", [["src/b.ts", 3], ["src/b.test.ts", 5]])], { ...opts, anyMessage: true }).length, 1);
});

test("agent invocations", () => {
  const cc = invocation({ agent: "claude-code", model: "opus" }, "bug", "/p.md").command as string[];
  assert.equal(cc[0], "claude");
  assert.deepEqual(cc.slice(-2), ["--model", "opus"]);
  assert.equal(invocation({ agent: "cmd", cmd: "./a.sh {problem_file}" }, "bug", "/tmp/my p.md").command, "./a.sh '/tmp/my p.md'");
  assert.throws(() => invocation({ agent: "nope" }, "", ""));
});

test("small helpers", () => {
  assert.equal(gitSince("2y"), "2 years ago");
  assert.equal(gitSince("2024-01-01"), "2024-01-01");
  assert.equal(slug("Fix: Crash on   empty input!"), "fix-crash-on-empty-input");
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([]), undefined);
  assert.equal(shellQuote("a b"), "'a b'");
});
