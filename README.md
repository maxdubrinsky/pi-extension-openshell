# pi-extension-openshell

Manage [NVIDIA OpenShell](https://github.com/ai-openshell/openshell) sandboxes from the [pi coding agent](https://pi.dev), through the official TypeScript SDK (`@ai-openshell/sdk`) instead of the `openshell` CLI.

The agent gets typed tools for the sandbox lifecycle, exec, logs, policy, providers, templates, and port forwards. Nothing shells out, so there is no argv quoting, no CLI JSON parsing, and gateway errors arrive with their structured reasons, field violations, and retry hints.

## Install

```bash
pi install npm:pi-extension-openshell
```

Or try a checkout for one run:

```bash
pi -e ./src/index.ts
```

The package declares `@ai-openshell/sdk` and `yaml` as runtime dependencies; pi installs them. Nothing else is needed, and the `openshell` CLI is not required.

## Configure

Resolution order, highest first: session overrides (`/openshell gateway`, `/openshell workspace`), environment, then the config file.

Config file: `${XDG_CONFIG_HOME:-~/.config}/pi-openshell/config.json` (override the path with `PI_OPENSHELL_CONFIG`). Every field is optional; a gateway is required somewhere.

```json
{
  "gateway": "https://gateway.example.com",
  "workspace": "default",
  "caCert": "~/.config/openshell/tls/ca.crt",
  "clientCert": "~/.config/openshell/tls/client/client.crt",
  "clientKey": "~/.config/openshell/tls/client/client.key",
  "insecureSkipVerify": false,
  "allowInsecureAuth": false
}
```

Environment variables:

| Variable | Purpose |
|---|---|
| `OPENSHELL_GATEWAY` | Gateway URL (`http://` or `https://`) |
| `OPENSHELL_WORKSPACE` | Default workspace (omitted means the gateway default) |
| `OPENSHELL_TOKEN` / `OPENSHELL_OIDC_TOKEN` | OIDC bearer token |
| `OPENSHELL_TOKEN_FILE` | Path to a token file (use this for anything multi-line) |
| `OPENSHELL_EDGE_TOKEN` / `OPENSHELL_EDGE_TOKEN_FILE` | Cloudflare Access token, mutually exclusive with OIDC |
| `OPENSHELL_CA_CERT`, `OPENSHELL_CLIENT_CERT`, `OPENSHELL_CLIENT_KEY` | PEM paths for mTLS (cert and key together) |
| `OPENSHELL_INSECURE_SKIP_VERIFY` | `true` disables TLS verification (dev only) |
| `OPENSHELL_ALLOW_INSECURE_AUTH` | Permit sending a token over cleartext `http://` to a non-loopback host |

The default local gateway requires mTLS, so point `clientCert`/`clientKey` at the bundle from `openshell gateway start` (or `openshell-gateway generate-certs`). Tokens are read from files and never printed: `/openshell config` shows only whether a token or certificate is present.

## Tools

| Tool | What it does |
|---|---|
| `openshell_status` | Gateway health and version, sandbox counts by phase |
| `openshell_list` | Sandboxes with phase, age, workspace, template, labels; label selectors and an all-workspaces admin view |
| `openshell_create` | Create from an image or workload template, with labels, environment, providers, GPU, exposed service ports, and a create-time policy file; optionally waits for ready |
| `openshell_exec` | Run a string (via `/bin/sh -lc`) or an exact argv, streamed, with exit code, stdout/stderr, and middle truncation for large output |
| `openshell_logs` | Tail gateway logs and platform events with level and source filters |
| `openshell_lifecycle` | Stop, start, suspend, or resume, reporting the resulting phase |
| `openshell_delete` | Delete with the typed outcome, waiting for cleanup when it is only accepted |
| `openshell_forward` | Start, list, or close loopback TCP forwards into a sandbox (process-lifetime) |
| `openshell_policy` | Read the effective policy, settings, hashes, and source; apply a policy file |
| `openshell_providers` | List, attach, or detach providers on a sandbox |
| `openshell_templates` | List, create, or delete workload templates |

Policy note: static policy fields (filesystem, landlock, process) can only be set at creation. `openshell_policy set` inherits any static field its file omits from the live policy, so a file may carry only `networkPolicies` and still apply.

Exec note: `openshell_exec` is the only way to run work inside the sandbox. Built-in `bash` runs on the host, outside the gateway's isolation.

## Command

```
/openshell                 gateway health and sandbox counts
/openshell config          resolved connection config, secrets redacted
/openshell gateway <url>   use this gateway for the session
/openshell gateway clear   back to the configured gateway
/openshell workspace <n>   default workspace for the session
/openshell workspace clear back to the configured workspace
/openshell reload          drop the cached connection
```

## Development

```bash
npm install
npm run typecheck
npm test                 # unit tests; the live test skips without a gateway

./scripts/dev-gateway.sh up     # throwaway Docker gateway on 127.0.0.1:28080
OPENSHELL_TEST_GATEWAY=http://127.0.0.1:28080 node --test test/live.test.ts
./scripts/dev-gateway.sh down
```

`test/live.test.ts` drives every tool against a real gateway: create, list, exec (string, argv, failing exit code), logs, policy get and set, providers, template create and delete, stop/start, and delete-with-confirmation. The dev gateway runs the published image with TLS disabled and unauthenticated loopback access; it is for testing only.

Sandbox names are limited to 19 characters by the gateway, and image pulls happen on the compute driver, so a first create can be slow.

## Limits

- The SDK ships no file-transfer RPC, so there is no upload/download tool; small payloads go through `openshell_exec`.
- `openshell_forward` binds in this process, so forwards end when pi exits.
- Provider credential export (`client.providers.getCredentials`) is deliberately not exposed: it returns raw secrets and needs operator mTLS.

## License

Apache-2.0.
