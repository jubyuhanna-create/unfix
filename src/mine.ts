import { listCommits, type Commit } from "./git.js";
import { isNoise, isTestFile } from "./project.js";
import { loadTasks, saveTask, type Task } from "./tasks.js";
import { slug } from "./util.js";

export interface MineOptions {
  since: string;
  max: number;
  maxFiles: number;
  maxLines: number;
  path?: string;
  rev?: string;
  anyMessage?: boolean;
}

const FIXY = /\b(fix(e[sd])?|bug|crash(es|ed)?|regress(ion)?|broken|wrong|incorrect|error|issue|handle|prevent|avoid)\b/i;
const SKIP = /^(revert|merge|bump|release|chore\(deps\)|build\(deps\)|v?\d+\.\d+\.\d+$)/i;
const TRAILER = /^(signed-off-by|co-authored-by|reviewed-by|change-id|cherry picked from|claude-session):.*$/gim;

export function cleanMessage(subject: string, body: string) {
  const text = `${subject}\n\n${body}`.replace(TRAILER, "").replace(/\s*\(#\d+\)/g, "");
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

export function score(c: Commit, sourceLines: number) {
  let s = 0;
  if (FIXY.test(c.subject)) s += 3;
  if (c.body.length > 40) s += 1; // a real description makes a better problem statement
  if (sourceLines <= 40) s += 1;
  return s;
}

export function candidates(commits: Commit[], opts: MineOptions) {
  const out: { commit: Commit; tests: string[]; sources: string[]; lines: number; score: number }[] = [];

  for (const c of commits) {
    if (SKIP.test(c.subject)) continue;
    if (!opts.anyMessage && !FIXY.test(c.subject)) continue;

    const relevant = c.files.filter((f) => !isNoise(f.path));
    const tests = relevant.filter((f) => isTestFile(f.path));
    const sources = relevant.filter((f) => !isTestFile(f.path));
    if (!tests.length || !sources.length) continue;
    if (sources.length > opts.maxFiles) continue;
    if (opts.path && !sources.some((f) => f.path.startsWith(opts.path!))) continue;

    const lines = sources.reduce((n, f) => n + f.added + f.removed, 0);
    if (lines === 0 || lines > opts.maxLines) continue;

    out.push({
      commit: c,
      tests: tests.map((f) => f.path),
      sources: sources.map((f) => f.path),
      lines,
      score: score(c, lines),
    });
  }
  return out.sort((a, b) => b.score - a.score || b.commit.date.localeCompare(a.commit.date));
}

export function mine(root: string, opts: MineOptions) {
  const existing = new Map(loadTasks(root).map((t) => [t.fix, t]));
  const found = candidates(listCommits(root, { since: opts.since, rev: opts.rev }), opts).slice(0, opts.max);

  const added: Task[] = [];
  for (const f of found) {
    if (existing.has(f.commit.sha)) continue;
    const task: Task = {
      id: `${slug(f.commit.subject)}-${f.commit.sha.slice(0, 7)}`,
      base: f.commit.parent,
      fix: f.commit.sha,
      date: f.commit.date,
      problem: cleanMessage(f.commit.subject, f.commit.body),
      testFiles: f.tests,
      sourceFiles: f.sources,
      linesChanged: f.lines,
      status: "new",
    };
    saveTask(root, task);
    added.push(task);
  }
  return { added, skipped: found.length - added.length };
}
