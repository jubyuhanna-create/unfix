import { execFileSync } from "node:child_process";
import { UserError } from "./util.js";

export function git(cwd: string, args: string[], input?: string | Buffer, env?: Record<string, string>): string {
  return execFileSync("git", args, {
    cwd,
    input,
    env: env ? { ...process.env, ...env } : undefined,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

export function gitBuf(cwd: string, args: string[]): Buffer {
  return execFileSync("git", args, { cwd, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

export function repoRoot(cwd: string) {
  try {
    return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    throw new UserError("not inside a git repository");
  }
}

export interface Commit {
  sha: string;
  parent: string;
  date: string;
  subject: string;
  body: string;
  files: { path: string; added: number; removed: number }[];
}

const REC = "\x1e";
const FLD = "\x1f";
const END = "\x1d";

// "2y", "6m", "3w", "30d" -> something git understands. Anything else is passed through.
export function gitSince(s: string) {
  const m = /^(\d+)\s*([dwmy])$/i.exec(s.trim());
  if (!m) return s;
  const unit = { d: "days", w: "weeks", m: "months", y: "years" }[m[2].toLowerCase()]!;
  return `${m[1]} ${unit} ago`;
}

export function listCommits(cwd: string, opts: { since?: string; rev?: string }): Commit[] {
  const args = [
    "log",
    "--no-merges",
    "--no-renames",
    "--numstat",
    `--format=${REC}%H${FLD}%P${FLD}%aI${FLD}%s${FLD}%b${END}`,
  ];
  if (opts.since) args.push(`--since=${gitSince(opts.since)}`);
  args.push(opts.rev ?? "HEAD");

  let raw: string;
  try {
    raw = git(cwd, args);
  } catch (e: any) {
    if (/does not have any commits/.test(String(e.stderr))) return [];
    throw e;
  }

  const commits: Commit[] = [];
  for (const rec of raw.split(REC)) {
    if (!rec.trim()) continue;
    const endAt = rec.indexOf(END);
    const [sha, parents, date, subject, body] = rec.slice(0, endAt).split(FLD);
    const parent = parents.split(" ")[0];
    if (!parent) continue; // root commit, nothing to diff against

    const files = rec
      .slice(endAt + 1)
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [a, r, ...p] = line.split("\t");
        return { path: p.join("\t"), added: a === "-" ? 0 : +a, removed: r === "-" ? 0 : +r };
      });
    commits.push({ sha, parent, date, subject: subject.trim(), body: (body ?? "").trim(), files });
  }
  return commits;
}
