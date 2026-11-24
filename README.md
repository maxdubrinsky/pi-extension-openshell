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
| `openshell_exec` | Run a string (via `/bin/sh -lc`) or an exact argv, streamed, with exit code, stdout/stderr, and middle truncation for large output; `background: true` returns a job id instead |
| `openshell_jobs` | Background exec jobs: list, read state and output tail, wait with progress, or stop |
| `openshell_logs` | Tail gateway logs and platform events with level and source filters |
| `openshell_lifecycle` | Stop, start, suspend, or resume, reporting the resulting phase |
| `openshell_delete` | Delete with the typed outcome, waiting for cleanup when it is only accepted |
| `openshell_forward` | Start, list, or close loopback TCP forwards into a sandbox (process-lifetime) |
| `openshell_policy` | Read the effective policy, settings, hashes, and source; apply a policy file |
| `openshell_providers` | List, attach, or detach providers on a sandbox |
| `openshell_templates` | List, create, or delete workload templates |
| `openshell_egress` | Network egress: list rules, allow or deny an endpoint, read recent allow/deny decisions |
| `bash` (overridden) | pi's own bash tool, routed into the selected sandbox; local when nothing is selected |

Policy note: static policy fields (filesystem, landlock, process) can only be set at creation. `openshell_policy set` inherits any static field its file omits from the live policy, so a file may carry only `networkPolicies` and still apply.

## Sandbox the agent's own shell

Selecting a sandbox rewires pi's built-in `bash` to execute inside it. Rendering, truncation, and streaming stay pi's; only the execution backend changes, so the agent keeps one tool and gets the gateway's filesystem and network policy.

```
/openshell use demo-egress        # bash now runs inside the sandbox
/openshell use local              # back to the host shell
```

Headless sessions cannot run slash commands, so set `OPENSHELL_SANDBOX=<name>` (and optionally `OPENSHELL_SANDBOX_WORKDIR`, default `/sandbox`) to start with bash already routed. The override is deliberately conservative: host environment variables are not forwarded into the sandbox.

Note that `!` user-bash and any other tool that spawns a process on the host are not rerouted. Only the `bash` tool is.

## Observe and manage egress

Sandboxes start with default-deny networking. A blocked request surfaces inside the sandbox as a plain connection failure, so the reason has to come from the gateway:

```
openshell_egress { action: "denials", sandbox: "demo-egress" }
  -> DENIED /bin/busybox(134) -> example.com:443 [reason:transparent_tcp_policy_denied]
```

Then grant exactly what is needed, for exactly one binary:

```
openshell_egress { action: "allow", sandbox: "demo-egress", rule: "web",
                   host: "example.com", port: 443, access: "read-only",
                   binaries: ["/bin/busybox"] }
  -> policy version 2, hash 4f79dd738d40, supervisor active at 2
```

The same command then proceeds, with no restart. `action: "deny"` removes the endpoint again, and `action: "list"` shows every rule with its protocol, access preset, enforcement mode, and binaries.

Two things this nails down for you:

- The gateway matches the **resolved executable**. Distro applet wrappers resolve to the real binary, so on Alpine `/usr/bin/wget` must be listed as `/bin/busybox`. The deny line names the path to use.
- Policy changes are pushed and then polled by the supervisor. The tools wait for the revision the supervisor reports as active, so a command run right after `allow` already sees the new rule.

A runnable end-to-end demo lives in `scripts/demo-egress.sh`: it creates a deny-all sandbox, runs an agent whose bash is routed into it, has the agent observe the denial, allow one endpoint, and retry.

Exec note: `openshell_exec` runs commands without changing the bash routing, which is handy for quick checks and for automation that should not depend on session state.

## Run a long task in the background

A foreground exec holds the agent until the command exits. When the point is to watch the work land, start it as a job instead:

```
openshell_exec { sandbox: "writer", command: "python3 draft.py", background: true }
  -> started j1 in writer: /bin/sh -lc python3 draft.py
     stdout log: ~/.local/state/pi-openshell/jobs/20261124T193000123Z-j1-writer.stdout.log
     stderr log: ~/.local/state/pi-openshell/jobs/20261124T193000123Z-j1-writer.stderr.log
```

The call returns immediately, so the agent keeps working. Two things bring it back:

- **On exit**, the session is woken with a custom message holding the exit code, duration, byte counts, and the tail of both streams, plus the log paths. It is delivered as a follow-up, so it lands when the current turn has nothing left to do. Pass `notify: false` to start a job quietly.
- **On demand**, `openshell_jobs { action: "status", id: "j1" }` returns the state and the retained tail of each stream, and `openshell_jobs { action: "wait", id: "j1", timeout_secs: 60 }` blocks for a bounded time while streaming progress. That is how a partial draft gets reviewed mid-run: wait, read the tail, decide, wait again.

Full output is never truncated in a job: stdout and stderr go to separate log files, so pi's own `read` tool can page through them, or diff successive snapshots of a file the command is writing. `action: "stop"` aborts a running job; `action: "list"` shows every job in this process.

Jobs are process-lifetime state, like forwards: `/reload` or a pi restart drops the job list and aborts what was running, while the log files stay on disk. Aborting the tool call that started a job does not stop the job. The wake needs a live session, so it works in the TUI and in RPC mode; a headless `pi -p` run tears its session down as soon as the run settles, and a job that finishes after that keeps writing its logs but has nothing to wake.

## Command

```
/openshell                 gateway health, sandbox counts, bash routing
/openshell use <sandbox>   route built-in bash into that sandbox
/openshell use local       route built-in bash back to this host
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

`test/live.test.ts` drives every tool against a real gateway: create, list, exec (string, argv, failing exit code), bash routing into and out of a sandbox, logs, policy get and set, egress deny/allow/deny with a real fetch across the boundary, providers, template create and delete, stop/start, and delete-with-confirmation. The dev gateway runs the published image with TLS disabled and unauthenticated loopback access; it is for testing only.

```bash
./scripts/dev-gateway.sh up
./scripts/demo-egress.sh                # agent-side egress demo
```

Sandbox names are limited to 19 characters by the gateway, and image pulls happen on the compute driver, so a first create can be slow.

## Limits

- The SDK ships no file-transfer RPC, so there is no upload/download tool; small payloads go through `openshell_exec`.
- `openshell_forward` binds in this process, so forwards end when pi exits.
- Background exec jobs are process-lifetime too: a reload or restart aborts them and forgets the job list, though their log files remain.
- Provider credential export (`client.providers.getCredentials`) is deliberately not exposed: it returns raw secrets and needs operator mTLS.
- Default-deny egress can make sandbox setup look broken: DNS for an unlisted host is refused before any TCP attempt, which is the deny you want to see, not an error.
- Large exec stdout can come back with exit code 74 and `exec output could not be delivered intact` from the supervisor even when the command succeeded; treat output as authoritative and the code as unreliable in that case.

## License

Apache-2.0.
