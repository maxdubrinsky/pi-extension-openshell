import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ACCESS_PRESETS,
  ENFORCEMENT_MODES,
  describeNetworkRules,
  emptyPolicy,
  inheritStaticFields,
  withEndpoint,
  withoutEndpoint,
  type PolicyShape,
} from "../src/policy.ts";

const livePolicy: PolicyShape = {
  version: 4,
  filesystem: { readOnly: ["/etc"] },
  landlock: { enabled: true },
  networkPolicies: {
    existing: {
      name: "existing",
      endpoints: [{ host: "pypi.org", port: 443, protocol: "rest", access: 1, enforcement: 1, tls: 0 }],
      binaries: [{ path: "/usr/bin/pip" }],
    },
  },
};

test("inheritStaticFields keeps static fields the update omits", () => {
  const merged = inheritStaticFields(livePolicy, { networkPolicies: {} });
  assert.deepEqual(merged.filesystem, livePolicy.filesystem);
  assert.deepEqual(merged.landlock, livePolicy.landlock);
  assert.equal(merged.version, 4);
});

test("inheritStaticFields lets the update win where it sets a field", () => {
  const merged = inheritStaticFields(livePolicy, { version: 9, networkPolicies: {} });
  assert.equal(merged.version, 9);
});

test("withEndpoint adds a rule with the requested preset and binaries", () => {
  const policy = withEndpoint(emptyPolicy(), "github", { host: "api.github.com", port: 443 }, ["/usr/bin/curl"]);
  const rule = policy.networkPolicies!.github!;
  assert.equal(rule.name, "github");
  assert.equal(rule.endpoints.length, 1);
  const endpoint = rule.endpoints[0] as { host: string; port: number; protocol: string; access: number; enforcement: number };
  assert.equal(endpoint.host, "api.github.com");
  assert.equal(endpoint.port, 443);
  assert.equal(endpoint.protocol, "rest");
  assert.equal(endpoint.access, ACCESS_PRESETS["read-only"]);
  assert.equal(endpoint.enforcement, ENFORCEMENT_MODES.enforce);
  assert.deepEqual(rule.binaries, [{ path: "/usr/bin/curl" }]);
});

test("withEndpoint replaces a matching host:port instead of duplicating it", () => {
  const once = withEndpoint(emptyPolicy(), "github", { host: "api.github.com" }, ["/usr/bin/curl"]);
  const twice = withEndpoint(once, "github", { host: "api.github.com", access: "read-write" }, ["/usr/bin/curl"]);
  const endpoints = twice.networkPolicies!.github!.endpoints as Array<{ access: number }>;
  assert.equal(endpoints.length, 1);
  assert.equal(endpoints[0]!.access, ACCESS_PRESETS["read-write"]);
});

test("withEndpoint leaves other rules alone", () => {
  const policy = withEndpoint(livePolicy, "github", { host: "api.github.com" }, ["/usr/bin/curl"]);
  assert.ok(policy.networkPolicies!.existing);
  assert.equal(policy.networkPolicies!.existing!.binaries[0]!.path, "/usr/bin/pip");
});

test("withoutEndpoint removes one endpoint, or the whole rule when no host is given", () => {
  const policy = withEndpoint(livePolicy, "github", { host: "api.github.com" }, ["/usr/bin/curl"]);
  const oneRemoved = withoutEndpoint(policy, "github", "api.github.com", 443);
  assert.equal((oneRemoved.networkPolicies!.github!.endpoints as unknown[]).length, 0);

  const ruleRemoved = withoutEndpoint(policy, "github", undefined, 0);
  assert.equal(ruleRemoved.networkPolicies!.github, undefined);
  assert.throws(() => withoutEndpoint(policy, "missing", undefined, 0), /no network rule named missing/);
});

test("describeNetworkRules flattens endpoints and names the presets", () => {
  const rows = describeNetworkRules(livePolicy);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    rule: "existing",
    endpoint: "pypi.org:443",
    protocol: "rest",
    access: "read-only",
    enforcement: "enforce",
    binaries: ["/usr/bin/pip"],
  });
  assert.deepEqual(describeNetworkRules(undefined), []);
  assert.deepEqual(
    describeNetworkRules({ version: 1, networkPolicies: { empty: { name: "empty", endpoints: [], binaries: [] } } })[0]!.endpoint,
    "(no endpoints)",
  );
});
