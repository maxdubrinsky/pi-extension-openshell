/**
 * Background exec jobs: run a sandbox command detached from the tool call that
 * started it, keep its full output in log files for review while it runs, and
 * wake the session when it exits.
 *
 * Jobs live in memory for the pi process, so `/reload` or a restart drops the
 * job list; the log files survive and stay readable.
 */

import { createWriteStream, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { OpenShellClient } from "@ai-openshell/sdk";

import { describeError } from "./client.ts";
import { formatBytes, oneLine } from "./format.ts";

const TAIL_CHARS = 4096;
const WAKE_TAIL_CHARS = 1500;

export type JobPhase = "running" | "exited" | "failed" | "stopped";

export interface JobLogs {
  stdout: string;
  stderr: string;
}

export interface JobSnapshot {
  id: string;
  sandbox: string;
  workspace?: string;
  command: string;
  phase: JobPhase;
  startedAt: number;
  endedAt?: number;
  durationMs: number;
  exitCode?: number;
  stdoutBytes: number;
  stderrBytes: number;
  error?: string;
  logs: JobLogs;
}

export interface StartJobOptions {
  sandbox: string;
  argv: string[];
  workspace?: string;
  workdir?: string;
  environment?: Record<string, string>;
  timeoutSecs: number;
  /** Wake the session when the job exits (default true). */
  notify: boolean;
}

export interface JobStatus {
  job: JobSnapshot;
  stdoutTail: string;
  stderrTail: string;
}

interface Job extends JobSnapshot {
  stdoutTail: string;
  stderrTail: string;
  notify: boolean;
  controller: AbortController;
  done: Promise<void>;
}

function pushTail(current: string, chunk: string, cap = TAIL_CHARS): string {
  const next = current + chunk;
  return next.length <= cap ? next : next.slice(next.length - cap);
}

/** Last `maxChars` characters, with a marker when the tail was cut. */
export function tailText(tail: string, maxChars: number): string {
  if (tail.length <= maxChars) return tail.trimEnd();
  return `... [${tail.length - maxChars} characters omitted] ...\n${tail.slice(tail.length - maxChars).trimEnd()}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds % 60)}s`;
}

function closeStream(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  return new Promise((resolve) => stream.end(() => resolve()));
}

function snapshot(job: Job): JobSnapshot {
  const endedAt = job.endedAt;
  return {
    id: job.id,
    sandbox: job.sandbox,
    ...(job.workspace ? { workspace: job.workspace } : {}),
    command: job.command,
    phase: job.phase,
    startedAt: job.startedAt,
    ...(endedAt ? { endedAt } : {}),
    durationMs: (endedAt ?? Date.now()) - job.startedAt,
    ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
    stdoutBytes: job.stdoutBytes,
    stderrBytes: job.stderrBytes,
    ...(job.error ? { error: job.error } : {}),
    logs: job.logs,
  };
}

/** One-line job header shared by the list and status views. */
export function describeJob(job: JobSnapshot): string {
  const state =
    job.phase === "exited"
      ? `exited ${job.exitCode ?? "?"}`
      : job.phase === "running"
        ? "running"
        : job.phase;
  const parts = [
    `${job.id}: ${job.sandbox} ${state}`,
    formatDuration(job.durationMs),
    `${formatBytes(job.stdoutBytes)} stdout`,
    formatBytes(job.stderrBytes) + " stderr",
    job.command,
  ];
  if (job.error) parts.push(`error: ${job.error}`);
  return parts.join("  ");
}

export class JobManager {
  private jobs = new Map<string, Job>();
  private nextId = 1;
  private wake: ((content: string) => void) | undefined;

  /** How to reach the session from a background completion. */
  setWaker(wake: (content: string) => void): void {
    this.wake = wake;
  }

  start(client: OpenShellClient, options: StartJobOptions): JobSnapshot {
    const id = `j${this.nextId++}`;
    const stamp = new Date().toISOString().replace(/[-:.]/g, "");
    const safeName = options.sandbox.replace(/[^A-Za-z0-9_-]+/g, "-");
    const base = join(this.logDir(), `${stamp}-${id}-${safeName}`);
    const job: Job = {
      id,
      sandbox: options.sandbox,
      ...(options.workspace ? { workspace: options.workspace } : {}),
      command: oneLine(options.argv.join(" "), 120),
      phase: "running",
      startedAt: Date.now(),
      durationMs: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
      logs: { stdout: `${base}.stdout.log`, stderr: `${base}.stderr.log` },
      stdoutTail: "",
      stderrTail: "",
      notify: options.notify,
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    this.jobs.set(id, job);
    job.done = this.run(client, job, options);
    return snapshot(job);
  }

  list(): JobSnapshot[] {
    return [...this.jobs.values()].map(snapshot);
  }

  /** Resolve a job by id, else by sandbox name (the most recent match wins). */
  find(reference: string): Job | undefined {
    const direct = this.jobs.get(reference);
    if (direct) return direct;
    let match: Job | undefined;
    for (const job of this.jobs.values()) {
      if (job.sandbox !== reference) continue;
      if (!match || job.startedAt >= match.startedAt) match = job;
    }
    return match;
  }

  get(reference: string): JobSnapshot | undefined {
    const job = this.find(reference);
    return job ? snapshot(job) : undefined;
  }

  /** Current state plus the retained tail of each stream. */
  status(reference: string, maxChars: number): JobStatus | undefined {
    const job = this.find(reference);
    if (!job) return undefined;
    return {
      job: snapshot(job),
      stdoutTail: tailText(job.stdoutTail, maxChars),
      stderrTail: tailText(job.stderrTail, maxChars),
    };
  }

  /** Abort a running job; returns the snapshot it left behind. */
  stop(reference: string): JobSnapshot {
    const job = this.find(reference);
    if (!job) throw new Error(`no job matches ${reference}`);
    if (job.phase === "running") {
      job.phase = "stopped";
      job.endedAt = Date.now();
      job.controller.abort();
    }
    return snapshot(job);
  }

  stopAll(): void {
    for (const job of this.jobs.values()) {
      if (job.phase !== "running") continue;
      job.phase = "stopped";
      job.endedAt = Date.now();
      job.controller.abort();
    }
  }

  /** Wait for a job to finish, the caller to abort, or `timeoutMs` to pass. */
  async wait(
    reference: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ status: JobStatus; timedOut: boolean }> {
    const job = this.find(reference);
    if (!job) throw new Error(`no job matches ${reference}`);
    if (job.phase !== "running") return { status: { job: snapshot(job), ...this.tails(job) }, timedOut: false };
    if (signal?.aborted) return { status: { job: snapshot(job), ...this.tails(job) }, timedOut: true };
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const interrupted = new Promise<"timeout">((resolve) => {
      onAbort = () => resolve("timeout");
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    const outcome = await Promise.race([
      job.done.then(() => "done" as const),
      timeout,
      interrupted,
    ]);
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    return { status: { job: snapshot(job), ...this.tails(job) }, timedOut: outcome !== "done" };
  }

  private tails(job: Job, maxChars = TAIL_CHARS): { stdoutTail: string; stderrTail: string } {
    return { stdoutTail: tailText(job.stdoutTail, maxChars), stderrTail: tailText(job.stderrTail, maxChars) };
  }

  private logDir(): string {
    const base = process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
    const dir = join(base, "pi-openshell", "jobs");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  private async run(client: OpenShellClient, job: Job, options: StartJobOptions): Promise<void> {
    const stdout = createWriteStream(job.logs.stdout);
    const stderr = createWriteStream(job.logs.stderr);
    const stream = client.sandbox.execStream(job.sandbox, options.argv, {
      ...(options.workspace ? { workspace: options.workspace } : {}),
      workdir: options.workdir,
      environment: options.environment,
      timeoutSecs: options.timeoutSecs,
      signal: job.controller.signal,
    });
    const iterator = stream[Symbol.asyncIterator]();
    // Stop pulling even if the transport never honours the abort signal, so a
    // stopped job always settles instead of hanging the job list.
    const aborted = new Promise<"aborted">((resolve) => {
      if (job.controller.signal.aborted) resolve("aborted");
      else job.controller.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
    let exitCode: number | undefined;
    try {
      for (;;) {
        const next = await Promise.race([iterator.next(), aborted]);
        if (next === "aborted") {
          // Do not await this: a transport stuck on a pending read would keep the
          // job from ever settling.
          const closed = iterator.return?.(undefined);
          if (closed) void closed.catch(() => {});
          break;
        }
        if (next.done) break;
        const event = next.value;
        if ("type" in event) {
          exitCode = event.exitCode;
          continue;
        }
        const text = event.data.toString("utf8");
        if (event.stream === "stdout") {
          job.stdoutBytes += event.data.byteLength;
          job.stdoutTail = pushTail(job.stdoutTail, text);
          stdout.write(event.data);
        } else {
          job.stderrBytes += event.data.byteLength;
          job.stderrTail = pushTail(job.stderrTail, text);
          stderr.write(event.data);
        }
      }
      if (job.controller.signal.aborted) {
        job.phase = "stopped";
      } else {
        if (exitCode === undefined) throw new Error("the gateway closed the exec stream without an exit event");
        job.exitCode = exitCode;
        job.phase = "exited";
      }
    } catch (error) {
      if (job.controller.signal.aborted) {
        job.phase = "stopped";
      } else {
        job.phase = "failed";
        job.error = describeError(error);
      }
    } finally {
      job.endedAt = Date.now();
      job.durationMs = job.endedAt - job.startedAt;
      await Promise.all([closeStream(stdout), closeStream(stderr)]);
      if (job.notify && job.phase !== "stopped") this.announce(job);
    }
  }

  private announce(job: Job): void {
    if (!this.wake) return;
    const lines = [
      `OpenShell exec ${job.id} ${job.phase === "exited" ? `exited with code ${job.exitCode}` : "failed"} in sandbox ${job.sandbox} after ${formatDuration(job.durationMs)} (${formatBytes(job.stdoutBytes)} stdout, ${formatBytes(job.stderrBytes)} stderr).`,
    ];
    if (job.error) lines.push(`error: ${job.error}`);
    const outTail = tailText(job.stdoutTail, WAKE_TAIL_CHARS);
    const errTail = tailText(job.stderrTail, WAKE_TAIL_CHARS);
    if (outTail) lines.push("", "stdout tail:", outTail);
    if (errTail) lines.push("", "stderr tail:", errTail);
    if (!outTail && !errTail) lines.push("", "(no output)");
    lines.push(
      "",
      `Full output: ${job.logs.stdout}`,
      `Full stderr: ${job.logs.stderr}`,
      `Read the logs directly with read, or use openshell_jobs { action: "status", id: "${job.id}" }.`,
    );
    try {
      this.wake(lines.join("\n"));
    } catch {
      // The session may already be gone; the log files remain.
    }
  }
}
