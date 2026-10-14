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
    // Check the base commit out into our folder through a throwaway index, so the
    // user's own index and working tree are never touched. Line endings stay
    // exactly as committed (no autocrlf), otherwise patches won't apply on Windows.
    const index = join(this.dir, ".unfix-index");
    const env = { GIT_INDEX_FILE: index };
    git(this.repo, ["-c", "core.autocrlf=false", "read-tree", this.task.base], undefined, env);
    git(this.repo, ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "checkout-index", "-a", "-f", `--prefix=${this.dir.replace(/\\/g, "/")}/`], undefined, env);
    rmSync(index, { force: true });

    // If someone committed .unfix/, it holds the answers. Never ship it to the agent.
    rmSync(join(this.dir, ".unfix"), { recursive: true, force: true });
    prepare?.(this.dir);
    this.git(["init", "-q"]);
    this.git(["config", "core.autocrlf", "false"]);
    this.git(["config", "core.safecrlf", "false"]);
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
    // Windows keeps files locked for a moment after a process exits.
    try {
      rmSync(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {}
  }
}
