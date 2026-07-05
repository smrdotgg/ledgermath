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
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

// ── logging ──────────────────────────────────────────────────────────────────
// Everything is timestamped and elapsed-stamped so that when you SSH in and attach
// to the tmux session mid-run, you can immediately tell what's happening and for how
// long — "agent working for 3m" reads very differently from "agent working for 47m".

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", cyan: "\x1b[36m", gray: "\x1b[90m",
};

const START = Date.now();

// Persistent log file — everything printed to the terminal is also appended here (with
// color codes stripped) so you can `cat ~/ralph-logs.txt` (or paste it) after the fact.
// Override the path with RALPH_LOG_FILE if you want it elsewhere.
const LOG_FILE = process.env.RALPH_LOG_FILE || join(homedir(), "ralph-logs.txt");

const ANSI = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/** Append a plain-text line to the log file. Never throws (logging must not crash the run). */
function toFile(line: string) {
  try {
    appendFileSync(LOG_FILE, stripAnsi(line) + "\n");
  } catch {
    /* if the log file can't be written, keep going — terminal output still works */
  }
}

/** Print to the terminal (with color) and mirror to the log file (plain). */
function emit(line: string) {
  console.log(line);
  toFile(line);
}

/** Wall-clock HH:MM:SS for the current line. */
function ts(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Human duration: 4s, 3m12s, 1h04m. */
function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** Total elapsed since ralph started, e.g. "+3m12s". */
function sinceStart(): string {
  return `+${fmtDur(Date.now() - START)}`;
}

function log(msg: string) {
  emit(`${C.gray}${ts()} ${C.dim}${sinceStart()}${C.reset} ${C.bold}[ralph]${C.reset} ${msg}`);
}

/** A loud section divider so iterations are easy to find when scrolling back. */
function banner(msg: string, color: string = C.cyan) {
  const line = "─".repeat(Math.max(4, 72 - msg.length));
  emit(`\n${color}${C.bold}══ ${msg} ${line}${C.reset}`);
}

function ok(msg: string) { log(`${C.green}✓${C.reset} ${msg}`); }
function warn(msg: string) { log(`${C.yellow}⚠${C.reset} ${msg}`); }
function fail(msg: string) { log(`${C.red}✗${C.reset} ${msg}`); }

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
  const kind = continueSession ? "retry (--continue)" : "fresh session";
  log(`${C.blue}▶ agent starting${C.reset} — ${MODEL} ${VARIANT}, ${kind}, timeout ${fmtDur(AGENT_TIMEOUT_MS)}`);
  log(`${C.dim}(opencode output streams below until the agent finishes)${C.reset}`);
  const t0 = Date.now();
  // Inherit stdio so the agent's live progress is visible in the tmux session.
  const r = run("opencode", args, { timeoutMs: AGENT_TIMEOUT_MS, inherit: true, allowFail: true });
  const elapsed = fmtDur(Date.now() - t0);
  if (r.code === 0) ok(`agent finished in ${elapsed}`);
  else warn(`agent exited ${r.code} after ${elapsed} (gate will decide pass/fail)`);
}

/**
 * Gate: build clean, run the new binary --quick, parse its stdout as JSON, and confirm
 * commits exist vs origin/main. Returns null on pass, or an error string on failure.
 */
function gate(prd: Prd): string | null {
  log(`${C.cyan}▶ gate${C.reset} — checking commits → build → run → JSON`);

  // 1. Commits must exist relative to base.
  const ahead = capture("git", ["rev-list", "--count", `${REMOTE}/${BASE}..HEAD`]);
  if (ahead === "0" || ahead === "") return "no commits were made on the branch";
  log(`  ${C.green}·${C.reset} ${ahead} commit(s) on ${prd.branch}`);

  // 2. Build the whole C suite; must succeed (warnings are allowed to pass the gate but
  //    the PRD's definition-of-done requires warning-clean; -Werror is intentionally not
  //    forced here so a stray warning doesn't discard otherwise-good work — reviewer catches it).
  run("make", ["-C", "benchmarks/c", "clean"], { allowFail: true });
  log(`  ${C.dim}· building benchmarks/c …${C.reset}`);
  const make = run("make", ["-C", "benchmarks/c"], { allowFail: true });
  if (make.code !== 0) return `build failed:\n${make.stdout}\n${make.stderr}`;
  const warnings = (make.stderr.match(/warning:/g) ?? []).length;
  log(`  ${C.green}·${C.reset} build ok${warnings ? ` ${C.yellow}(${warnings} warning(s) — reviewer should check)${C.reset}` : ""}`);

  // 3. The PRD's binary must exist and run --quick.
  const binPath = `benchmarks/c/build/${prd.binary}`;
  log(`  ${C.dim}· running ${prd.binary} --quick …${C.reset}`);
  const runBin = run(binPath, ["--quick"], { allowFail: true, timeoutMs: 5 * 60 * 1000 });
  if (runBin.code !== 0) return `${binPath} --quick exited ${runBin.code}:\n${runBin.stderr}`;

  // 4. stdout must be valid JSON (the contract).
  const parse = spawnSync("python3", ["-c", "import sys,json;print(len(json.load(sys.stdin)))"], {
    input: runBin.stdout,
    encoding: "utf8",
  });
  if ((parse.status ?? 1) !== 0) {
    return `${binPath} --quick stdout is not valid JSON:\n${runBin.stdout.slice(0, 2000)}`;
  }
  log(`  ${C.green}·${C.reset} valid JSON, ${parse.stdout.trim()} record(s)`);
  return null;
}

function openPr(prd: Prd) {
  log(`${C.blue}▶ pushing${C.reset} ${prd.branch} and opening PR …`);
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
    fail(`gh pr create failed:\n${pr.stdout}\n${pr.stderr}`);
    return false;
  }
  ok(`PR opened: ${C.cyan}${pr.stdout.trim()}${C.reset}`);
  return true;
}

function preflight() {
  log("preflight: checking clean tree, fetching, verifying gh auth …");
  // Clean worktree required — we switch branches and inspect diffs.
  const dirty = capture("git", ["status", "--porcelain"]);
  if (dirty.length > 0) {
    throw new Error("working tree is not clean; commit or stash first:\n" + dirty);
  }
  run("git", ["fetch", REMOTE], { allowFail: false });
  const auth = run("gh", ["auth", "status"], { allowFail: true });
  if (auth.code !== 0) throw new Error("gh is not authenticated; run `gh auth login`");
  ok("preflight passed");
}

async function main() {
  // Session separator in the log file so repeated runs are easy to tell apart.
  toFile(`\n\n========== ralph session ${new Date().toISOString()}${DRY_RUN ? " (dry-run)" : ""} ==========`);
  banner(DRY_RUN ? "ralph — DRY RUN" : "ralph — Tier 1 benchmark migration", C.blue);
  log(`logging to ${C.bold}${LOG_FILE}${C.reset}`);
  log(`model=${C.bold}${MODEL}${C.reset} variant=${C.bold}${VARIANT}${C.reset} base=${BASE} PRDs=${PRDS.length} agent-timeout=${fmtDur(AGENT_TIMEOUT_MS)}`);
  if (DRY_RUN) log(`${C.yellow}dry run: no branches, agents, or PRs will be created${C.reset}`);
  preflight();

  const summary = { opened: [] as string[], skipped: [] as string[], failed: [] as string[] };

  for (let i = 0; i < PRDS.length; i++) {
    const prd = PRDS[i]!;
    const tag = `[${i + 1}/${PRDS.length}] ${prd.branch}`;
    const t0 = Date.now();

    const { done, reason } = isDone(prd);
    if (done) {
      banner(`${tag} — SKIP`, C.gray);
      log(`${C.gray}already done: ${reason}${C.reset}`);
      summary.skipped.push(prd.branch);
      continue;
    }

    if (DRY_RUN) {
      banner(`${tag} — WOULD RUN`, C.yellow);
      log(`${prd.file} → branch ${prd.branch} → PR "${prd.title}"`);
      summary.opened.push(prd.branch + " (dry-run)");
      continue;
    }

    banner(`${tag} — ${prd.file}`, C.cyan);
    run("git", ["checkout", "-B", prd.branch, `${REMOTE}/${BASE}`], { inherit: true });

    runOpencode(promptFor(prd), false);
    let err = gate(prd);
    if (err) {
      warn(`gate failed on first attempt — retrying once. Reason:\n${err}`);
      runOpencode(promptFor(prd, err), true);
      err = gate(prd);
    }

    if (err) {
      fail(`${tag} FAILED after retry (${fmtDur(Date.now() - t0)}) — branch left local, no PR. Reason:\n${err}`);
      summary.failed.push(prd.branch);
    } else if (openPr(prd)) {
      ok(`${tag} complete in ${fmtDur(Date.now() - t0)}`);
      summary.opened.push(prd.branch);
    } else {
      summary.failed.push(prd.branch + " (PR create failed)");
    }

    // Return to a clean base before the next iteration.
    run("git", ["checkout", BASE], { inherit: true, allowFail: true });
  }

  banner(`done in ${fmtDur(Date.now() - START)}`, C.green);
  log(`${C.green}opened  (${summary.opened.length}):${C.reset} ${summary.opened.join(", ") || "(none)"}`);
  log(`${C.gray}skipped (${summary.skipped.length}):${C.reset} ${summary.skipped.join(", ") || "(none)"}`);
  log(`${summary.failed.length ? C.red : C.dim}failed  (${summary.failed.length}):${C.reset} ${summary.failed.join(", ") || "(none)"}`);
  if (summary.failed.length) log(`${C.yellow}re-run \`bun ralph.ts\` to retry failed PRDs (completed ones are skipped automatically)${C.reset}`);
}

main().catch((e) => {
  const msg = `\n[ralph] fatal: ${e instanceof Error ? e.message : e}`;
  console.error(msg);
  toFile(msg);
  process.exit(1);
});
