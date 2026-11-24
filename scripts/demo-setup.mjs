import { OpenShellClient } from "@ai-openshell/sdk";

// Create or delete the sandbox used by scripts/demo-egress.sh.
const gateway = process.env.OPENSHELL_GATEWAY ?? "http://127.0.0.1:28080";
const name = process.env.DEMO_SANDBOX ?? "demo-egress";
const image = process.env.DEMO_IMAGE ?? "alpine:3.20";
const remove = process.argv.includes("--delete");

const client = await OpenShellClient.connect({ gateway });

if (remove) {
  const deletion = await client.sandbox.delete(name, { allowMissing: true });
  if (deletion.outcome === "accepted") {
    await client.sandbox.waitDeleted(name, 120, { expectedSandboxId: deletion.sandboxId }).catch(() => {});
  }
  console.log(`deleted ${name} (${deletion.outcome})`);
} else {
  await client.sandbox.delete(name, { allowMissing: true }).catch(() => {});
  const sandbox = await client.sandbox.create({
    name,
    image,
    command: ["/bin/sh", "-c", "sleep 1800"],
  });
  const ready = await client.sandbox.waitReady(name, 180);
  const config = await client.sandbox.getConfig(name);
  const rules = Object.keys(config.policy?.networkPolicies ?? {}).length;
  console.log(`sandbox ${ready.name} ${ready.phase} (id ${sandbox.id}), policy version ${config.version}, ${rules} network rules`);
}
