#!/usr/bin/env bun
/**
 * ralph.ts — autonomous Tier 1 benchmark migration loop.
 *
 * For each PRD in docs/prds/, in order:
 *   1. Skip if its branch/PR already exists (idempotent — safe to re-run).
 *   2. Create the branch off origin/main.
 *   3. Hand the PRD to headless OpenCode (openai/gpt-5.5, xhigh reasoning) to implement.
 *   4. Gate the result: the C suite must build clean, the new binary must run --quick,
 *      and its stdout must parse as JSON, and there must be commits vs origin/main.
 *      One retry (via `opencode run --continue`) with the captured error if the gate fails.
 *   5. On pass: push and open a PR to main. On fail: leave the branch local and move on.
 *
 * Run on the Linux x86_64 benchmark box (the gate compiles and runs real binaries):
 *   bun ralph.ts            # do the work
 *   bun ralph.ts --dry-run  # print planned iterations + skips, invoke nothing
 *
 * Requires: git, gh (authenticated), opencode, make, cc (with AVX2), python3.
 */

import { spawnSync } from "node:child_process";

interface Prd {
  /** PRD filename in docs/prds/ */
  file: string;
  /** git branch, forks from main */
  branch: string;
  /** the built binary name under benchmarks/c/build/ that this PRD must produce */
  binary: string;
  /** PR title */
  title: string;
}

// Order matches docs/prds/README.md. Add a row here when a new PRD is written.
const PRDS: Prd[] = [
  { file: "01-memory-write.md",       branch: "bench/memory-write",       binary: "memory_write",       title: "bench: add memory_write (sequential + random)" },
  { file: "02-memory-read-random.md", branch: "bench/memory-read-random", binary: "memory_read_random", title: "bench: add memory_read_random" },
  { file: "03-syscall.md",            branch: "bench/syscall",            binary: "syscall",            title: "bench: add syscall (getpid, gettimeofday, getrusage, stat)" },
  { file: "04-hash.md",               branch: "bench/hash",               binary: "hash",               title: "bench: add hash (crc32, siphash, sha256)" },
  { file: "05-sort.md",               branch: "bench/sort",               binary: "sort",               title: "bench: add sort (u64)" },
  { file: "06-mutex.md",              branch: "bench/mutex",              binary: "mutex",              title: "bench: add mutex (contended)" },
  { file: "07-tcp-echo.md",           branch: "bench/tcp-echo",           binary: "tcp_echo",           title: "bench: add tcp_echo (32 KiB loopback)" },
];

const MODEL = "openai/gpt-5.5";
const VARIANT = "xhigh";
const AGENT_TIMEOUT_MS = 60 * 60 * 1000; // 60 min per PRD
const BASE = "main";
const REMOTE = "origin";

const DRY_RUN = process.argv.includes("--dry-run");

type RunOpts = { timeoutMs?: number; inherit?: boolean; allowFail?: boolean };

/** Run a command synchronously. Returns {code, stdout, stderr}. Throws on failure unless allowFail. */
function run(cmd: string, args: string[], opts: RunOpts = {}) {
  const r = spawnSync(cmd, args, {
    stdio: opts.inherit ? "inherit" : "pipe",
    encoding: "utf8",
    timeout: opts.timeoutMs,
  });
  const code = r.status ?? (r.signal ? 1 : 0);
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  if (code !== 0 && !opts.allowFail) {
    const detail = opts.inherit ? "" : `\n${stdout}\n${stderr}`;
    throw new Error(`\`${cmd} ${args.join(" ")}\` exited ${code}${detail}`);
  }
  return { code, stdout, stderr };
}

/** Capture stdout of a command, trimmed. */
function capture(cmd: string, args: string[]): string {
  return run(cmd, args, { allowFail: true }).stdout.trim();
}

function log(msg: string) {
  console.log(`\n\x1b[1m[ralph]\x1b[0m ${msg}`);
}

function remoteBranchExists(branch: string): boolean {
  return capture("git", ["ls-remote", "--heads", REMOTE, branch]).length > 0;
}

function prExists(branch: string): boolean {
  // gh prints a JSON array; empty array => no PR for this head.
  const out = capture("gh", ["pr", "list", "--head", branch, "--state", "all", "--json", "number"]);
  return out.length > 0 && out !== "[]";
}

function isDone(prd: Prd): { done: boolean; reason: string } {
  if (prExists(prd.branch)) return { done: true, reason: "PR already exists" };
  if (remoteBranchExists(prd.branch)) return { done: true, reason: "remote branch already exists" };
  return { done: false, reason: "" };
}

/** The prompt handed to OpenCode. */
function promptFor(prd: Prd, errorContext?: string): string {
  const base =
    `Read docs/dev-log.md in full, then implement docs/prds/${prd.file} exactly. ` +
    `Add only the single new benchmarks/c/bench_*.c file the PRD specifies and append your ` +
    `Running Log entry to docs/dev-log.md — do not modify harness.*, the Makefile, or any ` +
    `other benchmark. Build with 'make -C benchmarks/c', run the new binary with --quick, and ` +
    `make sure its stdout is valid JSON before finishing. Commit your work with a clear message.`;
  if (!errorContext) return base;
  return (
    base +
    `\n\nYour previous attempt did not pass the automated gate. Fix it. The failure was:\n\n` +
    errorContext
  );
}

/** Invoke headless OpenCode. `continueSession` resumes the prior session for a retry. */
function runOpencode(prompt: string, continueSession: boolean) {
  const args = ["run", "--model", MODEL, "--variant", VARIANT, "--auto"];
  if (continueSession) args.push("--continue");
  args.push(prompt);
  log(`opencode ${args.slice(0, continueSession ? 6 : 5).join(" ")} "<prompt>"`);
  // Inherit stdio so the agent's progress is visible in the ralph run log.
  run("opencode", args, { timeoutMs: AGENT_TIMEOUT_MS, inherit: true, allowFail: true });
}

/**
 * Gate: build clean, run the new binary --quick, parse its stdout as JSON, and confirm
 * commits exist vs origin/main. Returns null on pass, or an error string on failure.
 */
function gate(prd: Prd): string | null {
  // 1. Commits must exist relative to base.
  const ahead = capture("git", ["rev-list", "--count", `${REMOTE}/${BASE}..HEAD`]);
  if (ahead === "0" || ahead === "") return "no commits were made on the branch";

  // 2. Build the whole C suite; must succeed (warnings are allowed to pass the gate but
  //    the PRD's definition-of-done requires warning-clean; -Werror is intentionally not
  //    forced here so a stray warning doesn't discard otherwise-good work — reviewer catches it).
  const build = run("make", ["-C", "benchmarks/c", "clean"], { allowFail: true });
  if (build.code !== 0) { /* clean failing is fine if build dir absent */ }
  const make = run("make", ["-C", "benchmarks/c"], { allowFail: true });
  if (make.code !== 0) return `build failed:\n${make.stdout}\n${make.stderr}`;

  // 3. The PRD's binary must exist and run --quick.
  const binPath = `benchmarks/c/build/${prd.binary}`;
  const runBin = run(binPath, ["--quick"], { allowFail: true, timeoutMs: 5 * 60 * 1000 });
  if (runBin.code !== 0) return `${binPath} --quick exited ${runBin.code}:\n${runBin.stderr}`;

  // 4. stdout must be valid JSON (the contract).
  const parse = spawnSync("python3", ["-c", "import sys,json;json.load(sys.stdin)"], {
    input: runBin.stdout,
    encoding: "utf8",
  });
  if ((parse.status ?? 1) !== 0) {
    return `${binPath} --quick stdout is not valid JSON:\n${runBin.stdout.slice(0, 2000)}`;
  }
  return null;
}

function openPr(prd: Prd) {
  run("git", ["push", "-u", REMOTE, prd.branch], { inherit: true });
  const body =
    `Implements \`docs/prds/${prd.file}\` as part of the Tier 1 napkin-math migration ` +
    `(see docs/dev-log.md).\n\nAutomated gate passed: builds clean, \`${prd.binary} --quick\` ` +
    `runs and emits valid JSON.\n\n🤖 Generated by ralph.ts (openai/gpt-5.5, ${VARIANT}).`;
  const pr = run(
    "gh",
    ["pr", "create", "--base", BASE, "--head", prd.branch, "--title", prd.title, "--body", body],
    { allowFail: true },
  );
  if (pr.code !== 0) {
    log(`gh pr create failed:\n${pr.stdout}\n${pr.stderr}`);
    return false;
  }
  console.log(pr.stdout.trim());
  return true;
}

function preflight() {
  // Clean worktree required — we switch branches and inspect diffs.
  const dirty = capture("git", ["status", "--porcelain"]);
  if (dirty.length > 0) {
    throw new Error("working tree is not clean; commit or stash first:\n" + dirty);
  }
  run("git", ["fetch", REMOTE], { inherit: true });
  const auth = run("gh", ["auth", "status"], { allowFail: true });
  if (auth.code !== 0) throw new Error("gh is not authenticated; run `gh auth login`");
}

async function main() {
  log(DRY_RUN ? "DRY RUN — no branches, agents, or PRs will be created" : "starting migration loop");
  preflight();

  const summary = { opened: [] as string[], skipped: [] as string[], failed: [] as string[] };

  for (const prd of PRDS) {
    const { done, reason } = isDone(prd);
    if (done) {
      log(`SKIP ${prd.branch} — ${reason}`);
      summary.skipped.push(prd.branch);
      continue;
    }

    if (DRY_RUN) {
      log(`WOULD RUN ${prd.file} → branch ${prd.branch} → PR "${prd.title}"`);
      summary.opened.push(prd.branch + " (dry-run)");
      continue;
    }

    log(`=== ${prd.file} → ${prd.branch} ===`);
    run("git", ["checkout", "-B", prd.branch, `${REMOTE}/${BASE}`], { inherit: true });

    runOpencode(promptFor(prd), false);
    let err = gate(prd);
    if (err) {
      log(`gate failed, retrying once:\n${err}`);
      runOpencode(promptFor(prd, err), true);
      err = gate(prd);
    }

    if (err) {
      log(`FAILED ${prd.branch} after retry — leaving branch local, not opening PR:\n${err}`);
      summary.failed.push(prd.branch);
    } else if (openPr(prd)) {
      summary.opened.push(prd.branch);
    } else {
      summary.failed.push(prd.branch + " (PR create failed)");
    }

    // Return to a clean base before the next iteration.
    run("git", ["checkout", BASE], { inherit: true, allowFail: true });
  }

  log("done.");
  console.log(`  opened:  ${summary.opened.join(", ") || "(none)"}`);
  console.log(`  skipped: ${summary.skipped.join(", ") || "(none)"}`);
  console.log(`  failed:  ${summary.failed.join(", ") || "(none)"}`);
}

main().catch((e) => {
  console.error(`\n[ralph] fatal: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
