/** Running work inside sandboxes: exec, log tailing, and port forwards. */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { describeError } from "../client.ts";
import { workspaceScope, type Context } from "../context.ts";
import { formatBytes, oneLine, truncateMiddle } from "../format.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ForwardEntry {
  id: string;
  sandbox: string;
  workspace?: string;
  localAddress: string;
  targetPort: number;
  startedAt: number;
  close: () => Promise<void>;
}

const PROGRESS_MIN_BYTES = 16 * 1024;

export function registerExecTools(pi: ExtensionAPI, context: Context): void {
  const forwards = new Map<string, ForwardEntry>();
  let nextForwardId = 1;

  pi.registerTool({
    name: "openshell_exec",
    label: "OpenShell exec",
    description:
      "Run a command inside an OpenShell sandbox and return its exit code, stdout, and stderr. Output streams as it arrives and is truncated in the middle when large.",
    promptSnippet: "Run a command inside an OpenShell sandbox",
    promptGuidelines: [
      "Use openshell_exec to run commands inside a sandbox; built-in bash runs on the host, which is not isolated by the gateway.",
    ],
    parameters: Type.Object({
      sandbox: Type.String({ description: "Sandbox name." }),
      command: Type.Union([
        Type.String({ description: "Shell command line, run with /bin/sh -lc unless shell is false." }),
        Type.Array(Type.String(), { description: "Exact argv, run without a shell." }),
      ]),
      shell: Type.Optional(Type.Boolean({ description: "Wrap a string command in a login shell (default true) or a plain sh -c (false)." })),
      workspace: Type.Optional(Type.String()),
      workdir: Type.Optional(Type.String({ description: "Working directory inside the sandbox." })),
      environment: Type.Optional(Type.Record(Type.String(), Type.String())),
      timeout_secs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600, description: "Command timeout (default 300s)." })),
      max_output_chars: Type.Optional(
        Type.Integer({ minimum: 500, maximum: 200000, description: "Cap for returned stdout+stderr text (default 20000)." }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      try {
        const { client } = await context.gateway(ctx.cwd);
        const workspace = await context.workspace(ctx.cwd, params.workspace);
        const argv =
          typeof params.command === "string"
            ? ["/bin/sh", params.shell === false ? "-c" : "-lc", params.command]
            : params.command;
        if (argv.length === 0) throw new Error("command must not be empty");
        const timeoutSecs = params.timeout_secs ?? 300;
        const maxChars = params.max_output_chars ?? 20000;
        const keepBytes = maxChars * 4;
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let keptStdout = 0;
        let keptStderr = 0;
        let exitCode: number | undefined;
        let lastProgress = 0;

        for await (const event of client.sandbox.execStream(params.sandbox, argv, {
          ...workspaceScope(workspace),
          workdir: params.workdir,
          environment: params.environment,
          timeoutSecs,
          signal,
        })) {
          if ("type" in event) {
            exitCode = event.exitCode;
            continue;
          }
          if (event.stream === "stdout") {
            stdoutBytes += event.data.byteLength;
            if (keptStdout < keepBytes) {
              stdout.push(event.data);
              keptStdout += event.data.byteLength;
            }
          } else {
            stderrBytes += event.data.byteLength;
            if (keptStderr < keepBytes) {
              stderr.push(event.data);
              keptStderr += event.data.byteLength;
            }
          }
          const total = stdoutBytes + stderrBytes;
          if (onUpdate && total - lastProgress >= PROGRESS_MIN_BYTES) {
            lastProgress = total;
            onUpdate({
              content: [
                {
                  type: "text",
                  text: `running in ${params.sandbox}: ${formatBytes(stdoutBytes)} stdout, ${formatBytes(stderrBytes)} stderr`,
                },
              ],
              details: { exitCode: undefined, stdoutBytes, stderrBytes, truncated: false },
            });
          }
        }
        if (exitCode === undefined) throw new Error("the gateway closed the exec stream without an exit event");

        const outText = truncateMiddle(Buffer.concat(stdout).toString("utf8"), maxChars);
        const errText = truncateMiddle(Buffer.concat(stderr).toString("utf8"), maxChars);
        const lines = [`exit code: ${exitCode}`];
        if (outText.text.trim()) lines.push("", "stdout:", outText.text);
        if (errText.text.trim()) lines.push("", "stderr:", errText.text);
        if (!outText.text.trim() && !errText.text.trim()) lines.push("(no output)");

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          isError: exitCode !== 0,
          details: {
            exitCode,
            stdoutBytes,
            stderrBytes,
            truncated: outText.truncated || errText.truncated,
          },
        };
      } catch (error) {
        throw new Error(describeError(error));
      }
    },
  });

  pi.registerTool({
    name: "openshell_logs",
    label: "OpenShell logs",
    description:
      "Read a sandbox's recent supervisor and platform events (gateway logs, compute-backend events) with level and source filters.",
    promptSnippet: "Tail logs and platform events for a sandbox",
    promptGuidelines: [
      "Use openshell_logs when a sandbox is failing to start or a command inside it exited unexpectedly; it shows gateway-side reasons the sandbox itself cannot report.",
    ],
    parameters: Type.Object({
      sandbox: Type.String({ description: "Sandbox name." }),
      workspace: Type.Optional(Type.String()),
      tail_lines: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 1000, description: "Log lines to collect (default 100). Collection stops once this many arrive." }),
      ),
      include_events: Type.Optional(Type.Boolean({ description: "Also collect platform events from the compute backend (default true)." })),
      log_min_level: Type.Optional(Type.String({ description: "Minimum log level, e.g. INFO, WARN, ERROR." })),
      log_sources: Type.Optional(Type.Array(Type.String(), { description: "Restrict to sources such as gateway or sandbox." })),
      timeout_secs: Type.Optional(Type.Integer({ minimum: 1, maximum: 120, description: "How long to wait for the tail to fill (default 10s)." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const tailLines = params.tail_lines ?? 100;
      const timeoutSecs = params.timeout_secs ?? 10;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutSecs * 1000);
      try {
        const { client } = await context.gateway(ctx.cwd);
        const workspace = await context.workspace(ctx.cwd, params.workspace);
        const lines: string[] = [];
        let logCount = 0;
        let eventCount = 0;
        let warning: string | undefined;

        for await (const item of client.sandbox.watchLogs(params.sandbox, {
          ...workspaceScope(workspace),
          logTailLines: tailLines,
          eventTail: params.include_events === false ? 0 : tailLines,
          followEvents: params.include_events !== false,
          logMinLevel: params.log_min_level,
          logSources: params.log_sources,
          signal: controller.signal,
        })) {
          if (item.kind === "log") {
            logCount += 1;
            const stamp = item.line.timestampMs ? new Date(item.line.timestampMs).toISOString().slice(11, 23) : "--:--:--.---";
            const detail = oneLine(
              Object.entries(item.line.fields)
                .map(([key, value]) => `${key}=${value}`)
                .join(" "),
              200,
            );
            lines.push(
              `${stamp} ${item.line.level.padEnd(5)} ${item.line.source}/${item.line.target} ${item.line.message}${detail ? ` (${detail})` : ""}`,
            );
          } else if (item.kind === "event") {
            eventCount += 1;
            lines.push(
              `${new Date(item.event.timestampMs || Date.now()).toISOString().slice(11, 23)} EVENT ${item.event.source}/${item.event.type} ${item.event.reason}: ${item.event.message}`,
            );
          } else {
            warning = item.message;
          }
          if (logCount >= tailLines) break;
        }
        clearTimeout(timer);
        const text = lines.length === 0 ? `no log lines in the last ${timeoutSecs}s` : lines.join("\n");
        return {
          content: [{ type: "text" as const, text: warning ? `${text}\n\nwarning: ${warning}` : text }],
          details: { logCount, eventCount, warning },
        };
      } catch (error) {
        if (controller.signal.aborted) {
          return {
            content: [{ type: "text" as const, text: `timed out after ${timeoutSecs}s with no complete tail` }],
            details: { logCount: 0, eventCount: 0, warning: "timeout" },
          };
        }
        throw new Error(describeError(error));
      } finally {
        clearTimeout(timer);
      }
    },
  });

  pi.registerTool({
    name: "openshell_forward",
    label: "OpenShell port forward",
    description:
      "Forward a loopback TCP port from a sandbox to this machine, list active forwards, or close one. Forwards live only while this pi process runs.",
    promptSnippet: "Forward a sandbox port to localhost (start/list/stop)",
    promptGuidelines: [
      "Use openshell_forward start when the user needs to reach a service running inside a sandbox, then tell them the localhost address it returns.",
    ],
    parameters: Type.Object({
      action: StringEnum(["start", "list", "stop"] as const),
      sandbox: Type.Optional(Type.String({ description: "Sandbox name (start)." })),
      target_port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535, description: "Loopback port inside the sandbox (start)." })),
      local_port: Type.Optional(Type.Integer({ minimum: 0, maximum: 65535, description: "Local port to bind (start, default ephemeral)." })),
      workspace: Type.Optional(Type.String()),
      id: Type.Optional(Type.String({ description: "Forward id to close (stop)." })),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        if (params.action === "list") {
          if (forwards.size === 0) {
            return {
              content: [{ type: "text" as const, text: "no active forwards" }],
              details: { forwards: [] as Array<{ id: string; sandbox: string; localAddress: string; targetPort: number }> },
            };
          }
          const rows = [...forwards.values()].map((entry) => ({
            id: entry.id,
            sandbox: entry.sandbox,
            localAddress: entry.localAddress,
            targetPort: entry.targetPort,
          }));
          return {
            content: [
              {
                type: "text" as const,
                text: rows
                  .map((row) => `${row.id}: ${row.localAddress} -> ${row.sandbox}:${row.targetPort}`)
                  .join("\n"),
              },
            ],
            details: { forwards: rows },
          };
        }

        if (params.action === "stop") {
          const entry = params.id ? forwards.get(params.id) : [...forwards.values()].find((item) => item.sandbox === params.sandbox);
          if (!entry) throw new Error(params.id ? `no forward with id ${params.id}` : "no forward matches that sandbox");
          await entry.close();
          forwards.delete(entry.id);
          return {
            content: [{ type: "text" as const, text: `closed ${entry.id} (${entry.localAddress} -> ${entry.sandbox}:${entry.targetPort})` }],
            details: { forward: { id: entry.id, sandbox: entry.sandbox, localAddress: entry.localAddress, targetPort: entry.targetPort } },
          };
        }

        if (!params.sandbox) throw new Error("sandbox is required to start a forward");
        if (!params.target_port) throw new Error("target_port is required to start a forward");
        const { client } = await context.gateway(ctx.cwd);
        const workspace = await context.workspace(ctx.cwd, params.workspace);
        const handle = await client.sandbox.forward(params.sandbox, {
          ...workspaceScope(workspace),
          targetPort: params.target_port,
          localPort: params.local_port ?? 0,
        });
        const entry: ForwardEntry = {
          id: `f${nextForwardId++}`,
          sandbox: params.sandbox,
          workspace,
          localAddress: `${handle.localHost}:${handle.localPort}`,
          targetPort: handle.targetPort,
          startedAt: Date.now(),
          close: () => handle.close(),
        };
        forwards.set(entry.id, entry);
        void handle.closed.finally(() => forwards.delete(entry.id));
        return {
          content: [
            {
              type: "text" as const,
              text: `${entry.id}: ${entry.localAddress} -> ${entry.sandbox}:${entry.targetPort} (closes when pi exits)`,
            },
          ],
          details: { forward: { id: entry.id, sandbox: entry.sandbox, localAddress: entry.localAddress, targetPort: entry.targetPort } },
        };
      } catch (error) {
        throw new Error(describeError(error));
      }
    },
  });
}
