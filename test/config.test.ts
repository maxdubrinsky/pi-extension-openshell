import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ConfigError,
  configPath,
  describeConfig,
  expandPath,
  resolveConfig,
  type Env,
} from "../src/config.ts";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-openshell-test-"));
}

function env(overrides: Env = {}): Env {
  return { ...overrides } as Env;
}

test("expandPath expands ~ and resolves relative paths against the config dir", () => {
  assert.equal(expandPath("~/certs/ca.pem", "/tmp"), `${process.env.HOME}/certs/ca.pem`);
  assert.equal(expandPath("certs/ca.pem", "/etc/openshell"), "/etc/openshell/certs/ca.pem");
  assert.equal(expandPath("/abs/ca.pem", "/etc"), "/abs/ca.pem");
});

test("configPath honours PI_OPENSHELL_CONFIG and XDG_CONFIG_HOME", () => {
  assert.equal(configPath({ PI_OPENSHELL_CONFIG: "/x/conf.json" }), "/x/conf.json");
  assert.equal(configPath({ XDG_CONFIG_HOME: "/x" }), "/x/pi-openshell/config.json");
  assert.equal(configPath({ PI_OPENSHELL_CONFIG: "rel.json" }, "/work"), "/work/rel.json");
});

test("gateway comes from the environment when no config file exists", async () => {
  const dir = await tempDir();
  const config = await resolveConfig({
    env: env({ OPENSHELL_GATEWAY: "https://gw.example.com", XDG_CONFIG_HOME: dir }),
    cwd: dir,
  });
  assert.equal(config.gateway, "https://gw.example.com");
  assert.match(config.gatewaySource, /environment/);
  assert.equal(config.workspace, undefined);
});

test("config file supplies the gateway, workspace, and relative cert paths", async () => {
  const dir = await tempDir();
  const configDir = join(dir, "pi-openshell");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "ca.pem"), "CA-PEM");
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({ gateway: "https://gw.example.com", workspace: "team", caCert: "ca.pem" }),
  );
  const config = await resolveConfig({ env: env({ XDG_CONFIG_HOME: dir }), cwd: dir });
  assert.equal(config.gateway, "https://gw.example.com");
  assert.equal(config.workspace, "team");
  assert.equal(config.caCert?.toString(), "CA-PEM");
  assert.match(config.gatewaySource, /config file/);
});

test("session overrides win over the environment", async () => {
  const dir = await tempDir();
  const config = await resolveConfig({
    env: env({ OPENSHELL_GATEWAY: "https://env.example.com", OPENSHELL_WORKSPACE: "env-ws", XDG_CONFIG_HOME: dir }),
    cwd: dir,
    overrides: { gateway: "https://session.example.com", workspace: "session-ws" },
  });
  assert.equal(config.gateway, "https://session.example.com");
  assert.equal(config.workspace, "session-ws");
  assert.match(config.gatewaySource, /session/);
});

test("a missing gateway is a config error that names the ways to set one", async () => {
  const dir = await tempDir();
  await assert.rejects(
    () => resolveConfig({ env: env({ XDG_CONFIG_HOME: dir }), cwd: dir }),
    (error: unknown) => error instanceof ConfigError && /OPENSHELL_GATEWAY/.test(error.message) && /openshell gateway/.test(error.message),
  );
});

test("non-http gateways are rejected", async () => {
  const dir = await tempDir();
  await assert.rejects(
    () => resolveConfig({ env: env({ OPENSHELL_GATEWAY: "ftp://gw.example.com", XDG_CONFIG_HOME: dir }), cwd: dir }),
    /must use http/,
  );
  await assert.rejects(
    () => resolveConfig({ env: env({ OPENSHELL_GATEWAY: "gateway.example.com", XDG_CONFIG_HOME: dir }), cwd: dir }),
    /not a URL/,
  );
});

test("tokens are read from a file so multi-line values stay out of the config", async () => {
  const dir = await tempDir();
  await writeFile(join(dir, "token"), "header.payload.signature\n");
  const config = await resolveConfig({
    env: env({ OPENSHELL_GATEWAY: "https://gw", OPENSHELL_TOKEN_FILE: join(dir, "token"), XDG_CONFIG_HOME: dir }),
    cwd: dir,
  });
  assert.equal(config.oidcToken, "header.payload.signature");
  assert.doesNotMatch(describeConfig(config), /header\.payload/);
});

test("OIDC and edge tokens are mutually exclusive", async () => {
  const dir = await tempDir();
  await assert.rejects(
    () =>
      resolveConfig({
        env: env({
          OPENSHELL_GATEWAY: "https://gw",
          OPENSHELL_TOKEN: "a",
          OPENSHELL_EDGE_TOKEN: "b",
          XDG_CONFIG_HOME: dir,
        }),
        cwd: dir,
      }),
    /mutually exclusive/,
  );
});

test("client certificate and key must be configured together", async () => {
  const dir = await tempDir();
  await writeFile(join(dir, "client.pem"), "CERT");
  await assert.rejects(
    () =>
      resolveConfig({
        env: env({ OPENSHELL_GATEWAY: "https://gw", OPENSHELL_CLIENT_CERT: join(dir, "client.pem"), XDG_CONFIG_HOME: dir }),
        cwd: dir,
      }),
    /together/,
  );
});

test("boolean settings accept env spellings and reject nonsense", async () => {
  const dir = await tempDir();
  const config = await resolveConfig({
    env: env({ OPENSHELL_GATEWAY: "https://gw", OPENSHELL_INSECURE_SKIP_VERIFY: "yes", XDG_CONFIG_HOME: dir }),
    cwd: dir,
  });
  assert.equal(config.insecureSkipVerify, true);
  await assert.rejects(
    () =>
      resolveConfig({
        env: env({ OPENSHELL_GATEWAY: "https://gw", OPENSHELL_ALLOW_INSECURE_AUTH: "maybe", XDG_CONFIG_HOME: dir }),
        cwd: dir,
      }),
    /must be a boolean/,
  );
});

test("a missing secret file names the file", async () => {
  const dir = await tempDir();
  await assert.rejects(
    () =>
      resolveConfig({
        env: env({ OPENSHELL_GATEWAY: "https://gw", OPENSHELL_TOKEN_FILE: join(dir, "nope"), XDG_CONFIG_HOME: dir }),
        cwd: dir,
      }),
    /OIDC token file not found/,
  );
});
