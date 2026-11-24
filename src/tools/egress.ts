/** Network egress: inspect and change a sandbox's network policy, and read decisions. */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { describeError } from "../client.ts";
import { workspaceScope, type Context } from "../context.ts";
import { formatLabels, table } from "../format.ts";
import {
  asPolicyShape,
  describeNetworkRules,
  emptyPolicy,
  inheritStaticFields,
  withEndpoint,
  withoutEndpoint,
  waitForActivePolicy,
  type AccessPreset,
  type EnforcementMode,
  type PolicyInit,
} from "../policy.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DECISION_PATTERN = /DENIED|ALLOWED|denied|allowed|blocked|network connections not allowed/i;

export function registerEgressTools(pi: ExtensionAPI, context: Context): void {
  pi.registerTool({
    name: "openshell_egress",
    label: "OpenShell egress",
    description:
      "Inspect and manage network egress for a sandbox: list the network policy rules (rule, endpoint, protocol, access, enforcement, binaries), allow or deny an endpoint, and read recent allow/deny decisions from the sandbox log.",
    promptSnippet: "Inspect or change sandbox network egress rules",
    promptGuidelines: [
      "Use openshell_egress list to see what a sandbox may reach, openshell_egress allow to permit a specific host for a specific binary, and openshell_egress denials to confirm what the gateway is blocking.",
      "A network rule with an empty binaries list allows nothing; openshell_egress allow requires binaries when it creates a new rule.",
      "The gateway matches the resolved executable path, so list that path in binaries: distro applet wrappers resolve to their real binary, for example /usr/bin/wget on Alpine is /bin/busybox.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "allow", "deny", "denials"] as const),
      sandbox: Type.String({ description: "Sandbox name." }),
      workspace: Type.Optional(Type.String()),
      rule: Type.Optional(Type.String({ description: "Network rule name (default egress)." })),
      host: Type.Optional(Type.String({ description: "Endpoint host, e.g. api.github.com." })),
      port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535, description: "Endpoint port (default 443)." })),
      protocol: Type.Optional(
        Type.String({ description: "Request protocol: rest inspects HTTP requests, omit for an opaque connection rule (default rest)." }),
      ),
      access: Type.Optional(StringEnum(["read-only", "read-write", "full", "none"] as const)),
      enforcement: Type.Optional(StringEnum(["enforce", "audit", "none"] as const)),
      binaries: Type.Optional(
        Type.Array(Type.String(), { description: "Executable paths allowed to use the rule, e.g. /usr/bin/curl." }),
      ),
      tail_lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Decisions to collect for denials (default 20)." })),
      timeout_secs: Type.Optional(Type.Integer({ minimum: 1, maximum: 60, description: "How long to wait for decisions (default 5s)." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const { client } = await context.gateway(ctx.cwd);
        const workspace = await context.workspace(ctx.cwd, params.workspace);
        const ruleName = params.rule ?? "egress";

        if (params.action === "denials") {
          return await readDecisions(client, params.sandbox, workspace, params.tail_lines ?? 20, params.timeout_secs ?? 5);
        }

        const sandboxRef = await client.sandbox.get(params.sandbox, workspaceScope(workspace));
        const config = await client.sandbox.getConfig(params.sandbox, workspaceScope(workspace));
        const policy = asPolicyShape(config.policy);
        // Supervisor-reported revisions need the sandbox's own workspace named.
        const activeIn = (version: number) => waitForActivePolicy(client, params.sandbox, sandboxRef.workspace, version);

        if (params.action === "list") {
          const rules = describeNetworkRules(policy);
          const rows = rules.map((row) => [
            row.rule,
            row.endpoint,
            row.protocol,
            row.access,
            row.enforcement,
            row.binaries.join(",") || "(none: allows nothing)",
          ]);
          const header = `policy version ${config.version} (source: ${config.policySource}), hash ${config.policyHash.slice(0, 12)}`;
          const body = rules.length === 0 ? `${params.sandbox}: no network rules, all egress denied` : table(["rule", "endpoint", "protocol", "access", "enforcement", "binaries"], rows);
          return {
            content: [{ type: "text" as const, text: `${header}\n\n${body}` }],
            details: { action: "list" as const, sandbox: params.sandbox, rules, policyHash: config.policyHash },
          };
        }

        if (!params.host && params.action === "deny") {
          // No host means drop the whole rule.
          const next = withoutEndpoint(inheritStaticFields(policy, policy ?? emptyPolicy()), ruleName, undefined, 0);
          const result = await client.sandbox.setPolicy(params.sandbox, next as PolicyInit, { ...workspaceScope(workspace), wait: true });
          const active = await activeIn(result.version);
          return {
            content: [
              {
                type: "text" as const,
                text: `removed network rule ${ruleName} from ${params.sandbox} (policy version ${result.version}, supervisor active at ${active})`,
              },
            ],
            details: { action: "deny" as const, sandbox: params.sandbox, rule: ruleName, policyHash: result.policyHash },
          };
        }

        if (!params.host) throw new Error(`host is required for ${params.action}`);

        if (params.action === "allow") {
          const existing = policy?.networkPolicies?.[ruleName];
          const binaries = params.binaries ?? existing?.binaries?.map((binary) => binary.path) ?? [];
          if (binaries.length === 0) {
            throw new Error(
              "this creates a new network rule, and a rule with an empty binaries list allows nothing: pass binaries (for example /usr/bin/curl)",
            );
          }
          const updated = withEndpoint(
            inheritStaticFields(policy, policy ?? emptyPolicy()),
            ruleName,
            {
              host: params.host,
              port: params.port ?? 443,
              protocol: params.protocol ?? "rest",
              access: (params.access ?? "read-only") as AccessPreset,
              enforcement: (params.enforcement ?? "enforce") as EnforcementMode,
            },
            binaries,
          );
          const result = await client.sandbox.setPolicy(params.sandbox, updated as PolicyInit, { ...workspaceScope(workspace), wait: true });
          const active = await activeIn(result.version);
          const text = [
            `allowed ${params.host}:${params.port ?? 443} for ${binaries.join(", ")} on ${params.sandbox}`,
            `rule: ${ruleName}, protocol: ${params.protocol ?? "rest"}, access: ${params.access ?? "read-only"}, enforcement: ${params.enforcement ?? "enforce"}`,
            `policy version ${result.version}, hash ${result.policyHash.slice(0, 12)}, supervisor active at ${active}`,
          ].join("\n");
          return {
            content: [{ type: "text" as const, text }],
            details: { action: "allow" as const, sandbox: params.sandbox, rule: ruleName, host: params.host, policyHash: result.policyHash },
          };
        }

        const updated = withoutEndpoint(
          inheritStaticFields(policy, policy ?? emptyPolicy()),
          ruleName,
          params.host,
          params.port ?? 443,
        );
        const result = await client.sandbox.setPolicy(params.sandbox, updated as PolicyInit, { ...workspaceScope(workspace), wait: true });
        const active = await activeIn(result.version);
        return {
          content: [
            {
              type: "text" as const,
              text: `denied ${params.host}:${params.port ?? 443} on ${params.sandbox} by removing it from rule ${ruleName} (policy version ${result.version}, supervisor active at ${active})`,
            },
          ],
          details: { action: "deny" as const, sandbox: params.sandbox, rule: ruleName, host: params.host, policyHash: result.policyHash },
        };
      } catch (error) {
        throw new Error(describeError(error));
      }
    },
  });
}

async function readDecisions(
  client: Awaited<ReturnType<Context["gateway"]>>["client"],
  sandbox: string,
  workspace: string | undefined,
  limit: number,
  timeoutSecs: number,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: { action: "denials"; sandbox: string; denied: number; allowed: number; scanned: number };
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSecs * 1000);
  const matches: string[] = [];
  let denied = 0;
  let allowed = 0;
  let scanned = 0;
  try {
    for await (const item of client.sandbox.watchLogs(sandbox, {
      ...workspaceScope(workspace),
      followEvents: false,
      logSources: ["sandbox"],
      logTailLines: Math.max(limit * 20, 200),
      signal: controller.signal,
    })) {
      if (item.kind !== "log") continue;
      scanned += 1;
      const line = `${item.line.level} ${item.line.target} ${item.line.message} ${formatLabels(item.line.fields)}`;
      if (!DECISION_PATTERN.test(line)) continue;
      if (/DENIED|denied|blocked/i.test(line)) denied += 1;
      else allowed += 1;
      matches.push(line.trim());
      if (matches.length >= limit) break;
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    clearTimeout(timer);
  }
  const hint = denied > 0 ? "\n\nThe path before the arrow in a DENIED line is the resolved executable to pass as binaries." : "";
  const body =
    matches.length === 0
      ? `no network allow/deny decisions in the last ${timeoutSecs}s (scanned ${scanned} log lines)`
      : `${matches.length} decision(s) of ${scanned} scanned lines (denied ${denied}, allowed ${allowed})\n\n${matches.join("\n")}${hint}`;
  return {
    content: [{ type: "text", text: body }],
    details: { action: "denials", sandbox, denied, allowed, scanned },
  };
}
