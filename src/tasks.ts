import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type Status = "new" | "valid" | "invalid";

export interface Task {
  id: string;
  base: string;
  fix: string;
  date: string;
  problem: string;
  testFiles: string[];
  sourceFiles: string[];
  linesChanged: number;
  status: Status;
  reason?: string;
}

export const dataDir = (root: string, ...p: string[]) => join(root, ".unfix", ...p);

export function loadTasks(root: string): Task[] {
  const dir = dataDir(root, "tasks");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Task)
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function saveTask(root: string, t: Task) {
  const dir = dataDir(root, "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${t.id}.json`), JSON.stringify(t, null, 2) + "\n");
}

export function pickTasks(all: Task[], opts: { only?: string[]; includeUnvalidated?: boolean; limit?: number }) {
  let tasks = all;
  if (opts.only?.length) tasks = tasks.filter((t) => opts.only!.some((o) => t.id === o || t.id.startsWith(o)));
  else tasks = tasks.filter((t) => t.status === "valid" || (opts.includeUnvalidated && t.status === "new"));
  return opts.limit ? tasks.slice(0, opts.limit) : tasks;
}
