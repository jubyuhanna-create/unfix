#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { AGENTS } from "./agents.js";
import { compare, report } from "./compare.js";
import { repoRoot } from "./git.js";
import { mine } from "./mine.js";
import { loadConfig } from "./project.js";
import { listRuns, loadRun, run } from "./run.js";
import { dataDir, loadTasks, pickTasks } from "./tasks.js";
import { c, duration, UserError } from "./util.js";
import { validate } from "./validate.js";

const VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

const HELP = `${c.bold("unfix")} — un-fix bugs you already fixed, then see which agent fixes them again.

${c.bold("Usage")}
  unfix mine      [--since 1y] [--max 50] [--path src/] [--any-message]
  unfix validate  [--parallel 2] [--all]
  unfix tasks
  unfix run       --agent <name> [--model m] [--label name] [--instructions file]
                  [--parallel 2] [--limit n] [--only id,...] [--timeout 20m]
  unfix report    <label>
  unfix compare   <baseline> <candidate> [--fail-if-drop 5] [--json]

${c.bold("Agents")}
  ${AGENTS.join(", ")}
  --agent cmd --cmd "./my-agent.sh {problem_file}"   runs anything you want

${c.bold("Typical loop")}
  unfix mine && unfix validate
  unfix run --agent claude-code --label before
  # change your model, AGENTS.md, MCP setup...
  unfix run --agent claude-code --label after
  unfix compare before after

Docs: https://github.com/El7ajb/unfix
`;

function parseTime(s: string | undefined, fallbackMs: number) {
  if (!s) return fallbackMs;
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/.exec(s.trim());
  if (!m) throw new UserError(`can't read "${s}" as a duration, try 90s, 20m or 1h`);
  return Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5 }[(m[2] ?? "m") as "s" | "m" | "h"];
}

function int(s: string | undefined, fallback: number, name: string) {
  if (s == null) return fallback;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) throw new UserError(`--${name} must be a positive whole number`);
  return n;
}

function ensureGitignore(root: string) {
  const path = dataDir(root, ".gitignore");
  if (existsSync(path)) return;
  mkdirSync(dataDir(root), { recursive: true });
  // Tasks are worth committing so the team shares a benchmark. Run output usually isn't.
  writeFileSync(path, "runs/\nlogs/\n");
}

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") return void process.stdout.write(HELP);
  if (cmd === "-v" || cmd === "--version") return void console.log(VERSION);

  const root = repoRoot(process.cwd());

  switch (cmd) {
    case "mine": {
      const { values } = parseArgs({
        args: rest,
        options: {
          since: { type: "string", default: "1y" },
          max: { type: "string" },
          path: { type: "string" },
          rev: { type: "string" },
          "max-files": { type: "string" },
          "max-lines": { type: "string" },
          "any-message": { type: "boolean" },
        },
      });
      ensureGitignore(root);
      const { added, skipped } = mine(root, {
        since: values.since!,
        max: int(values.max, 50, "max"),
        maxFiles: int(values["max-files"], 4, "max-files"),
        maxLines: int(values["max-lines"], 200, "max-lines"),
        path: values.path,
        rev: values.rev,
        anyMessage: values["any-message"],
      });
      for (const t of added) console.log(`  ${c.cyan("+")} ${t.id}  ${c.dim(`${t.sourceFiles.length} file(s), ${t.linesChanged} lines`)}`);
      if (!added.length && !skipped) {
        console.log("No candidate commits found. A candidate is a commit that changes both tests and code.");
        console.log(c.dim("Try a longer --since, or --any-message to include commits that don't say \"fix\"."));
        return;
      }
      console.log(`\n${added.length} new task(s)${skipped ? `, ${skipped} already known` : ""}. Next: ${c.bold("unfix validate")}`);
      return;
    }

    case "validate": {
      const { values } = parseArgs({
        args: rest,
        options: { parallel: { type: "string" }, all: { type: "boolean" }, timeout: { type: "string" }, keep: { type: "boolean" } },
      });
      const cfg = loadConfig(root);
      const tasks = loadTasks(root).filter((t) => values.all || t.status === "new");
      if (!tasks.length) return void console.log("Nothing to validate. Run `unfix mine` first, or pass --all to recheck.");
      console.log(c.dim(`setup: ${cfg.setup ?? "(none)"}\ntests: ${cfg.test}\n`));
      const done = await validate(root, tasks, cfg, {
        parallel: int(values.parallel, 2, "parallel"),
        timeoutMs: parseTime(values.timeout, 10 * 6e4),
        keep: values.keep,
      }, (t) => console.log(`  ${t.status === "valid" ? c.green("✓") : c.red("✗")} ${t.id}${t.reason ? c.dim(`  ${t.reason}`) : ""}`));
      const ok = done.filter((t) => t.status === "valid").length;
      console.log(`\n${ok} of ${done.length} usable. Logs in .unfix/logs/`);
      if (ok) console.log(`Next: ${c.bold("unfix run --agent claude-code --label baseline")}`);
      return;
    }

    case "tasks": {
      const tasks = loadTasks(root);
      if (!tasks.length) return void console.log("No tasks yet. Run `unfix mine`.");
      const mark = { valid: c.green("✓"), invalid: c.red("✗"), new: c.yellow("?") };
      for (const t of tasks) console.log(`  ${mark[t.status]} ${t.id}${t.reason ? c.dim(`  ${t.reason}`) : ""}`);
      const n = (s: string) => tasks.filter((t) => t.status === s).length;
      console.log(c.dim(`\n${n("valid")} valid, ${n("invalid")} invalid, ${n("new")} not validated yet`));
      return;
    }

    case "run": {
      const { values } = parseArgs({
        args: rest,
        options: {
          agent: { type: "string" },
          model: { type: "string" },
          cmd: { type: "string" },
          label: { type: "string" },
          instructions: { type: "string" },
          parallel: { type: "string" },
          limit: { type: "string" },
          only: { type: "string" },
          timeout: { type: "string" },
          "test-timeout": { type: "string" },
          "include-unvalidated": { type: "boolean" },
          keep: { type: "boolean" },
        },
      });
      if (!values.agent) throw new UserError(`--agent is required (${AGENTS.join(", ")})`);
      const cfg = loadConfig(root);
      const tasks = pickTasks(loadTasks(root), {
        only: values.only?.split(",").map((s) => s.trim()),
        includeUnvalidated: values["include-unvalidated"],
        limit: values.limit ? int(values.limit, 0, "limit") : undefined,
      });
      if (!tasks.length) throw new UserError("no valid tasks to run. Run `unfix mine` and `unfix validate` first.");

      const label = values.label ?? [values.agent, values.model].filter(Boolean).join("-").replace(/[^\w.-]+/g, "_");
      ensureGitignore(root);
      console.log(c.dim(`${tasks.length} task(s) → ${label}\n`));
      const started = Date.now();
      const file = await run(root, tasks, cfg, {
        agent: values.agent,
        model: values.model,
        cmd: values.cmd,
        label,
        instructions: values.instructions,
        parallel: int(values.parallel, 2, "parallel"),
        agentTimeoutMs: parseTime(values.timeout, 20 * 6e4),
        testTimeoutMs: parseTime(values["test-timeout"], 10 * 6e4),
        keep: values.keep,
      }, (r) => console.log(`  ${r.solved ? c.green("✓") : c.red("✗")} ${r.id}  ${c.dim(duration(r.seconds * 1000) + (r.error ? `  ${r.error}` : ""))}`));
      process.stdout.write(report(file));
      console.log(c.dim(`\ndone in ${duration(Date.now() - started)}. Logs in .unfix/runs/${label}/`));
      return;
    }

    case "report": {
      const label = rest[0];
      if (!label) {
        const runs = listRuns(root);
        throw new UserError(runs.length ? `which run? ${runs.join(", ")}` : "no runs yet");
      }
      return void process.stdout.write(report(loadRun(root, label)));
    }

    case "compare": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { "fail-if-drop": { type: "string" }, json: { type: "boolean" } },
      });
      if (positionals.length !== 2) throw new UserError("usage: unfix compare <baseline> <candidate>");
      const result = compare(loadRun(root, positionals[0]), loadRun(root, positionals[1]));
      if (values.json) {
        const { text: _, ...data } = result;
        console.log(JSON.stringify(data, null, 2));
      } else process.stdout.write(result.text);

      const limit = values["fail-if-drop"];
      if (limit != null && -result.deltaPP > Number(limit)) {
        console.error(c.red(`\nsolve rate dropped ${-result.deltaPP}pp (limit ${limit}pp)`));
        process.exitCode = 1;
      }
      return;
    }

    default:
      throw new UserError(`unknown command "${cmd}". Run \`unfix --help\`.`);
  }
}

main(process.argv.slice(2)).catch((e) => {
  if (e instanceof UserError || e?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    console.error(`${c.red("error")} ${e.message}`);
    process.exit(2);
  }
  console.error(e);
  process.exit(1);
});
