import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitBuf } from "./git.js";
import { exec, type ExecResult } from "./util.js";
import { testCommand, type Config } from "./project.js";
import type { Task } from "./tasks.js";

const ID = ["-c", "user.name=unfix", "-c", "user.email=unfix@localhost", "-c", "commit.gpgsign=false"];
export const BASE_TAG = "unfix-base";

// A sandbox is a plain snapshot of the base commit with a brand-new git history.
// The agent can't `git log` its way to the answer because the fix doesn't exist here.
export class Sandbox {
  readonly dir: string;

  constructor(
    readonly repo: string,
    readonly task: Task,
    readonly cfg: Config
  ) {
    this.dir = mkdtempSync(join(process.env.UNFIX_TMP ?? tmpdir(), "unfix-"));
  }

  create(prepare?: (dir: string) => void) {
    const tar = gitBuf(this.repo, ["archive", "--format=tar", this.task.base]);
    execFileSync("tar", ["-x", "-C", this.dir], { input: tar, maxBuffer: 1 << 30 });
    // If someone committed .unfix/, it holds the answers. Never ship it to the agent.
    rmSync(join(this.dir, ".unfix"), { recursive: true, force: true });
    prepare?.(this.dir);
    this.git(["init", "-q"]);
    this.git(["add", "-A"]);
    this.git([...ID, "commit", "-q", "--no-verify", "-m", "base"]);
    this.git(["tag", BASE_TAG]);
  }

  git(args: string[], input?: string | Buffer) {
    return git(this.dir, args, input);
  }

  patch(paths: string[]) {
    return gitBuf(this.repo, ["diff", "--binary", this.task.base, this.task.fix, "--", ...paths]);
  }

  apply(paths: string[]) {
    const diff = this.patch(paths);
    if (diff.length) this.git(["apply", "--whitespace=nowarn", "-"], diff);
  }

  // Put the test files back exactly as they were at base, throwing away anything
  // the agent did to them, then bring in the tests from the fix commit.
  resetTestsAndApplyFix() {
    const atBase = this.git(["ls-tree", "-r", "--name-only", BASE_TAG, "--", ...this.task.testFiles])
      .split("\n")
      .filter(Boolean);
    if (atBase.length) this.git(["checkout", BASE_TAG, "--", ...atBase]);
    for (const f of this.task.testFiles) {
      if (!atBase.includes(f)) rmSync(join(this.dir, f), { force: true });
    }
    this.apply(this.task.testFiles);
  }

  setup(timeoutMs: number): Promise<ExecResult | undefined> {
    if (!this.cfg.setup) return Promise.resolve(undefined);
    return exec(this.cfg.setup, { cwd: this.dir, timeoutMs });
  }

  runTests(timeoutMs: number) {
    const present = this.task.testFiles.filter((f) => existsSync(join(this.dir, f)));
    return exec(testCommand(this.cfg, present.length ? present : this.task.testFiles), {
      cwd: this.dir,
      timeoutMs,
      env: { CI: "1", FORCE_COLOR: "0" },
    });
  }

  dispose() {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
