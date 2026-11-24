/** Shared state for the tools: connection cache, session overrides, workspace defaults. */

import { ClientManager, type Gateway } from "./client.ts";
import {
  describeConfig,
  resolveConfig,
  type Env,
  type ResolvedConfig,
  type SessionOverrides,
} from "./config.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type { Gateway };

export interface SandboxSelection {
  name: string;
  /** Workspace the sandbox lives in; resolved at selection time. */
  workspace?: string;
  /** Directory commands run in inside the sandbox. */
  workdir?: string;
}

export class Context {
  readonly clients: ClientManager;
  private overrides: SessionOverrides = {};
  private env: Env;
  private sandboxSelection: SandboxSelection | undefined;

  constructor(env: Env = process.env, clients: ClientManager = new ClientManager()) {
    this.env = env;
    this.clients = clients;
  }

  /** Sandbox that built-in bash routes into, when one is selected. */
  get selection(): SandboxSelection | undefined {
    return this.sandboxSelection;
  }

  selectSandbox(selection: SandboxSelection | undefined): void {
    this.sandboxSelection = selection;
  }

  get sessionOverrides(): SessionOverrides {
    return { ...this.overrides };
  }

  setGateway(gateway: string | undefined): void {
    this.overrides.gateway = gateway?.trim() || undefined;
    this.clients.reset();
  }

  setWorkspace(workspace: string | undefined): void {
    this.overrides.workspace = workspace?.trim() || undefined;
  }

  async config(cwd: string): Promise<ResolvedConfig> {
    return resolveConfig({ env: this.env, cwd, overrides: this.overrides });
  }

  async gateway(cwd: string): Promise<Gateway> {
    return this.clients.get(() => this.config(cwd));
  }

  /**
   * Workspace for one call: an explicit argument wins, then the session
   * override, then the configured default. `undefined` means the gateway default.
   */
  async workspace(cwd: string, explicit?: string): Promise<string | undefined> {
    if (explicit?.trim()) return explicit.trim();
    if (this.overrides.workspace) return this.overrides.workspace;
    return (await this.config(cwd)).workspace;
  }

  async summary(cwd: string): Promise<string> {
    return describeConfig(await this.config(cwd));
  }
}

/** Workspace scope object that omits the field entirely for the gateway default. */
export function workspaceScope(workspace: string | undefined): { workspace?: string } {
  return workspace ? { workspace } : {};
}

/** Raw workspace selector for RPCs the curated client does not wrap. */
export function rawWorkspaceScope(workspace: string | undefined): {
  selection: { case: "workspace"; value: string } | { case: undefined; value?: undefined };
} {
  return workspace
    ? { selection: { case: "workspace", value: workspace } }
    : { selection: { case: undefined } };
}

/** ExtensionContext plus the tool's own cancellation signal. */
export type ToolSignal = AbortSignal | undefined;

export type RegisterTools = (pi: ExtensionAPI, context: Context) => void;
