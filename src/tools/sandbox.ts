/** Sandbox lifecycle tools: status, list, create, stop/start/suspend/resume, delete. */

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { SandboxRef, SandboxSpec } from "@ai-openshell/sdk";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { parse as parseYaml } from "yaml";

import { describeError } from "../client.ts";
import { rawWorkspaceScope, workspaceScope, type Context } from "../context.ts";
import { formatAge, formatLabels, table } from "../format.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_LIST_LIMIT = 500;

async function loadPolicy(path: string, cwd: string): Promise<SandboxSpec["policy"]> {
  const full = isAbsolute(path) ? path : resolve(cwd, path);
  const text = await readFile(full, "utf8");
  try {
    const parsed: unknown = parseYaml(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a policy object at the top level");
    }
    return parsed as SandboxSpec["policy"];
  } catch (error) {
    throw new Error(`policy file ${full}: ${(error as Error).message}`);
  }
}

export function registerSandboxTools(pi: ExtensionAPI, context: Context): void {
  pi.registerTool({
    name: "openshell_status",
    label: "OpenShell status",
    description:
      "Check OpenShell gateway reachability and version, then summarize sandboxes by phase in the current workspace.",
    promptSnippet: "Check the OpenShell gateway (health, version, sandbox counts)",
    promptGuidelines: [
      "Use openshell_status before other openshell_* tools when you are unsure the gateway is reachable or which workspace is in scope.",
    ],
    parameters: Type.Object({
      workspace: Type.Optional(Type.String({ description: "Workspace to summarize; defaults to the configured workspace." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const { client, config } = await context.gateway(ctx.cwd);
        const workspace = await context.workspace(ctx.cwd, params.workspace);
        const health = await client.health();
        const page = await client.sandbox.list({ ...workspaceScope(workspace), pageSize: 100 }).nextPage();
        const sandboxes = page?.items ?? [];
        const phases: Record<string, number> = {};
        for (const sandbox of sandboxes) phases[sandbox.phase] = (phases[sandbox.phase] ?? 0) + 1;
        const lines = [
          `gateway: ${config.gateway}`,
          `health: ${health.status} (OpenShell ${health.version})`,
          `workspace: ${workspace ?? "default"}`,
          `sandboxes: ${sandboxes.length}${page?.nextPageToken ? "+" : ""}`,
        ];
        const phaseText = Object.entries(phases)
          .map(([phase, count]) => `${phase}=${count}`)
          .join(" ");
        if (phaseText) lines.push(`phases: ${phaseText}`);
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            gateway: config.gateway,
            status: health.status,
            version: health.version,
            workspace: workspace ?? "default",
            total: sandboxes.length,
            phases,
          },
        };
      } catch (error) {
        throw new Error(describeError(error));
      }
    },
  });

  pi.registerTool({
    name: "openshell_list",
    label: "OpenShell sandboxes",
    description: "List OpenShell sandboxes with phase, age, workspace, template, and labels.",
    promptSnippet: "List OpenShell sandboxes in the gateway",
    promptGuidelines: [
      "Use openshell_list to find a sandbox name before calling openshell_exec, openshell_logs, or openshell_delete.",
    ],
    parameters: Type.Object({
      workspace: Type.Optional(Type.String({ description: "Workspace to list; defaults to the configured workspace." })),
      all_workspaces: Type.Optional(Type.Boolean({ description: "Platform-admin view across every authorized workspace." })),
      label_selector: Type.Optional(
        Type.String({ description: "Label selector in key=value,key=value form.", examples: ["team=runtime"] }),
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIST_LIMIT, description: "Maximum sandboxes to return (default 50)." })),
      show_labels: Type.Optional(Type.Boolean({ description: "Include the label column (default false)." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const { client } = await context.gateway(ctx.cwd);
        const limit = params.limit ?? 50;
        const workspace = params.all_workspaces ? undefined : await context.workspace(ctx.cwd, params.workspace);
        const listOptions = params.all_workspaces
          ? { allWorkspaces: true as const, pageSize: Math.min(limit, 100), labelSelector: params.label_selector }
          : { ...workspaceScope(workspace), pageSize: Math.min(limit, 100), labelSelector: params.label_selector };

        const collected: SandboxRef[] = [];
        const pager = client.sandbox.list(listOptions);
        for (;;) {
          const page = await pager.nextPage();
          if (!page) break;
          collected.push(...page.items);
          if (collected.length >= limit) break;
        }
        const sandboxes = collected.slice(0, limit);
        const showWorkspace = Boolean(params.all_workspaces);
        const showLabels = Boolean(params.show_labels);
        const headers = ["name", "phase", "age", ...(showWorkspace ? ["workspace"] : []), "template", ...(showLabels ? ["labels"] : [])];
        const rows = sandboxes.map((sandbox) => {
          const row = [sandbox.name, sandbox.phase, formatAge(sandbox.createdAtMs)];
          if (showWorkspace) row.push(sandbox.workspace);
          row.push(sandbox.createdFromWorkloadTemplate?.name ?? "");
          if (showLabels) row.push(formatLabels(sandbox.labels));
          return row;
        });
        const header = collected.length > limit ? `${limit} of ${collected.length}+ sandboxes` : `${sandboxes.length} sandboxes`;
        const text = sandboxes.length === 0 ? "no sandboxes matched" : `${header}\n\n${table(headers, rows)}`;
        return {
          content: [{ type: "text" as const, text }],
          details: {
            count: sandboxes.length,
            allWorkspaces: Boolean(params.all_workspaces),
            sandboxes: sandboxes.map((sandbox) => ({
              name: sandbox.name,
              phase: sandbox.phase,
              workspace: sandbox.workspace,
              ageSeconds: sandbox.createdAtMs ? Math.round((Date.now() - sandbox.createdAtMs) / 1000) : undefined,
              labels: sandbox.labels,
            })),
          },
        };
      } catch (error) {
        throw new Error(describeError(error));
      }
    },
  });

  pi.registerTool({
    name: "openshell_create",
    label: "Create OpenShell sandbox",
    description:
      "Create an OpenShell sandbox from an image or a workload template, optionally with a create-time policy, providers, environment, labels, and exposed service ports.",
    promptSnippet: "Create an OpenShell sandbox from an image or template",
    promptGuidelines: [
      "Use openshell_create when the user needs an isolated sandbox to run commands in; set the create-time policy from a file with policy_file because filesystem, landlock, and process policy cannot be added later.",
    ],
    parameters: Type.Object({
      image: Type.Optional(Type.String({ description: "Workload container image. Required unless template is set." })),
      template: Type.Optional(Type.String({ description: "Workload template name to create from instead of an image." })),
      name: Type.Optional(Type.String({ description: "Sandbox name, lowercase letters/digits/hyphens, at most 19 characters (gateway generates one when omitted)." })),
      workspace: Type.Optional(Type.String()),
      providers: Type.Optional(Type.Array(Type.String(), { description: "Providers to attach at creation, e.g. github." })),
      environment: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Environment variables for the workload." })),
      labels: Type.Optional(Type.Record(Type.String(), Type.String())),
      command: Type.Optional(Type.Array(Type.String(), { description: "Canonical main process argv; omit for the gateway scratch shell." })),
      gpu: Type.Optional(Type.Boolean({ description: "Request GPU access." })),
      tty: Type.Optional(Type.Boolean({ description: "Allocate a PTY for the canonical command." })),
      service_ports: Type.Optional(Type.Array(Type.Integer(), { description: "Loopback TCP ports to expose as services." })),
      policy_file: Type.Optional(Type.String({ description: "Path to a create-time policy file (YAML or JSON)." })),
      wait_ready_secs: Type.Optional(
        Type.Integer({ minimum: 0, maximum: 1800, description: "Wait for the sandbox to become ready (default 120s; 0 skips the wait)." }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (Boolean(params.image) === Boolean(params.template)) {
        throw new Error("pass exactly one of image or template");
      }
      if (params.name && params.name.length > 19) {
        throw new Error(`sandbox name ${JSON.stringify(params.name)} is ${params.name.length} characters; the gateway allows at most 19`);
      }
      try {
        const { client } = await context.gateway(ctx.cwd);
        const workspace = await context.workspace(ctx.cwd, params.workspace);
        const policy = params.policy_file ? await loadPolicy(params.policy_file, ctx.cwd) : undefined;
        const common = {
          ...workspaceScope(workspace),
          name: params.name,
          labels: params.labels,
          providers: params.providers,
          command: params.command,
          tty: params.tty,
          serviceExposures: params.service_ports?.map((targetPort) => ({ targetPort })),
          policy,
        };
        const sandbox = params.template
          ? await client.sandbox.createFromTemplate({ ...common, workloadTemplate: params.template })
          : await client.sandbox.create({
              ...common,
              image: params.image,
              environment: params.environment,
              gpu: params.gpu,
            });

        const waitSecs = params.wait_ready_secs ?? 120;
        let ready = sandbox;
        if (waitSecs > 0) {
          if (signal?.aborted) throw new Error("cancelled");
          onUpdate?.({
            content: [{ type: "text", text: `creating ${sandbox.name} (${sandbox.phase}); waiting up to ${waitSecs}s for ready` }],
            details: { name: sandbox.name, phase: sandbox.phase, waiting: true },
          });
          ready = await client.sandbox.waitReady(sandbox.name, waitSecs, { ...workspaceScope(workspace), signal });
        }

        const lines = [
          `sandbox: ${ready.name}`,
          `workspace: ${ready.workspace}`,
          `phase: ${ready.phase}`,
          `id: ${ready.id}`,
        ];
        if (ready.createdFromWorkloadTemplate) lines.push(`template: ${ready.createdFromWorkloadTemplate.name}`);
        for (const [service, url] of Object.entries(ready.serviceUrls)) {
          lines.push(`service ${service || "(unnamed)"}: ${url}`);
        }
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            name: ready.name,
            id: ready.id,
            workspace: ready.workspace,
            phase: ready.phase,
            serviceUrls: ready.serviceUrls,
          },
        };
      } catch (error) {
        throw new Error(describeError(error));
      }
    },
  });

  pi.registerTool({
    name: "openshell_lifecycle",
    label: "OpenShell sandbox lifecycle",
    description: "Stop, start, suspend, or resume an existing OpenShell sandbox and report the resulting phase.",
    promptSnippet: "Stop, start, suspend, or resume a sandbox",
    parameters: Type.Object({
      sandbox: Type.String({ description: "Sandbox name." }),
      action: StringEnum(["stop", "start", "suspend", "resume"] as const),
      workspace: Type.Optional(Type.String()),
      restart_if_restore_fails: Type.Optional(
        Type.Boolean({ description: "resume only: boot cleanly when the retained memory state cannot be restored (default true)." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const { client } = await context.gateway(ctx.cwd);
        const workspace = await context.workspace(ctx.cwd, params.workspace);
        // These RPCs accept only a named workspace selection, so resolve the
        // sandbox's own workspace instead of relying on the gateway default.
        const current = await client.sandbox.get(params.sandbox, workspaceScope(workspace));
        const selector = rawWorkspaceScope(current.workspace);
        switch (params.action) {
          case "stop":
            await client.raw.stopSandbox({ name: params.sandbox, workspaceScope: selector, requestId: randomUUID() });
            break;
          case "start":
            await client.raw.startSandbox({ name: params.sandbox, workspaceScope: selector, requestId: randomUUID() });
            break;
          case "suspend":
            await client.raw.suspendSandbox({ name: params.sandbox, workspaceScope: selector });
            break;
          case "resume":
            await client.raw.resumeSandbox({
              name: params.sandbox,
              workspaceScope: selector,
              restartIfRestoreFails: params.restart_if_restore_fails ?? true,
            });
            break;
        }
        const sandbox = await client.sandbox.get(params.sandbox, { workspace: current.workspace });
        return {
          content: [{ type: "text" as const, text: `${params.action} ${sandbox.name}: phase ${sandbox.phase}` }],
          details: { action: params.action, name: sandbox.name, phase: sandbox.phase },
        };
      } catch (error) {
        throw new Error(describeError(error));
      }
    },
  });

  pi.registerTool({
    name: "openshell_delete",
    label: "Delete OpenShell sandbox",
    description:
      "Delete a sandbox. Deletion returns a typed outcome; when cleanup is only accepted, wait for the name to disappear.",
    promptSnippet: "Delete an OpenShell sandbox",
    promptGuidelines: [
      "Use openshell_delete only when the user asked to remove a sandbox; confirm the name with openshell_list first.",
    ],
    parameters: Type.Object({
      sandbox: Type.String({ description: "Sandbox name." }),
      workspace: Type.Optional(Type.String()),
      allow_missing: Type.Optional(Type.Boolean({ description: "Treat an already-absent sandbox as success (default false)." })),
      wait_secs: Type.Optional(
        Type.Integer({ minimum: 0, maximum: 900, description: "Wait this long for cleanup to finish (default 60s; 0 skips the wait)." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const { client } = await context.gateway(ctx.cwd);
        const workspace = await context.workspace(ctx.cwd, params.workspace);
        const deletion = await client.sandbox.delete(params.sandbox, {
          ...workspaceScope(workspace),
          allowMissing: params.allow_missing ?? false,
        });
        const waitSecs = params.wait_secs ?? 60;
        let waited = false;
        if (deletion.outcome === "accepted" && waitSecs > 0) {
          await client.sandbox.waitDeleted(params.sandbox, waitSecs, {
            ...workspaceScope(workspace),
            expectedSandboxId: deletion.sandboxId,
          });
          waited = true;
        }
        const settled = deletion.outcome === "completed" || deletion.outcome === "already_absent" || waited;
        const text = [
          `sandbox: ${params.sandbox}`,
          `outcome: ${deletion.outcome}${waited ? " (cleanup confirmed)" : ""}`,
          deletion.sandboxId ? `id: ${deletion.sandboxId}` : "",
          settled ? "" : "cleanup is still pending on the gateway",
        ]
          .filter(Boolean)
          .join("\n");
        return {
          content: [{ type: "text" as const, text }],
          details: {
            name: params.sandbox,
            outcome: deletion.outcome,
            waitedForCleanup: waited,
            settled,
          },
        };
      } catch (error) {
        throw new Error(describeError(error));
      }
    },
  });
}
