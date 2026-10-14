import { mkdirSync, writeFileSync } from "node:fs";
import { Sandbox } from "./sandbox.js";
import { dataDir, saveTask, type Task } from "./tasks.js";
import type { Config } from "./project.js";
import { pool } from "./util.js";

export interface ValidateOptions {
  parallel: number;
  timeoutMs: number;
  keep?: boolean;
}

// A task is only fair if the new tests fail on the old code and pass on the fixed code.
export async function validateTask(root: string, task: Task, cfg: Config, opts: ValidateOptions): Promise<Task> {
  const box = new Sandbox(root, task, cfg);
  const log: string[] = [];
  const result = (status: Task["status"], reason?: string): Task => ({ ...task, status, reason });

  try {
    box.create();
    const setup = await box.setup(opts.timeoutMs);
    if (setup) log.push(`$ ${cfg.setup}\n${setup.out}`);
    if (setup && setup.code !== 0) return result("invalid", "setup failed");

    box.apply(task.testFiles);
    const before = await box.runTests(opts.timeoutMs);
    log.push(`--- tests at base (should fail) ---\n${before.out}`);
    if (before.timedOut) return result("invalid", "tests timed out at base");
    if (before.code === 0) return result("invalid", "tests already pass before the fix");
    if (before.code === 127) return result("invalid", "test command not found");

    box.apply(task.sourceFiles);
    const after = await box.runTests(opts.timeoutMs);
    log.push(`--- tests at fix (should pass) ---\n${after.out}`);
    if (after.code !== 0) return result("invalid", after.timedOut ? "tests timed out at fix" : "tests still fail after the fix");

    return result("valid");
  } catch (e: any) {
    log.push(String(e.stderr ?? e.message));
    return result("invalid", String(e.message).split("\n")[0]);
  } finally {
    mkdirSync(dataDir(root, "logs"), { recursive: true });
    writeFileSync(dataDir(root, "logs", `validate-${task.id}.log`), log.join("\n\n"));
    if (!opts.keep) box.dispose();
  }
}

export async function validate(
  root: string,
  tasks: Task[],
  cfg: Config,
  opts: ValidateOptions,
  onDone: (t: Task) => void
) {
  const out: Task[] = [];
  await pool(tasks, opts.parallel, async (t) => {
    const v = await validateTask(root, t, cfg, opts);
    saveTask(root, v);
    out.push(v);
    onDone(v);
  });
  return out;
}
