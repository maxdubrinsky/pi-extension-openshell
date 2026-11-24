/** Sandbox policy helpers shared by the policy and egress tools. */

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { OpenShellClient } from "@ai-openshell/sdk";
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { SandboxPolicySchema } from "@ai-openshell/sdk/raw";
import { parse as parseYaml } from "yaml";

/** The shape SandboxClient.setPolicy accepts. */
export type PolicyInit = MessageInitShape<typeof SandboxPolicySchema>;

/** NetworkAccessPreset: the request surface an endpoint rule permits. */
export const ACCESS_PRESETS = {
  none: 0,
  "read-only": 1,
  "read-write": 2,
  full: 3,
} as const;

/** NetworkEnforcementMode: enforce denies, audit logs and allows. */
export const ENFORCEMENT_MODES = {
  none: 0,
  enforce: 1,
  audit: 2,
} as const;

export type AccessPreset = keyof typeof ACCESS_PRESETS;
export type EnforcementMode = keyof typeof ENFORCEMENT_MODES;

export interface EndpointInput {
  host: string;
  port?: number;
  /** Request-level protocol such as `rest`; omit for an opaque connection rule. */
  protocol?: string;
  access?: AccessPreset;
  enforcement?: EnforcementMode;
}

export interface EndpointShape {
  host: string;
  port: number;
  /** Policy DNS reads `ports`; an empty array or a missing entry hides the endpoint from name resolution. */
  ports: number[];
  protocol: string;
  access: number;
  enforcement: number;
  tls: number;
}

export interface RuleShape {
  name?: string;
  endpoints: Array<EndpointShape | Record<string, unknown>>;
  binaries: Array<{ path: string }>;
  [key: string]: unknown;
}

/** Plain, proto-shaped policy object that the SDK accepts as a message init. */
export interface PolicyShape {
  version?: number;
  networkPolicies?: Record<string, RuleShape>;
  [key: string]: unknown;
}

export interface NetworkRuleView {
  rule: string;
  endpoint: string;
  protocol: string;
  access: string;
  enforcement: string;
  binaries: string[];
}

export function emptyPolicy(): PolicyShape {
  return { version: 1, networkPolicies: {} };
}

/** Read the live policy of a sandbox as a plain object. */
export function asPolicyShape(policy: unknown): PolicyShape | undefined {
  return policy ? (policy as PolicyShape) : undefined;
}

export async function loadPolicyFile(path: string, cwd: string): Promise<PolicyShape> {
  const full = isAbsolute(path) ? path : resolve(cwd, path);
  const text = await readFile(full, "utf8");
  const parsed: unknown = parseYaml(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`policy file ${full}: expected a policy object at the top level`);
  }
  return parsed as PolicyShape;
}

/**
 * Convert generated message instances into plain objects.
 *
 * `setPolicy` hands the policy to the Connect serializer, which cannot mix
 * message instances (returned by `getConfig`) with plain init objects in nested
 * maps. Normalizing the whole policy to plain objects avoids that.
 */
export function toPlain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toPlain);
  if (value instanceof Uint8Array) return value;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "$typeName" || key === "$unknown") continue;
      out[key] = toPlain(item);
    }
    return out;
  }
  return value;
}

/**
 * Sandbox-scoped policy updates may change network policy only: the gateway
 * rejects a policy that drops filesystem, landlock, or process fields. Inherit
 * every static field the update omits from the live policy.
 */
export function inheritStaticFields(live: PolicyShape | undefined, update: PolicyShape): PolicyShape {
  const merged: PolicyShape = {
    ...live,
    ...update,
    version: update.version || live?.version || 1,
    networkPolicies: update.networkPolicies ?? live?.networkPolicies ?? {},
    networkMiddlewares: update.networkMiddlewares ?? live?.networkMiddlewares ?? {},
  };
  return toPlain(merged) as PolicyShape;
}

function presetName(table: Record<string, number>, value: number | undefined): string {
  return Object.entries(table).find(([, code]) => code === value)?.[0] ?? "unnamed";
}

/** Flatten a policy's network rules into one row per endpoint for display. */
export function describeNetworkRules(policy: PolicyShape | undefined): NetworkRuleView[] {
  if (!policy?.networkPolicies) return [];
  const rows: NetworkRuleView[] = [];
  for (const [ruleName, rule] of Object.entries(policy.networkPolicies)) {
    const binaries = (rule.binaries ?? []).map((binary) => binary.path);
    const endpoints = (rule.endpoints ?? []) as EndpointShape[];
    if (endpoints.length === 0) {
      rows.push({ rule: ruleName, endpoint: "(no endpoints)", protocol: "", access: "", enforcement: "", binaries });
      continue;
    }
    for (const endpoint of endpoints) {
      rows.push({
        rule: ruleName,
        endpoint: `${endpoint.host}:${endpoint.port || "any"}`,
        protocol: endpoint.protocol ?? "",
        access: presetName(ACCESS_PRESETS, endpoint.access),
        enforcement: presetName(ENFORCEMENT_MODES, endpoint.enforcement),
        binaries,
      });
    }
  }
  return rows;
}

/** Add or replace one endpoint inside a named network rule, keeping other rules intact. */
export function withEndpoint(
  policy: PolicyShape,
  ruleName: string,
  endpoint: EndpointInput,
  binaries: string[],
): PolicyShape {
  const rules = { ...(policy.networkPolicies ?? {}) };
  const existing = rules[ruleName];
  const port = endpoint.port ?? 443;
  const next: EndpointShape = {
    host: endpoint.host,
    port,
    ports: [port],
    protocol: endpoint.protocol ?? "rest",
    access: ACCESS_PRESETS[endpoint.access ?? "read-only"],
    enforcement: ENFORCEMENT_MODES[endpoint.enforcement ?? "enforce"],
    tls: 0,
  };
  const endpoints = (existing?.endpoints ?? []).filter((item) => {
    const candidate = item as Partial<EndpointShape>;
    return !(candidate.host === endpoint.host && candidate.port === port);
  });
  rules[ruleName] = {
    ...existing,
    name: ruleName,
    endpoints: [...endpoints, next],
    binaries: binaries.map((path) => ({ path })),
  };
  return { ...policy, networkPolicies: rules };
}

/** Remove one endpoint from a rule, or the whole rule when no host is given. */
export function withoutEndpoint(policy: PolicyShape, ruleName: string, host: string | undefined, port: number): PolicyShape {
  const rules = { ...(policy.networkPolicies ?? {}) };
  const existing = rules[ruleName];
  if (!existing) throw new Error(`no network rule named ${ruleName}`);
  if (!host) {
    delete rules[ruleName];
    return { ...policy, networkPolicies: rules };
  }
  const endpoints = (existing.endpoints ?? []).filter((item) => {
    const candidate = item as Partial<EndpointShape>;
    return !(candidate.host === host && candidate.port === port);
  });
  rules[ruleName] = { ...existing, endpoints };
  return { ...policy, networkPolicies: rules };
}

/**
 * Wait until the sandbox supervisor reports the revision it is actively
 * enforcing. `setPolicy(wait: true)` only waits for the gateway to persist and
 * echo the new hash; the supervisor polls for it, so an immediate exec can still
 * run under the previous policy.
 */
export async function waitForActivePolicy(
  client: OpenShellClient,
  sandbox: string,
  workspace: string | undefined,
  version: number,
  timeoutSecs = 30,
): Promise<number> {
  const deadline = Date.now() + timeoutSecs * 1000;
  let active = 0;
  for (;;) {
    const status = await client.raw.getSandboxPolicyStatus({
      sandbox,
      version,
      global: false,
      workspaceScope: workspace
        ? { selection: { case: "workspace", value: workspace } }
        : { selection: { case: undefined } },
    });
    active = status.activeVersion;
    if (active >= version) return active;
    if (Date.now() >= deadline) return active;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}
