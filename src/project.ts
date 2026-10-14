import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { shellQuote, UserError } from "./util.js";

export interface Config {
  // Runs once in every fresh sandbox, e.g. "npm ci".
  setup?: string;
  // {files} = changed test files, {dirs} = their directories as ./dir.
  test: string;
  // Extra time for setup + tests, per sandbox.
  testTimeoutSec?: number;
}

const TEST_PATH = [
  /(^|\/)(__tests__|tests?|specs?|testing)\//i,
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.py$/,
  /_test\.go$/,
  /(Test|Tests|Spec)\.(java|kt|cs|swift|scala)$/,
  /_spec\.rb$/,
  /\.(test|spec)\.(php|rb|ex|exs)$/,
];

const NOISE = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|go\.sum|uv\.lock)$/,
  /\.(md|mdx|rst|txt|adoc)$/i,
  /(^|\/)(CHANGELOG|CHANGES|HISTORY|AUTHORS|LICENSE)[^/]*$/i,
  /(^|\/)(docs?|\.github|\.vscode|\.idea)\//,
  /\.snap$/,
];

const CODE_EXT = /\.(c|cc|cpp|h|hpp|cs|go|java|kt|swift|scala|rs|py|rb|php|ex|exs|[cm]?[jt]sx?|vue|svelte)$/i;

export const isTestFile = (p: string) => TEST_PATH.some((r) => r.test(p));
export const isNoise = (p: string) => NOISE.some((r) => r.test(p));

// Test *code* we can hand to a runner, as opposed to fixtures living in tests/.
export const isTestCode = (p: string) =>
  CODE_EXT.test(p) && (/\.(test|spec)\.|(^|\/)test_|_test\.|_spec\.|(Test|Tests|Spec)\.\w+$/.test(p) || TEST_PATH[0].test(p));

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function detect(root: string): Config {
  const has = (f: string) => existsSync(join(root, f));
  const pkg = readJson(join(root, "package.json"));

  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const script: string = pkg.scripts?.test ?? "";
    const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm";
    const install = {
      pnpm: "pnpm install --frozen-lockfile",
      yarn: "yarn install --frozen-lockfile",
      bun: "bun install --frozen-lockfile",
      npm: has("package-lock.json") ? "npm ci" : "npm install",
    }[pm];
    const setup = Object.keys(deps).length ? install : undefined;
    const x = pm === "npm" ? "npx" : `${pm} exec`;

    if (deps.vitest || /\bvitest\b/.test(script)) return { setup, test: `${x} vitest run {files}` };
    if (deps.jest || /\bjest\b/.test(script)) return { setup, test: `${x} jest {files}` };
    if (deps.mocha || /\bmocha\b/.test(script)) return { setup, test: `${x} mocha {files}` };
    if (/node\s+--test/.test(script) || !script) return { setup, test: "node --test {files}" };
    return { setup, test: `${pm} test` };
  }

  if (has("go.mod")) return { test: "go test {dirs}" };
  if (has("Cargo.toml")) return { test: "cargo test" };
  if (has("pyproject.toml") || has("setup.py") || has("setup.cfg") || has("pytest.ini") || has("tox.ini"))
    return { test: "python -m pytest -q {files}" };
  if (has("Gemfile")) return { setup: "bundle install", test: "bundle exec rspec {files}" };

  throw new UserError(
    "couldn't figure out how to run your tests. Create .unfix/config.json with a \"test\" command, e.g.\n" +
      '  { "setup": "npm ci", "test": "npx vitest run {files}" }'
  );
}

export function loadConfig(root: string): Config {
  const path = join(root, ".unfix", "config.json");
  const user = existsSync(path) ? readJson(path) : undefined;
  if (existsSync(path) && !user) throw new UserError(`${path} is not valid JSON`);
  if (user?.test) return user;
  return { ...detect(root), ...user };
}

export function testCommand(cfg: Config, testFiles: string[]) {
  const files = testFiles.filter(isTestCode);
  const list = (files.length ? files : testFiles).map(shellQuote).join(" ");
  const dirs = [...new Set(testFiles.map((f) => "./" + dirname(f)))].map((d) => (d === "./." ? "." : d));
  return cfg.test.replaceAll("{files}", list).replaceAll("{dirs}", dirs.map(shellQuote).join(" "));
}
