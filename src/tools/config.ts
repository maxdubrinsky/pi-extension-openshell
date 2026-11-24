/** Policy, provider attachment, and workload template tools. */

import type { SandboxWorkloadTemplate } from "@ai-openshell/sdk";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { describeError } from "../client.ts";
import { workspaceScope, type Context } from "../context.ts";
import { formatLabels, table, truncateMiddle } from "../format.ts";
import { asPolicyShape, inheritStaticFields, loadPolicyFile, waitForActivePolicy, type PolicyInit } from "../policy.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function templateName(template: SandboxWorkloadTemplate): string {
  return template.metadata?.name ?? "(unnamed)";
}

export function registerConfigTools(pi: ExtensionAPI, context: Context): void {
  pi.registerTool({
    name: "openshell_policy",
    label: "OpenShell policy",
    description:
      "Read a sandbox's effective policy and settings, or apply a policy update from a file. Static fields (filesystem, landlock, process) cannot change on a live sandbox; when the file omits them they are inherited from the live policy, so a file may carry only networkPolicies.",
    promptSnippet: "Read or update a sandbox policy",
    promptGuidelines: [
      "Use openshell_policy get before changing network access, and openshell_policy set only for networkPolicies changes; static fields need a new sandbox.",
    ],
    parameters: Type.Object({
      action: StringEnum(["get", "set"] as const),
      sandbox: Type.String({ description: "Sandbox name." }),
      workspace: Type.Optional(Type.String()),
      policy_file: Type.Optional(Type.String({ description: "Policy file to apply (YAML or JSON). set only." })),
      wait: Type.Optional(Type.Boolean({ description: "Wait until the gateway reports the applied policy hash (default true)." })),
      max_chars: Type.Optional(Type.Integer({ minimum: 500, maximum: 200000, description: "Cap for returned policy JSON (default 8000)." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const { client } = await context.gateway(ctx.cwd);
        const workspace = await context.workspace(ctx.cwd, params.workspace);

        if (params.action === "set") {
          if (!params.policy_file) throw new Error("policy_file is required for set");
          const update = await loadPolicyFile(params.policy_file, ctx.cwd);
          // Static policy fields must match the create-time policy, so inherit any
          // field the file omits instead of sending a policy that would remove them.
          const current = await client.sandbox.getConfig(params.sandbox, workspaceScope(workspace));
          const policy = inheritStaticFields(asPolicyShape(current.policy), update);
          const result = await client.sandbox.setPolicy(params.sandbox, policy as PolicyInit, {
            ...workspaceScope(workspace),
            wait: params.wait ?? true,
          });
          const ref = await client.sandbox.get(params.sandbox, workspaceScope(workspace));
          const active = await waitForActivePolicy(client, params.sandbox, ref.workspace, result.version);
          return {
            content: [
              {
                type: "text" as const,
                text: `policy applied to ${params.sandbox}: version ${result.version} (supervisor active at ${active}), hash ${result.policyHash}, settings revision ${result.settingsRevision}`,
              },
            ],
            details: { action: "set" as const, version: result.version, policyHash: result.policyHash },
          };
        }

        const config = await client.sandbox.getConfig(params.sandbox, workspaceScope(workspace));
        const policyText = truncateMiddle(JSON.stringify(config.policy ?? {}, null, 2), params.max_chars ?? 8000);
        const settingLines = Object.entries(config.settings)
          .map(([key, view]) => `  ${key} = ${JSON.stringify(view.value?.value ?? null)} (${view.scope})`)
          .join("\n");
        const lines = [
          `sandbox: ${params.sandbox}`,
          `policy version: ${config.version} (source: ${config.policySource}, global v${config.globalPolicyVersion})`,
          `policy hash: ${config.policyHash}`,
          `config revision: ${config.configRevision}`,
          "policy:",
          policyText.text,
        ];
        if (params.action === "get" && settingLines) lines.push("settings:", settingLines);
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            action: "get" as const,
            version: config.version,
            policyHash: config.policyHash,
            policySource: config.policySource,
            settingCount: Object.keys(config.settings).length,
          },
        };
      } catch (error) {
        throw new Error(describeError(error));
      }
    },
  });

  pi.registerTool({
    name: "openshell_providers",
    label: "OpenShell providers",
    description: "List the providers attached to a sandbox, or attach and detach one by name.",
    promptSnippet: "List, attach, or detach sandbox providers",
    parameters: Type.Object({
      action: StringEnum(["list", "attach", "detach"] as const),
      sandbox: Type.String({ description: "Sandbox name." }),
      provider: Type.Optional(Type.String({ description: "Provider name, required for attach and detach." })),
      workspace: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const { client } = await context.gateway(ctx.cwd);
        const workspace = await context.workspace(ctx.cwd, params.workspace);

        if (params.action === "list") {
          const providers = await client.sandbox.listAllProviders(params.sandbox, { ...workspaceScope(workspace) });
          const rows = providers.map((provider) => [provider.name, provider.type, formatLabels(provider.labels)]);
          return {
            content: [
              {
                type: "text" as const,
                text: providers.length === 0
                  ? `${params.sandbox} has no attached providers`
                  : `${params.sandbox}: ${providers.length} provider(s)\n\n${table(["name", "type", "labels"], rows)}`,
              },
            ],
            details: { action: "list" as const, providers: providers.map((provider) => provider.name) },
          };
        }

        if (!params.provider) throw new Error(`provider is required for ${params.action}`);
        const change =
          params.action === "attach"
            ? await client.sandbox.attachProvider(params.sandbox, params.provider, workspaceScope(workspace))
            : await client.sandbox.detachProvider(params.sandbox, params.provider, workspaceScope(workspace));
        return {
          content: [
            {
              type: "text" as const,
              text: change.changed
                ? `${params.action}ed ${params.provider} ${params.action === "attach" ? "to" : "from"} ${params.sandbox}`
                : `${params.provider} was already ${params.action === "attach" ? "attached" : "detached"} on ${params.sandbox}`,
            },
          ],
          details: { action: params.action, provider: params.provider, changed: change.changed },
        };
      } catch (error) {
        throw new Error(describeError(error));
      }
    },
  });

  pi.registerTool({
    name: "openshell_templates",
    label: "OpenShell templates",
    description: "List, create, or delete reusable sandbox workload templates.",
    promptSnippet: "Manage sandbox workload templates",
    promptGuidelines: [
      "Use openshell_templates when several sandboxes should share one image, environment, and resource shape, then create sandboxes with openshell_create template=...",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "create", "delete"] as const),
      name: Type.Optional(Type.String({ description: "Template name (create and delete)." })),
      workspace: Type.Optional(Type.String()),
      image: Type.Optional(Type.String({ description: "Workload image (create)." })),
      environment: Type.Optional(Type.Record(Type.String(), Type.String())),
      labels: Type.Optional(Type.Record(Type.String(), Type.String())),
      cpu: Type.Optional(Type.String({ description: "CPU quantity such as 500m or 2 (create)." })),
      memory: Type.Optional(Type.String({ description: "Memory quantity such as 512Mi or 2Gi (create)." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const { client } = await context.gateway(ctx.cwd);
        const workspace = await context.workspace(ctx.cwd, params.workspace);

        if (params.action === "list") {
          const templates = await client.sandboxTemplates.listAll({ ...workspaceScope(workspace) });
          const rows = templates.map((template) => [
            templateName(template),
            template.spec?.workload?.image ?? "",
            formatLabels(template.metadata?.labels),
          ]);
          return {
            content: [
              {
                type: "text" as const,
                text: templates.length === 0
                  ? "no templates in this workspace"
                  : `${templates.length} template(s)\n\n${table(["name", "image", "labels"], rows)}`,
              },
            ],
            details: { action: "list" as const, templates: templates.map(templateName) },
          };
        }

        if (!params.name) throw new Error(`name is required for ${params.action}`);
        if (params.action === "delete") {
          await client.sandboxTemplates.delete(params.name, workspaceScope(workspace));
          return {
            content: [{ type: "text" as const, text: `deleted template ${params.name}` }],
            details: { action: "delete" as const, name: params.name },
          };
        }

        if (!params.image) throw new Error("image is required to create a template");
        const template = await client.sandboxTemplates.create(
          {
            metadata: { name: params.name, labels: params.labels },
            spec: {
              workload: {
                image: params.image,
                environment: params.environment,
                resources:
                  params.cpu || params.memory
                    ? { cpu: params.cpu ?? "1", memory: params.memory ?? "1Gi" }
                    : undefined,
              },
            },
          },
          workspaceScope(workspace),
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `created template ${templateName(template)} (image ${template.spec?.workload?.image ?? params.image})`,
            },
          ],
          details: { action: "create" as const, name: templateName(template) },
        };
      } catch (error) {
        throw new Error(describeError(error));
      }
    },
  });
}
