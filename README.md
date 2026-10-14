<div align="center">

# unfix

**Un-fix the bugs you already fixed. Then watch which AI agent fixes them again.**

A private benchmark for coding agents, mined from your own git history. One command, no account, nothing uploaded.

[![npm](https://img.shields.io/npm/v/unfix-ai?color=cb3837&logo=npm)](https://www.npmjs.com/package/unfix-ai)
[![CI](https://img.shields.io/github/actions/workflow/status/jubyuhanna-create/unfix/ci.yml?logo=github&label=tests)](https://github.com/jubyuhanna-create/unfix/actions)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

```
$ unfix compare sonnet opus

                sonnet               opus                 Δ
  agent         claude-code · sonnet claude-code · opus
  solved        14 / 25  56%         18 / 25  72%         +16pp
  median time   1m 52s               2m 40s               +43%
  median cost   $0.19                $0.61                +221%

  newly solved  fix-retry-overflow-3f2a91c  fix-tz-parse-81c0e2d  ...
  newly failed  fix-empty-cart-total-0b7d11a
```
<sub>Example output. Your numbers will be your own, which is the point.</sub>

---

## Why

Every week brings a new model, a new agent, and a new opinion about what belongs in `AGENTS.md`. Public leaderboards measure agents on Django and sympy. They say nothing about **your** codebase, with its odd build, internal libraries and house rules.

So teams pick models on vibes and rewrite agent instructions on vibes.

`unfix` turns that into a number.

## How it works

Your history is full of finished exams: commits where someone fixed a bug and added a test that proves it.

For each one, `unfix`:

1. **Mines** the commit: it touched code *and* tests, the message says it's a fix, and the diff is small.
2. **Validates** it: the new tests must **fail** on the code before the fix and **pass** after it. Otherwise it isn't a fair question, and it's dropped.
3. **Runs** your agent on a clean snapshot of the code *before* the fix, giving it only the problem description.
4. **Grades** with your real tests. No LLM judge, no vibes.

```
git history ─► mine ─► validate ─► .unfix/tasks/*.json
                       (fail before,      │
                        pass after)       ▼
                              fresh snapshot of the old code
                              (new git history: the fix doesn't exist)
                                          │
                                  agent works on it
                                          │
                         test files restored, fix's tests applied
                                          │
                                   your tests decide
```

**It can't be gamed by the agent.** The sandbox is a fresh repo with a single commit, so `git log` has nothing to find. Any change the agent makes to test files is thrown away before grading. Both of these are covered by the test suite.

## Quick start

Works on Windows, macOS and Linux. Requires Node 20+ and git.

```bash
npm i -g unfix-ai       # or without installing: npx unfix-ai <command>

cd your-repo
unfix mine              # find candidate bug fixes from the last year
unfix validate          # keep only the ones that are fair tests
unfix run --agent claude-code --label baseline
```

Then change one thing and run again:

```bash
unfix run --agent claude-code --model opus --label opus
unfix compare baseline opus
```

## Things you can measure

| Question | Command |
|---|---|
| Is the expensive model worth it here? | `run --model sonnet` vs `run --model opus` |
| Did my `AGENTS.md` rewrite help or hurt? | `run --instructions AGENTS.new.md` |
| Claude Code vs Codex vs Aider on my repo? | `run --agent codex`, `run --agent aider` |
| Is my homemade agent any good? | `run --agent cmd --cmd "./agent.sh {problem_file}"` |

## Commands

```
unfix mine      [--since 1y] [--max 50] [--path src/] [--any-message]
                [--max-files 4] [--max-lines 200]
unfix validate  [--parallel 2] [--all] [--timeout 10m]
unfix tasks
unfix run       --agent <claude-code|codex|aider|opencode|cmd>
                [--model m] [--label name] [--instructions file]
                [--parallel 2] [--limit n] [--only id,...] [--timeout 20m]
unfix report    <label>
unfix compare   <a> <b> [--fail-if-drop 5] [--json]
```

### Agents

| `--agent` | What runs |
|---|---|
| `claude-code` | `claude -p … --output-format json` (cost is reported) |
| `codex` | `codex exec --full-auto …` |
| `aider` | `aider --yes-always --message …` |
| `opencode` | `opencode run …` |
| `cmd` | anything. `{problem_file}`, `{prompt_file}` and `{model}` are filled in, and `$UNFIX_PROBLEM_FILE` / `$UNFIX_PROMPT_FILE` are set |

Agents run with full permissions inside a throwaway copy of your code, so run `unfix` on a machine or container you're fine with an agent working on.

### Test detection

`unfix` reads your project and picks a test command:

| Project | Command |
|---|---|
| vitest / jest / mocha | `npx vitest run {files}` etc. |
| `node --test` | `node --test {files}` |
| Python | `python -m pytest -q {files}` |
| Go | `go test {dirs}` |
| Rust | `cargo test` |
| Ruby | `bundle exec rspec {files}` |

For JS projects the install step (`npm ci`, `pnpm install --frozen-lockfile`…) is picked from your lockfile. Anything else, set it yourself in `.unfix/config.json`:

```json
{
  "setup": "pip install -e '.[dev]'",
  "test": "python -m pytest -q {files}"
}
```

### Task files

Tasks are plain JSON in `.unfix/tasks/`. Read them, edit the `problem` text, delete the ones you don't like. Committing them gives your whole team the same benchmark. Run output (`.unfix/runs/`, `.unfix/logs/`) is ignored by default.

```json
{
  "id": "fix-clamp-returns-wrong-value-when-bound-7d43fc8",
  "base": "a08cbe3…",
  "fix": "7d43fc8…",
  "problem": "fix: clamp returns wrong value when bounds are reversed\n\nclamp(5, 3, 0) returned 0 instead of 3.",
  "testFiles": ["test/clamp.test.js"],
  "sourceFiles": ["src/clamp.js"],
  "status": "valid"
}
```

Every run keeps a full log per task in `.unfix/runs/<label>/`: what the agent printed, which files it changed, its diff, and the test output.

## In CI

Catch the PR that makes your agents worse:

```yaml
# .github/workflows/agents.yml
on:
  pull_request:
    paths: ["AGENTS.md", "CLAUDE.md", ".claude/**"]

jobs:
  unfix:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm i -g unfix-ai @anthropic-ai/claude-code
      - run: git fetch origin main && git show origin/main:AGENTS.md > /tmp/AGENTS.main.md
      - run: unfix run --agent claude-code --limit 10 --instructions /tmp/AGENTS.main.md --label main
      - run: unfix run --agent claude-code --limit 10 --instructions AGENTS.md --label pr
      - run: unfix compare main pr --fail-if-drop 10
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

`compare --fail-if-drop N` exits with code 1 when the solve rate drops by more than N points.

## FAQ

**Won't the model already know my repo?** For a popular public repo, it might. On a private repo it can't, and that's where `unfix` is most useful.

**The commit message gives away the answer.** Sometimes it does ("fix: use Math.min in clamp"). Edit the `problem` field in the task file to read like a bug report. A future version will pull the text from the linked issue.

**How much does a run cost?** About what the agent costs on N small bug fixes. Start with `--limit 5`.

**My history has no tests.** Then there's nothing fair to grade against yet. `unfix` would rather give you no benchmark than a wrong one.

## Roadmap

- [ ] Problem text from linked GitHub issues and PRs (`--github`)
- [ ] Docker sandbox with network off
- [ ] `pass@k`: run each task k times, because agents are noisy
- [ ] HTML report you can share
- [ ] "Revert mode" for repos with few bug fixes: rebuild small features from their description

## Contributing

`unfix` has zero runtime dependencies and is small enough to read in an evening. Start with [CONTRIBUTING.md](CONTRIBUTING.md); issues labelled `good first issue` are a good way in.

```bash
git clone https://github.com/jubyuhanna-create/unfix && cd unfix
npm install
npm test
```

## License

MIT
