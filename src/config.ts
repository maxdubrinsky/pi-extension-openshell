/**
 * Configuration for the OpenShell extension.
 *
 * Resolution order for every field, highest first:
 *   1. session overrides set with `/openshell gateway|workspace`
 *   2. environment variables
 *   3. the config file (default `$XDG_CONFIG_HOME/pi-openshell/config.json`)
 *
 * Tokens and certificates are never required in the config file: point the
 * `*File` fields (or the matching environment variables) at files instead.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

export interface ConfigFile {
  gateway?: string;
  workspace?: string;
  oidcToken?: string;
  oidcTokenFile?: string;
  edgeToken?: string;
  edgeTokenFile?: string;
  caCert?: string;
  clientCert?: string;
  clientKey?: string;
  insecureSkipVerify?: boolean;
  allowInsecureAuth?: boolean;
}

export interface SessionOverrides {
  gateway?: string;
  workspace?: string;
}

export interface ResolvedConfig {
  /** Gateway URL as passed to the SDK. */
  gateway: string;
  /** Default workspace for calls that do not name one. Omitted means the gateway default. */
  workspace?: string;
  oidcToken?: string;
  edgeToken?: string;
  caCert?: Buffer;
  clientCert?: Buffer;
  clientKey?: Buffer;
  insecureSkipVerify?: boolean;
  allowInsecureAuth?: boolean;
  /** Where the gateway URL came from, for `/openshell config`. */
  gatewaySource: string;
  /** Config file path consulted, whether or not it exists. */
  configFile: string;
}

export type Env = Record<string, string | undefined>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const TOKEN_ENV = ["OPENSHELL_TOKEN", "OPENSHELL_OIDC_TOKEN"] as const;

function firstSet(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export function expandPath(path: string, baseDir: string): string {
  let expanded = path.trim();
  if (expanded === "~") expanded = homedir();
  else if (expanded.startsWith("~/")) expanded = `${homedir()}/${expanded.slice(2)}`;
  else if (!isAbsolute(expanded)) expanded = resolve(baseDir, expanded);
  if (expanded.includes("$HOME")) expanded = expanded.replaceAll("$HOME", homedir());
  return expanded;
}

export function configPath(env: Env = process.env, cwd: string = process.cwd()): string {
  const explicit = firstSet(env.PI_OPENSHELL_CONFIG);
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
  const xdg = firstSet(env.XDG_CONFIG_HOME);
  return xdg ? `${xdg}/pi-openshell/config.json` : `${homedir()}/.config/pi-openshell/config.json`;
}

async function readText(path: string): Promise<string> {
  return (await readFile(path, "utf8")).trim();
}

/** Read a PEM or token value from a literal, an environment path, or a file path. */
async function readFromFile(path: string, label: string, baseDir: string): Promise<string> {
  const full = expandPath(path, baseDir);
  try {
    return await readText(full);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new ConfigError(`${label} file not found: ${full}`);
    throw new ConfigError(`cannot read ${label} file ${full}: ${(error as Error).message}`);
  }
}

function parseBoolean(value: string | boolean | undefined, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new ConfigError(`${label} must be a boolean, got ${JSON.stringify(value)}`);
}

function validateGateway(gateway: string): string {
  let url: URL;
  try {
    url = new URL(gateway);
  } catch {
    throw new ConfigError(`gateway ${JSON.stringify(gateway)} is not a URL (expected http://host:port or https://host)`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`gateway ${JSON.stringify(gateway)} must use http:// or https://`);
  }
  return gateway;
}

async function loadConfigFile(path: string): Promise<ConfigFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    throw new ConfigError(`cannot read config file ${path}: ${(error as Error).message}`);
  }
  if (!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as ConfigFile;
  } catch (error) {
    throw new ConfigError(`config file ${path} is not valid JSON: ${(error as Error).message}`);
  }
}

export interface ResolveConfigOptions {
  env?: Env;
  cwd?: string;
  overrides?: SessionOverrides;
}

export async function resolveConfig(options: ResolveConfigOptions = {}): Promise<ResolvedConfig> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const overrides = options.overrides ?? {};
  const path = configPath(env, cwd);
  const baseDir = dirname(path);
  const file = await loadConfigFile(path);

  const overrideGateway = firstSet(overrides.gateway);
  const envGateway = firstSet(env.PI_OPENSHELL_GATEWAY, env.OPENSHELL_GATEWAY);
  const gateway = overrideGateway ?? envGateway ?? firstSet(file.gateway);
  if (!gateway) {
    throw new ConfigError(
      `no OpenShell gateway configured. Set OPENSHELL_GATEWAY, run /openshell gateway <url>, or write ${path} with {"gateway": "https://..."}`,
    );
  }
  const gatewaySource = overrideGateway
    ? "session (/openshell gateway)"
    : envGateway
      ? "environment (OPENSHELL_GATEWAY)"
      : `config file (${path})`;

  const workspace = firstSet(overrides.workspace, env.PI_OPENSHELL_WORKSPACE, env.OPENSHELL_WORKSPACE, file.workspace);

  const oidcTokenFile = firstSet(env.OPENSHELL_TOKEN_FILE, file.oidcTokenFile);
  const oidcTokenLiteral = firstSet(...TOKEN_ENV.map((key) => env[key]), file.oidcToken);
  const oidcToken = oidcTokenFile
    ? await readFromFile(oidcTokenFile, "OIDC token", baseDir)
    : oidcTokenLiteral;

  const edgeTokenFile = firstSet(env.OPENSHELL_EDGE_TOKEN_FILE, file.edgeTokenFile);
  const edgeToken = edgeTokenFile
    ? await readFromFile(edgeTokenFile, "edge token", baseDir)
    : firstSet(env.OPENSHELL_EDGE_TOKEN, file.edgeToken);

  if (oidcToken && edgeToken) {
    throw new ConfigError("OIDC and edge tokens are mutually exclusive; unset one of them");
  }
  if (oidcToken && oidcTokenFile === undefined && /[\r\n]/.test(oidcToken) && !oidcToken.includes("BEGIN")) {
    throw new ConfigError("OIDC token contains a line break; use OPENSHELL_TOKEN_FILE for multi-line values");
  }

  const caCertPath = firstSet(env.OPENSHELL_CA_CERT, env.OPENSHELL_CA_CERT_FILE, file.caCert);
  const clientCertPath = firstSet(env.OPENSHELL_CLIENT_CERT, env.OPENSHELL_CLIENT_CERT_FILE, file.clientCert);
  const clientKeyPath = firstSet(env.OPENSHELL_CLIENT_KEY, env.OPENSHELL_CLIENT_KEY_FILE, file.clientKey);
  if (Boolean(clientCertPath) !== Boolean(clientKeyPath)) {
    throw new ConfigError("client certificate and key must be configured together");
  }

  const caCert = caCertPath ? Buffer.from(await readFromFile(caCertPath, "CA certificate", baseDir)) : undefined;
  const clientCert = clientCertPath
    ? Buffer.from(await readFromFile(clientCertPath, "client certificate", baseDir))
    : undefined;
  const clientKey = clientKeyPath ? Buffer.from(await readFromFile(clientKeyPath, "client key", baseDir)) : undefined;

  const insecureSkipVerify = parseBoolean(
    firstSet(env.OPENSHELL_INSECURE_SKIP_VERIFY) ?? file.insecureSkipVerify,
    "insecureSkipVerify",
  );
  const allowInsecureAuth = parseBoolean(
    firstSet(env.OPENSHELL_ALLOW_INSECURE_AUTH) ?? file.allowInsecureAuth,
    "allowInsecureAuth",
  );

  return {
    gateway: validateGateway(gateway),
    workspace,
    oidcToken,
    edgeToken,
    caCert,
    clientCert,
    clientKey,
    insecureSkipVerify,
    allowInsecureAuth,
    gatewaySource,
    configFile: path,
  };
}

/** Redacted, human-readable view of a resolved config. */
export function describeConfig(config: ResolvedConfig): string {
  const lines = [
    `gateway: ${config.gateway}  (${config.gatewaySource})`,
    `workspace: ${config.workspace ?? "default"}`,
    `config file: ${config.configFile}`,
    `auth: ${config.oidcToken ? "OIDC bearer token" : config.edgeToken ? "edge token" : "mTLS client certificate"}`,
    `client cert: ${config.clientCert ? "present" : "absent"}`,
    `CA cert: ${config.caCert ? "present" : "system roots"}`,
  ];
  if (config.insecureSkipVerify) lines.push("TLS verification: DISABLED (insecureSkipVerify)");
  if (config.allowInsecureAuth) lines.push("cleartext token auth: allowed (allowInsecureAuth)");
  return lines.join("\n");
}
