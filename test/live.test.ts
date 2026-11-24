/**
 * Live test against a real OpenShell gateway.
 *
 * Skipped unless OPENSHELL_TEST_GATEWAY is set, because it creates and deletes a
 * sandbox. Point it at a throwaway gateway, for example:
 *
 *   OPENSHELL_TEST_GATEWAY=http://127.0.0.1:28080 \
 *   OPENSHELL_TEST_IMAGE=alpine:3.20 \
 *   node --test test/live.test.ts
 */

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import openshellExtension from "../src/index.ts";

const gateway = process.env.OPENSHELL_TEST_GATEWAY;
const image = process.env.OPENSHELL_TEST_IMAGE ?? "alpine:3.20";

interface ToolDefinition {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown; isError?: boolean }>;
}

interface Harness {
  tools: Map<string, ToolDefinition>;
  commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
}

function buildHarness(): Harness {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const api = {
    registerTool: (definition: ToolDefinition) => tools.set(definition.name, definition),
    registerCommand: (name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
      commands.set(name, definition),
    on: () => () => {},
  };
  openshellExtension(api as unknown as ExtensionAPI);
  return { tools, commands };
}

const notifications: string[] = [];
const ctx = {
  cwd: process.cwd(),
  ui: {
    notify: (message: string) => notifications.push(message),
    confirm: async () => true,
  },
};

function text(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((item) => item.text).join("\n");
}

test("openshell tools drive a real gateway", { skip: !gateway, timeout: 600_000 }, async () => {
  process.env.OPENSHELL_GATEWAY = gateway;
  delete process.env.PI_OPENSHELL_GATEWAY;
  const { tools, commands } = buildHarness();
  const call = (name: string, params: Record<string, unknown> = {}) => {
    const tool = tools.get(name);
    assert.ok(tool, `${name} is registered`);
    return tool.execute("t", params, undefined, undefined, ctx);
  };

  const status = await call("openshell_status");
  assert.match(text(status), /health: healthy/);

  // Remove leftovers from an interrupted run so the count assertions are exact.
  const stale = await call("openshell_list", { label_selector: "app=pi-extension-openshell" });
  for (const sandbox of (stale.details as { sandboxes: Array<{ name: string }> }).sandboxes) {
    await call("openshell_delete", { sandbox: sandbox.name, wait_secs: 120 });
  }

  const name = `pi-ext-t-${Date.now().toString(36).slice(-8)}`;
  const created = await call("openshell_create", {
    name,
    image,
    command: ["/bin/sh", "-c", "sleep 600"],
    labels: { app: "pi-extension-openshell" },
    wait_ready_secs: 300,
  });
  try {
  const createdDetails = created.details as { name: string; phase: string; workspace: string };
  assert.equal(createdDetails.name, name);
  assert.equal(createdDetails.phase, "ready");

  const listed = await call("openshell_list", { label_selector: "app=pi-extension-openshell", show_labels: true });
  assert.equal((listed.details as { count: number }).count, 1);
  assert.match(text(listed), new RegExp(name));

  const executed = await call("openshell_exec", { sandbox: name, command: "echo ext-ok; uname -m" });
  assert.match(text(executed), /exit code: 0/);
  assert.match(text(executed), /ext-ok/);

  const failed = await call("openshell_exec", { sandbox: name, command: "sh -c 'exit 7'" });
  assert.equal(failed.isError, true);
  assert.match(text(failed), /exit code: 7/);

  const argv = await call("openshell_exec", { sandbox: name, command: ["echo", "argv-ok"] });
  assert.match(text(argv), /argv-ok/);

  const logs = await call("openshell_logs", { sandbox: name, tail_lines: 5, include_events: false, timeout_secs: 5 });
  assert.ok(text(logs).length > 0);

  const policy = await call("openshell_policy", { action: "get", sandbox: name });
  assert.match(text(policy), /policy version:/);

  const policyDir = await mkdtemp(join(tmpdir(), "pi-openshell-policy-"));
  const policyFile = join(policyDir, "policy.yaml");
  await writeFile(policyFile, "version: 1\nnetworkPolicies: {}\n");
  const applied = await call("openshell_policy", { action: "set", sandbox: name, policy_file: policyFile });
  assert.match(text(applied), /policy applied/);

  const providers = await call("openshell_providers", { action: "list", sandbox: name });
  assert.match(text(providers), /no attached providers|provider\(s\)/);

  const templates = await call("openshell_templates", { action: "list" });
  assert.ok(Array.isArray((templates.details as { templates: string[] }).templates));
  const templateName = `tpl-${Date.now().toString(36).slice(-8)}`;
  const template = await call("openshell_templates", { action: "create", name: templateName, image });
  assert.match(text(template), new RegExp(templateName));
  await call("openshell_templates", { action: "delete", name: templateName });

  const stopped = await call("openshell_lifecycle", { sandbox: name, action: "stop" });
  assert.ok((stopped.details as { phase: string }).phase.length > 0);
  const started = await call("openshell_lifecycle", { sandbox: name, action: "start" });
  assert.ok((started.details as { phase: string }).phase.length > 0);

  const deleted = await call("openshell_delete", { sandbox: name, wait_secs: 180 });
  assert.equal((deleted.details as { settled: boolean }).settled, true);
  } finally {
    await call("openshell_delete", { sandbox: name, allow_missing: true, wait_secs: 120 }).catch(() => {});
  }

  const after = await call("openshell_list", { label_selector: "app=pi-extension-openshell" });
  assert.equal((after.details as { count: number }).count, 0);

  await commands.get("openshell")!.handler("config", ctx);
  assert.match(notifications.at(-1) ?? "", /gateway: http/);
});
