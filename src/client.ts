/**
 * Gateway client lifecycle: one lazily connected SDK client per resolved
 * connection config, plus error text that keeps the SDK's structured details
 * instead of flattening them to a bare message.
 */

import { OpenShellClient, SdkError, type ConnectOptions } from "@ai-openshell/sdk";

import type { ResolvedConfig } from "./config.ts";

export function toConnectOptions(config: ResolvedConfig): ConnectOptions {
  return {
    gateway: config.gateway,
    oidcToken: config.oidcToken,
    edgeToken: config.edgeToken,
    caCert: config.caCert,
    clientCert: config.clientCert,
    clientKey: config.clientKey,
    insecureSkipVerify: config.insecureSkipVerify,
    allowInsecureAuth: config.allowInsecureAuth,
  };
}

/** Reconnect when anything that shapes the connection changes. */
function fingerprint(config: ResolvedConfig): string {
  return JSON.stringify([
    config.gateway,
    config.oidcToken?.slice(-12) ?? null,
    config.oidcToken?.length ?? 0,
    config.edgeToken?.slice(-12) ?? null,
    config.caCert?.length ?? 0,
    config.clientCert?.length ?? 0,
    config.clientKey?.length ?? 0,
    config.insecureSkipVerify ?? false,
    config.allowInsecureAuth ?? false,
  ]);
}

export interface Gateway {
  client: OpenShellClient;
  config: ResolvedConfig;
}

export class ClientManager {
  private cached: { key: string; client: Promise<OpenShellClient> } | undefined;
  private connect: (options: ConnectOptions) => Promise<OpenShellClient>;

  constructor(connect: (options: ConnectOptions) => Promise<OpenShellClient> = OpenShellClient.connect) {
    this.connect = connect;
  }

  /** Connect (or reuse a connection) for the config returned by `resolve`. */
  async get(resolve: () => Promise<ResolvedConfig>): Promise<Gateway> {
    const config = await resolve();
    const key = fingerprint(config);
    if (!this.cached || this.cached.key !== key) {
      this.cached = { key, client: this.connect(toConnectOptions(config)) };
    }
    try {
      return { client: await this.cached.client, config };
    } catch (error) {
      this.cached = undefined;
      throw error;
    }
  }

  /** Drop the cached connection; the next call reconnects. */
  reset(): void {
    this.cached = undefined;
  }
}

export function describeError(error: unknown): string {
  if (error instanceof SdkError) {
    const parts = [`${error.code}: ${error.message}`];
    if (error.connectCode !== undefined) parts.push(`(connect ${error.connectCode})`);
    if (error.fieldViolations.length > 0) {
      parts.push(error.fieldViolations.map((violation) => `${violation.field}: ${violation.description}`).join("; "));
    }
    if (error.errorInfo) parts.push(`[${error.errorInfo.domain}/${error.errorInfo.reason}]`);
    if (error.retryDelayMs !== undefined) parts.push(`retry after ${error.retryDelayMs}ms`);
    return parts.join(" ");
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
