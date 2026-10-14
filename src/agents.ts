import { shellQuote as q, UserError } from "./util.js";

export interface AgentSpec {
  agent: string;
  model?: string;
  cmd?: string;
}

export interface AgentInvocation {
  command: string;
  // The prompt is fed on stdin or through a file, never as an argument:
  // cmd.exe can't carry a multi-line argument, and sh would need escaping anyway.
  input?: string;
  env: Record<string, string>;
}

export const AGENTS = ["claude-code", "codex", "aider", "opencode", "cmd"] as const;

export function prompt(problem: string) {
  return `Resolve the following issue in the repository in the current directory.

<issue>
${problem}
</issue>

Change the code so the issue is fixed. Don't edit or add tests; they get replaced before grading. Don't ask questions, there is no one to answer them.`;
}

export function invocation(spec: AgentSpec, problem: string, problemFile: string, promptFile: string): AgentInvocation {
  const m = spec.model;
  const env = { UNFIX_PROBLEM_FILE: problemFile, UNFIX_PROMPT_FILE: promptFile, UNFIX_MODEL: m ?? "" };
  const model = (flag: string) => (m ? ` ${flag} ${q(m)}` : "");
  const p = prompt(problem);

  switch (spec.agent) {
    case "claude-code":
      return { command: `claude -p --output-format json --dangerously-skip-permissions${model("--model")}`, input: p, env };
    case "codex":
      return { command: `codex exec --full-auto${model("--model")} -`, input: p, env };
    case "aider":
      return {
        command: `aider --yes-always --no-check-update --no-show-model-warnings${model("--model")} --message-file ${q(promptFile)}`,
        env,
      };
    case "opencode":
      // No stdin or file option, so it gets a one-line pointer to the prompt file.
      return { command: `opencode run${model("--model")} ${q(`Read ${promptFile} and do what it says.`)}`, env };
    case "cmd":
      if (!spec.cmd) throw new UserError('--agent cmd needs --cmd, e.g. --cmd "node my-agent.js {problem_file}"');
      return {
        command: spec.cmd
          .replaceAll("{problem_file}", q(problemFile))
          .replaceAll("{prompt_file}", q(promptFile))
          .replaceAll("{model}", q(m ?? "")),
        env,
      };
    default:
      throw new UserError(`unknown agent "${spec.agent}". Try one of: ${AGENTS.join(", ")}`);
  }
}

function claudeResult(out: string): any {
  const line = out.trim().split("\n").reverse().find((l) => l.startsWith("{") && l.includes('"type":"result"'));
  try {
    return line ? JSON.parse(line) : undefined;
  } catch {
    return undefined;
  }
}

// Claude Code's JSON output reports what the run cost. Others don't, so we just leave it empty.
export function parseCost(agent: string, out: string): number | undefined {
  if (agent !== "claude-code") return undefined;
  const cost = claudeResult(out)?.total_cost_usd ?? out.match(/"total_cost_usd"\s*:\s*([\d.]+)/)?.[1];
  return cost == null ? undefined : Number(cost);
}

// Tells "the agent tried and got it wrong" apart from "the agent never ran".
// Only the second is an error; it shouldn't be counted as a failed attempt.
export function agentError(agent: string, code: number, out: string, changedSomething: boolean): string | undefined {
  if (code === 127) return `couldn't start ${agent}. Is it installed and on your PATH?`;
  if (agent === "claude-code") {
    const r = claudeResult(out);
    if (r?.is_error) return `claude-code: ${String(r.result ?? r.terminal_reason ?? "error").replace(/\s+/g, " ").slice(0, 200)}`;
  }
  if (code !== 0 && !changedSomething) {
    const last = out.trim().split("\n").filter(Boolean).pop() ?? "";
    return `${agent} exited with code ${code} without changing anything${last ? `: ${last.slice(0, 160)}` : ""}`;
  }
  return undefined;
}
