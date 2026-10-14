# Contributing

Thanks for looking. A few things that make PRs easy to merge:

- `npm test` passes. It builds and runs the unit tests and an end-to-end test that creates a real repo.
- No runtime dependencies. If you need one, open an issue first.
- Keep output calm: one line per task, color only for pass/fail.

## Layout

```
src/cli.ts       argument parsing and printing
src/mine.ts      which commits become tasks
src/project.ts   test file patterns and test command detection
src/sandbox.ts   snapshot the old code, apply patches, run tests
src/validate.ts  fail-before / pass-after check
src/agents.ts    how each agent CLI is called
src/run.ts       runs an agent over tasks, writes .unfix/runs/
src/compare.ts   summaries and the comparison table
```

## Good first issues

**1. Add a runner for another agent CLI**
Gemini CLI, Goose, Cline, Amp... Add a `case` in `src/agents.ts`, add it to `AGENTS`, add a test in `test/unit.test.ts`, and add a row to the README table. About 15 lines.

**2. Detect more test setups**
`src/project.ts` knows vitest, jest, mocha, node:test, pytest, go, cargo and rspec. Missing: `uv run pytest` when `uv.lock` exists, `poetry run pytest`, PHPUnit, Gradle/Maven, `dotnet test`, `bun test`. Each one is a few lines in `detect()` plus a unit test.

**3. `unfix report --markdown`**
Print the report or comparison as a Markdown table so it can be pasted into a PR comment. Lives in `src/compare.ts`.

## Bigger things

See the roadmap in the README. Open an issue before starting on one so we can agree on the shape.
