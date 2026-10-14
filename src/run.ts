import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { invocation, parseCost, type AgentSpec } from "./agents.js";
import { git } from "./git.js";
import type { Config } from "./project.js";
import { BASE_TAG, Sandbox } from "./sandbox.js";
import { dataDir, type Task } from "./tasks.js";
import { exec, pool, UserError } from "./util.js";

export interface TaskResult {
  id: string;
  solved: boolean;
  seconds: number;
  costUsd?: number;
  filesChanged: number;
  agentExit: number;
  timedOut: boolean;
  error?: string;
}

export interface RunFile {
  label: string;
  agent: string;
  model?: string;
  cmd?: string;
  instructions?: { path: string; sha1: string };
  head: string;
  startedAt: string;
  results: TaskResult[];
}

export interface RunOptions extends AgentSpec {
  label: string;
  parallel: number;
  agentTimeoutMs: number;
  testTimeoutMs: number;
  instructions?: string;
  keep?: boolean;
}

const runPath = (root: string, label: string) => dataDir(root, "runs", `${label}.json`);

export function loadRun(root: string, label: string): RunFile {
  const p = runPath(root, label);
  if (!existsSync(p)) {
    const known = listRuns(root);
    throw new UserError(`no run called "${label}"` + (known.length ? `. Runs: ${known.join(", ")}` : ""));
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

export function listRuns(root: string) {
  const dir = dataDir(root, "runs");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : [];
}

function changedFiles(box: Sandbox) {
  box.git(["add", "-A"]);
  return box.git(["diff", "--cached", "--name-only", BASE_TAG]).split("\n").filter(Boolean);
}

async function runTask(root: string, task: Task, cfg: Config, opts: RunOptions): Promise<TaskResult> {
  const box = new Sandbox(root, task, cfg);
  const logDir = dataDir(root, "runs", opts.label);
  mkdirSync(logDir, { recursive: true });
  const log: string[] = [];
  const base = { id: task.id, solved: false, seconds: 0, filesChanged: 0, agentExit: -1, timedOut: false };

  try {
    box.create((dir) => {
      if (!opts.instructions) return;
      // Most agents read one of these; overwrite whichever the repo has, or add AGENTS.md.
      const targets = ["AGENTS.md", "CLAUDE.md"].filter((f) => existsSync(join(dir, f)));
      for (const f of targets.length ? targets : ["AGENTS.md"]) copyFileSync(opts.instructions, join(dir, f));
    });

    const setup = await box.setup(opts.testTimeoutMs);
    if (setup && setup.code !== 0) {
      log.push(setup.out);
      return { ...base, error: "setup failed" };
    }

    const problemFile = join(logDir, `${task.id}.problem.md`);
    writeFileSync(problemFile, task.problem + "\n");
    const inv = invocation(opts, task.problem, problemFile);
    const agent = await exec(inv.command, { cwd: box.dir, timeoutMs: opts.agentTimeoutMs, env: inv.env });
    log.push(`--- agent (exit ${agent.code}${agent.timedOut ? ", timed out" : ""}) ---\n${agent.out}`);

    const touched = changedFiles(box);
    log.push(`--- files changed ---\n${touched.join("\n") || "(none)"}`);
    log.push(`--- diff ---\n${box.git(["diff", "--cached", BASE_TAG, "--", ...touched.filter((f) => !task.testFiles.includes(f))])}`);

    box.resetTestsAndApplyFix();
    const tests = await box.runTests(opts.testTimeoutMs);
    log.push(`--- tests (exit ${tests.code}) ---\n${tests.out}`);

    return {
      ...base,
      solved: tests.code === 0,
      seconds: Math.round(agent.ms / 1000),
      costUsd: parseCost(opts.agent, agent.out),
      filesChanged: touched.filter((f) => !task.testFiles.includes(f)).length,
      agentExit: agent.code,
      timedOut: agent.timedOut,
      error: agent.code === 127 ? `couldn't start ${opts.agent}, is it installed?` : undefined,
    };
  } catch (e: any) {
    log.push(String(e.stderr ?? e.stack ?? e));
    return { ...base, error: String(e.message).split("\n")[0] };
  } finally {
    writeFileSync(join(logDir, `${task.id}.log`), log.join("\n\n"));
    if (!opts.keep) box.dispose();
  }
}

export async function run(root: string, tasks: Task[], cfg: Config, opts: RunOptions, onDone: (r: TaskResult) => void) {
  if (opts.instructions && !existsSync(opts.instructions)) throw new UserError(`no such file: ${opts.instructions}`);

  const file: RunFile = {
    label: opts.label,
    agent: opts.agent,
    model: opts.model,
    cmd: opts.cmd,
    instructions: opts.instructions
      ? { path: opts.instructions, sha1: createHash("sha1").update(readFileSync(opts.instructions)).digest("hex").slice(0, 10) }
      : undefined,
    head: git(root, ["rev-parse", "--short", "HEAD"]).trim(),
    startedAt: new Date().toISOString(),
    results: [],
  };

  mkdirSync(dataDir(root, "runs"), { recursive: true });
  // Written after every task so a Ctrl-C still leaves you with partial results.
  const save = () => writeFileSync(runPath(root, opts.label), JSON.stringify(file, null, 2) + "\n");
  save();

  await pool(tasks, opts.parallel, async (t) => {
    const r = await runTask(root, t, cfg, opts);
    file.results.push(r);
    save();
    onDone(r);
  });
  return file;
}
