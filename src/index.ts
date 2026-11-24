/**
 * pi-extension-openshell: manage NVIDIA OpenShell sandboxes from pi through the
 * official TypeScript SDK (@ai-openshell/sdk).
 *
 * Tools:
 *   openshell_status      gateway health, version, sandbox counts by phase
 *   openshell_list        sandboxes with phase, age, workspace, template, labels
 *   openshell_create      create from an image or workload template (+ policy file)
 *   openshell_exec        run a command, streamed, with exit code and output;
 *                         background mode returns a job id and wakes the session on exit
 *   openshell_jobs        list, inspect, wait for, or stop background exec jobs
 *   openshell_logs        tail gateway-side logs and platform events
 *   openshell_lifecycle   stop / start / suspend / resume
 *   openshell_delete      delete and confirm cleanup
 *   openshell_forward     start / list / stop loopback port forwards
 *   openshell_policy      read effective policy, apply a network-only update
 *   openshell_providers   list / attach / detach providers
 *   openshell_templates   list / create / delete workload templates
 *
 * Command:
 *   /openshell [status|config|gateway <url>|gateway clear|workspace <name>|workspace clear|reload]
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { describeError } from "./client.ts";
import { ConfigError } from "./config.ts";
import { Context } from "./context.ts";
import { registerSandboxBashTool, DEFAULT_SANDBOX_WORKDIR } from "./tools/bash.ts";
import { registerConfigTools } from "./tools/config.ts";
import { registerEgressTools } from "./tools/egress.ts";
import { registerExecTools } from "./tools/exec.ts";
import { registerSandboxTools } from "./tools/sandbox.ts";

const HELP = [
  "/openshell                 gateway health, sandbox counts, bash routing",
  "/openshell use <sandbox>   route built-in bash into that sandbox",
  "/openshell use local       route built-in bash back to this host",
  "/openshell config          resolved connection config (secrets redacted)",
  "/openshell gateway <url>   use this gateway for the session",
  "/openshell gateway clear   go back to the configured gateway",
  "/openshell workspace <n>   default workspace for the session",
  "/openshell workspace clear back to the configured workspace",
  "/openshell reload          drop the cached connection",
].join("\n");

function normalizeGatewayUrl(input: string): string {
  const value = input.trim();
  const candidate = /^[a-z]+:\/\//i.test(value) ? value : `https://${value}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new ConfigError(`not a URL: ${input}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`gateway must be http:// or https://, got ${url.protocol}`);
  }
  return candidate;
}

export default function openshellExtension(pi: ExtensionAPI) {
  const context = new Context();

  // Headless sessions cannot run /openshell, so allow starting with bash already
  // routed into a sandbox. The sandbox must exist and be ready; failures surface
  // on the first command instead of blocking extension load.
  const preselect = process.env.OPENSHELL_SANDBOX?.trim();
  if (preselect) {
    context.selectSandbox({ name: preselect, workdir: process.env.OPENSHELL_SANDBOX_WORKDIR?.trim() || undefined });
  }

  registerSandboxBashTool(pi, context);
  registerSandboxTools(pi, context);
  registerExecTools(pi, context);
  registerConfigTools(pi, context);
  registerEgressTools(pi, context);

  pi.registerCommand("openshell", {
    description: "OpenShell gateway status and session config",
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();
      const [verb, ...rest] = trimmed.split(/\s+/);
      const operand = rest.join(" ").trim();

      try {
        switch (verb || "status") {
          case "help":
            ctx.ui.notify(HELP, "info");
            return;

          case "status": {
            const lines = [await context.summary(ctx.cwd)];
            const selection = context.selection;
            lines.push(
              selection
                ? `bash: sandbox ${selection.name} (workdir ${selection.workdir ?? DEFAULT_SANDBOX_WORKDIR})`
                : "bash: local host (use /openshell use <sandbox> to sandbox it)",
            );
            try {
              const { client } = await context.gateway(ctx.cwd);
              const health = await client.health();
              const workspace = await context.workspace(ctx.cwd);
              const page = await client.sandbox.list({ ...(workspace ? { workspace } : {}), pageSize: 100 }).nextPage();
              const phases: Record<string, number> = {};
              for (const sandbox of page?.items ?? []) phases[sandbox.phase] = (phases[sandbox.phase] ?? 0) + 1;
              lines.push(
                `health: ${health.status} (OpenShell ${health.version})`,
                `sandboxes: ${page?.items.length ?? 0}${Object.keys(phases).length ? ` (${Object.entries(phases).map(([phase, count]) => `${phase}=${count}`).join(" ")})` : ""}`,
              );
            } catch (error) {
              lines.push(`health: unreachable - ${describeError(error)}`);
            }
            ctx.ui.notify(lines.join("\n"), "info");
            return;
          }

          case "config": {
            ctx.ui.notify(await context.summary(ctx.cwd), "info");
            return;
          }

          case "gateway": {
            if (!operand || operand === "clear" || operand === "reset") {
              context.setGateway(undefined);
              ctx.ui.notify(`cleared the session gateway override\n${await context.summary(ctx.cwd)}`, "info");
              return;
            }
            context.setGateway(normalizeGatewayUrl(operand));
            ctx.ui.notify(`session gateway set to ${normalizeGatewayUrl(operand)}`, "info");
            return;
          }

          case "workspace": {
            if (!operand || operand === "clear" || operand === "reset") {
              context.setWorkspace(undefined);
              ctx.ui.notify("cleared the session workspace override", "info");
              return;
            }
            context.setWorkspace(operand);
            ctx.ui.notify(`session workspace set to ${operand}`, "info");
            return;
          }

          case "use": {
            if (!operand || operand === "local" || operand === "off" || operand === "host") {
              context.selectSandbox(undefined);
              ctx.ui.notify("bash runs on this host again", "info");
              return;
            }
            const [name, workdir] = operand.split(/\s+/);
            if (!name) throw new ConfigError("usage: /openshell use <sandbox> [workdir]");
            const { client } = await context.gateway(ctx.cwd);
            const workspace = await context.workspace(ctx.cwd);
            const sandbox = await client.sandbox.get(name, workspace ? { workspace } : {});
            if (sandbox.phase !== "ready" && sandbox.phase !== "completed") {
              throw new ConfigError(`sandbox ${name} is ${sandbox.phase}; it must be ready before bash can run inside it`);
            }
            context.selectSandbox({ name: sandbox.name, workspace: sandbox.workspace, workdir: workdir || undefined });
            ctx.ui.notify(
              `bash now runs inside ${sandbox.name} (workspace ${sandbox.workspace}, workdir ${workdir || DEFAULT_SANDBOX_WORKDIR})`,
              "info",
            );
            return;
          }

          case "reload": {
            context.clients.reset();
            ctx.ui.notify("dropped the cached OpenShell connection", "info");
            return;
          }

          default:
            ctx.ui.notify(`unknown argument: ${verb}\n\n${HELP}`, "warning");
        }
      } catch (error) {
        ctx.ui.notify(describeError(error), "error");
      }
    },
  });
}
