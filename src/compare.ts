import type { RunFile } from "./run.js";
import { c, duration, median } from "./util.js";

export interface Summary {
  total: number;
  solved: number;
  rate: number;
  medianSeconds?: number;
  medianCost?: number;
  totalCost?: number;
  errors: number;
}

export function summarize(r: RunFile, ids?: Set<string>): Summary {
  const rs = ids ? r.results.filter((x) => ids.has(x.id)) : r.results;
  const solved = rs.filter((x) => x.solved).length;
  const costs = rs.map((x) => x.costUsd).filter((x): x is number => x != null);
  return {
    total: rs.length,
    solved,
    rate: rs.length ? solved / rs.length : 0,
    medianSeconds: median(rs.map((x) => x.seconds)),
    medianCost: median(costs),
    totalCost: costs.length ? costs.reduce((a, b) => a + b, 0) : undefined,
    errors: rs.filter((x) => x.error).length,
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const usd = (x?: number) => (x == null ? "-" : `$${x.toFixed(2)}`);
const secs = (x?: number) => (x == null ? "-" : duration(x * 1000));

function describe(r: RunFile) {
  const name = r.agent === "cmd" ? (r.cmd ?? "cmd").split(/\s+/)[0].split("/").pop()! : r.agent;
  const extra = r.instructions ? `instructions@${r.instructions.sha1.slice(0, 7)}` : undefined;
  return [name, r.model, extra].filter(Boolean).join(" · ");
}

function table(rows: string[][]) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => stripAnsi(r[i] ?? "").length)));
  return rows
    .map((r) => "  " + r.map((cell, i) => cell + " ".repeat(widths[i] - stripAnsi(cell).length)).join("   ").trimEnd())
    .join("\n");
}
const stripAnsi = (s: string) => s.replace(/\x1b\[\d+m/g, "");

export function report(r: RunFile) {
  const s = summarize(r);
  const lines = [
    "",
    table([
      ["run", c.bold(r.label)],
      ["agent", describe(r)],
      ["solved", `${s.solved} / ${s.total}  ${pct(s.rate)}`],
      ["median time", secs(s.medianSeconds)],
      ["median cost", usd(s.medianCost)],
      ["total cost", usd(s.totalCost)],
    ]),
    "",
  ];
  for (const x of [...r.results].sort((a, b) => a.id.localeCompare(b.id))) {
    const mark = x.solved ? c.green("✓") : c.red("✗");
    lines.push(`  ${mark} ${x.id}${x.error ? c.dim(`  (${x.error})`) : ""}`);
  }
  return lines.join("\n") + "\n";
}

export function compare(a: RunFile, b: RunFile) {
  // Only count tasks both runs attempted, otherwise the numbers lie.
  const ids = new Set(a.results.map((x) => x.id).filter((id) => b.results.some((y) => y.id === id)));
  const sa = summarize(a, ids);
  const sb = summarize(b, ids);
  const solvedA = new Set(a.results.filter((x) => x.solved && ids.has(x.id)).map((x) => x.id));
  const solvedB = new Set(b.results.filter((x) => x.solved && ids.has(x.id)).map((x) => x.id));
  const gained = [...solvedB].filter((id) => !solvedA.has(id)).sort();
  const lost = [...solvedA].filter((id) => !solvedB.has(id)).sort();
  const deltaPP = Math.round((sb.rate - sa.rate) * 100);

  const delta = (x?: number, y?: number, lowerIsBetter = true) => {
    if (x == null || y == null || x === 0) return "";
    const d = Math.round(((y - x) / x) * 100);
    const good = lowerIsBetter ? d <= 0 : d >= 0;
    return (good ? c.green : c.yellow)(`${d > 0 ? "+" : ""}${d}%`);
  };

  const rows = [
    ["", c.bold(a.label), c.bold(b.label), "Δ"],
    ["agent", describe(a), describe(b), ""],
    ["solved", `${sa.solved} / ${sa.total}  ${pct(sa.rate)}`, `${sb.solved} / ${sb.total}  ${pct(sb.rate)}`,
      (deltaPP >= 0 ? c.green : c.red)(`${deltaPP > 0 ? "+" : ""}${deltaPP}pp`)],
    ["median time", secs(sa.medianSeconds), secs(sb.medianSeconds), delta(sa.medianSeconds, sb.medianSeconds)],
    ["median cost", usd(sa.medianCost), usd(sb.medianCost), delta(sa.medianCost, sb.medianCost)],
  ];

  let text = "\n" + table(rows) + "\n\n";
  if (gained.length) text += `  ${c.green("newly solved")}  ${gained.join("  ")}\n`;
  if (lost.length) text += `  ${c.red("newly failed")}  ${lost.join("  ")}\n`;
  if (!gained.length && !lost.length) text += c.dim("  same tasks solved by both\n");
  const skipped = a.results.length + b.results.length - 2 * ids.size;
  if (skipped) text += c.dim(`  (${skipped} task results ignored because only one run has them)\n`);

  return { text, deltaPP, gained, lost, a: sa, b: sb };
}
