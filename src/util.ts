import { spawn, spawnSync } from "node:child_process";

export const isWindows = process.platform === "win32";

export interface ExecResult {
  code: number;
  out: string;
  ms: number;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  input?: string;
  maxOutput?: number;
}

// Runs a command line through the platform shell (sh, or cmd.exe on Windows).
// stdout and stderr are merged because that's what you want in a log, and only
// the tail is kept if it's huge.
export function exec(cmd: string, opts: ExecOptions): Promise<ExecResult> {
  const started = Date.now();
  const max = opts.maxOutput ?? 512 * 1024;
  // Inherited from an outer `node --test`, this makes the inner one report upward and exit 0.
  const { NODE_TEST_CONTEXT: _, ...parentEnv } = process.env;

  return new Promise((resolve) => {
    const child = spawn(cmd, {
      cwd: opts.cwd,
      shell: true,
      // Own process group on Unix so a timeout can kill the whole tree.
      // On Windows that would pop up a console window instead.
      detached: !isWindows,
      windowsHide: true,
      env: { ...parentEnv, ...opts.env },
      stdio: [opts.input == null ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (opts.input != null) {
      child.stdin!.on("error", () => {}); // the program may exit without reading it
      child.stdin!.end(opts.input);
    }

    let out = "";
    let timedOut = false;
    const onData = (b: Buffer) => {
      out += b.toString();
      if (out.length > max * 2) out = out.slice(-max);
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child.pid);
        }, opts.timeoutMs)
      : undefined;

    const done = (code: number) => {
      if (timer) clearTimeout(timer);
      resolve({ code, out: out.slice(-max), ms: Date.now() - started, timedOut });
    };
    child.on("error", (err) => {
      out += String(err.message) + "\n";
      done(127);
    });
    // cmd.exe says "not recognized" with 9009 where sh uses 127.
    child.on("close", (code) => done(code === 9009 ? 127 : code ?? 1));
  });
}

function killTree(pid?: number) {
  if (!pid) return;
  if (isWindows) {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

export async function pool<T>(items: T[], size: number, fn: (item: T, i: number) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, worker));
}

export function shellQuote(s: string, windows = isWindows) {
  if (/^[\w./@:+=,-]+$/.test(s)) return s;
  if (!windows) return `'${s.replace(/'/g, `'\\''`)}'`;
  // cmd.exe passes this through untouched; the program's argv parser then
  // undoes the backslash/quote escaping (the MSVC rules everyone follows).
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

export function slug(s: string, max = 40) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/, "") || "task"
  );
}

export function median(xs: number[]) {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function duration(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  dim: paint(2),
  bold: paint(1),
  red: paint(31),
  green: paint(32),
  yellow: paint(33),
  cyan: paint(36),
};

export class UserError extends Error {}
