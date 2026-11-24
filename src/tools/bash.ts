/**
 * Built-in bash, routed into an OpenShell sandbox when one is selected.
 *
 * The override keeps pi's own bash tool engine (streaming, truncation, renderer)
 * and swaps only the execution backend, so the same tool the agent already knows
 * runs inside the gateway's isolation instead of on the host. With no sandbox
 * selected the tool delegates to local shell execution, which keeps ordinary
 * sessions behaving exactly as before.
 */

import type { BashOperations, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, createLocalBashOperations } from "@earendil-works/pi-coding-agent";

import { describeError } from "../client.ts";
import { workspaceScope, type Context } from "../context.ts";

export const DEFAULT_SANDBOX_WORKDIR = "/sandbox";

export function registerSandboxBashTool(pi: ExtensionAPI, context: Context): void {
  const local = createLocalBashOperations();

  const operations: BashOperations = {
    async exec(command, cwd, options) {
      const selection = context.selection;
      if (!selection) return local.exec(command, cwd, options);
      if (options.signal?.aborted) throw new Error("cancelled");

      try {
        const { client } = await context.gateway(process.cwd());
        const timeoutSecs = options.timeout ? Math.max(1, Math.ceil(options.timeout / 1000)) : undefined;
        let exitCode: number | null = null;
        for await (const event of client.sandbox.execStream(selection.name, ["/bin/sh", "-lc", command], {
          ...workspaceScope(selection.workspace),
          workdir: selection.workdir ?? DEFAULT_SANDBOX_WORKDIR,
          timeoutSecs,
          signal: options.signal,
          // The command already runs through a login shell; do not source the
          // sandbox profile a second time around it.
          noLoginShell: true,
        })) {
          if ("type" in event) {
            exitCode = event.exitCode;
            continue;
          }
          options.onData(event.data);
        }
        return { exitCode };
      } catch (error) {
        throw new Error(describeError(error));
      }
    },
  };

  const definition = createBashToolDefinition(process.cwd(), { operations });
  pi.registerTool({
    ...definition,
    description:
      "Execute a shell command. In an OpenShell session (after /openshell use <sandbox>) commands run inside the selected sandbox, under its network and filesystem policy; otherwise they run locally on the host.",
  });
}
