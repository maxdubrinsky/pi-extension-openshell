import assert from "node:assert/strict";
import { test } from "node:test";

import { formatAge, formatBytes, formatLabels, table, truncateMiddle } from "../src/format.ts";

test("formatAge compresses durations", () => {
  const now = Date.UTC(2026, 10, 24, 12, 0, 0);
  assert.equal(formatAge(now - 30_000, now), "30s");
  assert.equal(formatAge(now - 5 * 60_000, now), "5m");
  assert.equal(formatAge(now - (3 * 60 + 20) * 60_000, now), "3h20m");
  assert.equal(formatAge(now - (2 * 24 + 4) * 3_600_000, now), "2d4h");
  assert.equal(formatAge(undefined, now), "?");
});

test("table pads columns and keeps rows aligned", () => {
  const text = table(["name", "phase"], [["api", "ready"], ["long-name", "provisioning"]]);
  const lines = text.split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[0]!, /^name {7}phase$/);
  assert.match(lines[1]!, /^-{9,} {2}-+$/);
  assert.match(lines[2]!, /^api {8}ready$/);
});

test("truncateMiddle keeps head and tail and reports what it dropped", () => {
  const input = `${"a".repeat(100)}${"b".repeat(100)}`;
  const result = truncateMiddle(input, 40);
  assert.equal(result.truncated, true);
  assert.equal(result.omitted, 160);
  assert.ok(result.text.startsWith("a"));
  assert.ok(result.text.endsWith("b"));
  assert.match(result.text, /160 characters omitted/);
  assert.deepEqual(truncateMiddle("short", 40), { text: "short", truncated: false, omitted: 0 });
});

test("formatBytes switches units at KiB and MiB", () => {
  assert.equal(formatBytes(512), "512B");
  assert.equal(formatBytes(2048), "2.0KiB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0MiB");
});

test("formatLabels sorts keys for stable output", () => {
  assert.equal(formatLabels({ b: "2", a: "1" }), "a=1,b=2");
  assert.equal(formatLabels({}), "");
  assert.equal(formatLabels(undefined), "");
});
