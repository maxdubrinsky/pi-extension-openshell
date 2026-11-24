/** Background job bookkeeping, driven by a fake gateway stream. */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { OpenShellClient, ExecStreamEvent } from "@ai-openshell/sdk";

import { JobManager } from "../src/jobs.ts";

/** An exec stream the test drives chunk by chunk. */
class Channel {
  private queue: ExecStreamEvent[] = [];
  private waiter: (() => void) | undefined;
  private done = false;
  private failure: unknown;

  push(event: ExecStreamEvent): void {
    this.queue.push(event);
    this.waiter?.();
  }

  close(): void {
    this.done = true;
    this.waiter?.();
  }

  fail(error: unknown): void {
    this.failure = error;
    this.done = true;
    this.waiter?.();
  }

  async *events(): AsyncGenerator<ExecStreamEvent> {
    for (;;) {
      while (this.queue.length === 0) {
        if (this.done) {
          if (this.failure) throw this.failure;
          return;
        }
        await new Promise<void>((resolve) => {
          this.waiter = resolve;
        });
        this.waiter = undefined;
      }
      const event = this.queue.shift();
      if (event) yield event;
    }
  }
}

interface Harness {
  jobs: JobManager;
  channel: Channel;
  wakes: string[];
  start: (notify?: boolean) => ReturnType<JobManager["start"]>;
}

function harness(): Harness {
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "pi-openshell-jobs-"));
  const channel = new Channel();
  const client = {
    sandbox: {
      execStream: () => channel.events(),
    },
  } as unknown as OpenShellClient;
  const jobs = new JobManager();
  const wakes: string[] = [];
  jobs.setWaker((content) => wakes.push(content));
  const start = (notify = true) =>
    jobs.start(client, { sandbox: "demo", argv: ["/bin/sh", "-lc", "echo hi"], timeoutSecs: 30, notify });
  return { jobs, channel, wakes, start };
}

test("a background job records output and wakes the session when it exits", async () => {
  const { jobs, channel, wakes, start } = harness();
  const job = start();
  assert.equal(job.phase, "running");

  channel.push({ stream: "stdout", data: Buffer.from("draft one\n") });
  channel.push({ stream: "stderr", data: Buffer.from("warn\n") });
  channel.push({ stream: "stdout", data: Buffer.from("draft two\n") });
  channel.push({ type: "exit", exitCode: 0 });
  channel.close();

  const { status, timedOut } = await jobs.wait(job.id, 5000);
  assert.equal(timedOut, false);
  assert.equal(status.job.phase, "exited");
  assert.equal(status.job.exitCode, 0);
  assert.match(status.stdoutTail, /draft two/);
  assert.match(status.stderrTail, /warn/);

  assert.equal(readFileSync(job.logs.stdout, "utf8"), "draft one\ndraft two\n");
  assert.equal(readFileSync(job.logs.stderr, "utf8"), "warn\n");

  assert.equal(wakes.length, 1);
  assert.match(wakes[0] ?? "", /exited with code 0/);
  assert.match(wakes[0] ?? "", /draft two/);
  assert.match(wakes[0] ?? "", new RegExp(job.logs.stdout.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a non-zero exit is still a completion, and notify false stays silent", async () => {
  const { jobs, channel, wakes, start } = harness();
  const job = start(false);
  channel.push({ stream: "stdout", data: Buffer.from("boom\n") });
  channel.push({ type: "exit", exitCode: 3 });
  channel.close();

  const { status } = await jobs.wait(job.id, 5000);
  assert.equal(status.job.phase, "exited");
  assert.equal(status.job.exitCode, 3);
  assert.deepEqual(wakes, []);
});

test("stopping a running job aborts it without waking the session", async () => {
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "pi-openshell-jobs-"));
  const jobs = new JobManager();
  const wakes: string[] = [];
  jobs.setWaker((content) => wakes.push(content));
  const client = {
    sandbox: {
      // A transport that ignores the abort signal: the job must still settle.
      execStream: async function* () {
        yield { stream: "stdout" as const, data: Buffer.from("partial\n") };
        await new Promise<void>(() => {});
      },
    },
  } as unknown as OpenShellClient;

  const job = jobs.start(client, { sandbox: "demo", argv: ["sleep", "600"], timeoutSecs: 3600, notify: true });
  while ((jobs.get(job.id)?.stdoutBytes ?? 0) === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  const stopped = jobs.stop(job.id);
  assert.equal(stopped.phase, "stopped");
  const { status } = await jobs.wait(job.id, 5000);
  assert.equal(status.job.phase, "stopped");
  assert.equal(readFileSync(job.logs.stdout, "utf8"), "partial\n");
  assert.deepEqual(wakes, []);
});

test("wait reports a timeout while the job keeps running, and lookups fall back to the sandbox", async () => {
  const { jobs, channel, start } = harness();
  const job = start(false);
  const waiting = await jobs.wait("demo", 20);
  assert.equal(waiting.timedOut, true);
  assert.equal(waiting.status.job.phase, "running");
  assert.equal(jobs.find("demo")?.id, job.id);
  assert.equal(jobs.get("nope"), undefined);

  channel.push({ type: "exit", exitCode: 1 });
  channel.close();
  const { status, timedOut } = await jobs.wait(job.id, 5000);
  assert.equal(timedOut, false);
  assert.equal(status.job.exitCode, 1);
  assert.equal(jobs.list().length, 1);
});

test("wait returns early when the caller is aborted", async () => {
  const { jobs, start } = harness();
  const job = start(false);
  const controller = new AbortController();
  controller.abort();
  const { status, timedOut } = await jobs.wait(job.id, 5000, controller.signal);
  assert.equal(timedOut, true);
  assert.equal(status.job.phase, "running");
  jobs.stop(job.id);
});
