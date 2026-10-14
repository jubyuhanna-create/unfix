import { shellQuote, UserError } from "./util.js";

export interface AgentSpec {
  agent: string;
  model?: string;
  cmd?: string;
}

export interface AgentInvocation {
  command: string | string[];
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

export function invocation(spec: AgentSpec, problem: string, problemFile: string): AgentInvocation {
  const p = prompt(problem);
  const m = spec.model;
  const env = { UNFIX_PROBLEM_FILE: problemFile, UNFIX_MODEL: m ?? "" };

  switch (spec.agent) {
    case "claude-code":
      return {
        command: ["claude", "-p", p, "--output-format", "json", "--dangerously-skip-permissions", ...(m ? ["--model", m] : [])],
        env,
      };
    case "codex":
      return { command: ["codex", "exec", "--full-auto", ...(m ? ["--model", m] : []), p], env };
    case "aider":
      return {
        command: ["aider", "--yes-always", "--no-check-update", "--no-show-model-warnings", ...(m ? ["--model", m] : []), "--message", p],
        env,
      };
    case "opencode":
      return { command: ["opencode", "run", ...(m ? ["--model", m] : []), p], env };
    case "cmd":
      if (!spec.cmd) throw new UserError('--agent cmd needs --cmd, e.g. --cmd "./my-agent.sh {problem_file}"');
      return {
        command: spec.cmd.replaceAll("{problem_file}", shellQuote(problemFile)).replaceAll("{model}", shellQuote(m ?? "")),
        env,
      };
    default:
      throw new UserError(`unknown agent "${spec.agent}". Try one of: ${AGENTS.join(", ")}`);
  }
}

// Claude Code's JSON output reports what the run cost. Others don't, so we just leave it empty.
export function parseCost(agent: string, out: string): number | undefined {
  if (agent !== "claude-code") return undefined;
  const m = out.match(/"total_cost_usd"\s*:\s*([\d.]+)/);
  return m ? Number(m[1]) : undefined;
}
