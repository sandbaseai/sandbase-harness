/**
 * MCP Client Manager (Requirement 5)
 *
 * Connects to MCP servers declared in an Agent definition and exposes their
 * tools to the engine loop. Uses the official MCP SDK client
 * (`@modelcontextprotocol/sdk`), since the Vercel AI SDK removed the
 * `experimental_createMCPClient` wrapper this used to go through.
 *
 * Transports:
 * - stdio: spawns a subprocess and speaks MCP over stdin/stdout
 * - url:    connects to an HTTP/SSE MCP endpoint
 *
 * Degradation (R5.5): a server that fails to connect within the timeout is
 * logged, marked unavailable, and skipped — the agent keeps running with
 * whatever tools did connect.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { resolveEnvVarsDeep } from '@/core/config/env-resolver.js';
import type { McpServerConfig } from '@/types/agent.js';

/** Default connect + tools/list timeout (ms). */
const DEFAULT_MCP_TIMEOUT_MS = 30_000;

/** Reconnect policy (R5.6): exponential backoff, max 60s interval, 5 attempts. */
const RECONNECT_MAX_ATTEMPTS = 5;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

/** Compute the backoff delay for a given attempt (0-indexed): 1s,2s,4s,…,60s cap. */
export function reconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
}

export interface McpServerStatus {
  name: string;
  type: 'stdio' | 'url';
  connected: boolean;
  toolCount: number;
  error?: string;
}

interface McpClient {
  tools(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/**
 * Manages the lifecycle of MCP client connections for a single session/agent.
 * One instance per session; call close() on session teardown.
 */
export class McpManager {
  private clients = new Map<string, McpClient>();
  private serverConfigs = new Map<string, McpServerConfig>();
  private statuses: McpServerStatus[] = [];
  /** Current live (un-namespaced) tool defs per server, refreshed on reconnect. */
  private liveTools = new Map<string, Record<string, any>>();
  /** Sleep function (injectable for tests). */
  private sleepFn: (ms: number) => Promise<void> = sleep;

  /** Override the sleep function (test hook for backoff). */
  setSleepFn(fn: (ms: number) => Promise<void>): void {
    this.sleepFn = fn;
  }

  /**
   * Connect to all configured MCP servers and return their merged tool set.
   * Servers that fail to connect are skipped (degraded mode). Returned tools
   * are wrapped so that a connection-drop error during a tool call triggers an
   * automatic reconnect + retry (R5.6, L5).
   */
  async connectAll(servers: McpServerConfig[]): Promise<Record<string, unknown>> {
    const merged: Record<string, unknown> = {};

    for (const server of servers) {
      // Record the config so a server that's down now can be reconnected later.
      this.serverConfigs.set(server.name, server);
      // Initial connect is fast-degrade (R5.5): one attempt, skip on failure.
      const result = await this.tryConnect(server);
      if (result) {
        this.clients.set(server.name, result.client);
        this.liveTools.set(server.name, result.tools);
        let count = 0;
        for (const toolName of Object.keys(result.tools)) {
          merged[`mcp_${server.name}_${toolName}`] = this.wrapTool(server.name, toolName);
          count++;
        }
        this.setStatus(server, true, count);
      } else {
        this.setStatus(server, false, 0, 'initial connect failed');
      }
    }

    return merged;
  }

  /**
   * Build a stable tool wrapper for `mcp_<server>_<toolName>`. Its execute
   * delegates to the current live tool; on a connection-drop error it reconnects
   * the server (with backoff) and retries once against the refreshed tool.
   */
  private wrapTool(serverName: string, toolName: string): Record<string, unknown> {
    const current = this.liveTools.get(serverName)?.[toolName];
    return {
      description: current?.description,
      parameters: current?.parameters,
      execute: async (args: unknown) => {
        const tool = this.liveTools.get(serverName)?.[toolName];
        if (!tool?.execute) throw new Error(`MCP tool "${toolName}" unavailable`);
        try {
          return await tool.execute(args);
        } catch (err) {
          if (!isConnectionError(err)) throw err;
          // Connection likely dropped — reconnect and retry once.
          const ok = await this.reconnect(serverName, this.sleepFn);
          if (!ok) throw err;
          const fresh = this.liveTools.get(serverName)?.[toolName];
          if (!fresh?.execute) throw err;
          return await fresh.execute(args);
        }
      },
    };
  }

  /**
   * Reconnect a server whose connection dropped mid-session (R5.6): retries
   * with exponential backoff (1s→2s→4s…, capped 60s), up to 5 attempts.
   * Returns the reconnected tool set, or null after exhausting attempts.
   * `sleepFn` is injectable for testing.
   */
  async reconnect(
    serverName: string,
    sleepFn: (ms: number) => Promise<void> = sleep,
  ): Promise<Record<string, unknown> | null> {
    const server = this.serverConfigs.get(serverName);
    if (!server) return null;

    for (let attempt = 0; attempt < RECONNECT_MAX_ATTEMPTS; attempt++) {
      const result = await this.tryConnect(server);
      if (result) {
        // Replace the dead client + refresh the live tool defs (wrappers in the
        // strategy's tool map delegate to these, so they pick up the new client).
        await this.clients.get(serverName)?.close().catch(() => {});
        this.clients.set(serverName, result.client);
        this.liveTools.set(serverName, result.tools);
        const tools: Record<string, unknown> = {};
        let count = 0;
        for (const toolName of Object.keys(result.tools)) {
          tools[`mcp_${serverName}_${toolName}`] = this.wrapTool(serverName, toolName);
          count++;
        }
        this.setStatus(server, true, count);
        return tools;
      }
      if (attempt < RECONNECT_MAX_ATTEMPTS - 1) {
        await sleepFn(reconnectDelay(attempt));
      }
    }
    this.setStatus(server, false, 0, `reconnect failed after ${RECONNECT_MAX_ATTEMPTS} attempts`);
    return null;
  }

  /** Single connect attempt. Returns null on failure (no throw). */
  private async tryConnect(
    server: McpServerConfig,
  ): Promise<{ client: McpClient; tools: Record<string, unknown> } | null> {
    const timeout = (server.timeout ?? 30) * 1000 || DEFAULT_MCP_TIMEOUT_MS;
    let client: McpClient | undefined;
    try {
      client = await withTimeout(
        this.createClient(server),
        timeout,
        `MCP server "${server.name}" connect timed out after ${timeout}ms`,
      );
      const tools = await withTimeout(
        client.tools(),
        timeout,
        `MCP server "${server.name}" tools/list timed out`,
      );
      return { client, tools };
    } catch {
      // Close a client that connected but failed tools/list, so we don't
      // orphan its subprocess/socket (M4).
      if (client) await client.close().catch(() => {});
      return null;
    }
  }

  private setStatus(server: McpServerConfig, connected: boolean, toolCount: number, error?: string): void {
    const existing = this.statuses.findIndex((s) => s.name === server.name);
    const status: McpServerStatus = { name: server.name, type: server.type, connected, toolCount, error };
    if (existing >= 0) this.statuses[existing] = status;
    else this.statuses.push(status);
  }

  /** Connection status for each configured server (for /v1/x/mcp/status). */
  getStatuses(): McpServerStatus[] {
    return this.statuses;
  }

  /** Close all MCP client connections (subprocess kill / socket close). */
  async close(): Promise<void> {
    await Promise.all(
      Array.from(this.clients.values()).map((c) => c.close().catch(() => {})),
    );
    this.clients.clear();
  }

  // ============================================================
  // Internal
  // ============================================================

  private async createClient(server: McpServerConfig): Promise<McpClient> {
    let transport;
    if (server.type === 'stdio') {
      if (!server.command) {
        throw new Error(`MCP server "${server.name}": stdio transport requires "command"`);
      }
      const env = server.env ? resolveEnvVarsDeep(server.env, false) : undefined;
      transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env,
      });
    } else {
      if (!server.url) {
        throw new Error(`MCP server "${server.name}": url transport requires "url"`);
      }
      const url = resolveEnvVarsDeep(server.url, false);
      transport = new SSEClientTransport(new URL(url));
    }

    const client = new Client({ name: 'sandbase-harness', version: '1.0.0' });
    await client.connect(transport);

    return {
      async tools() {
        const { tools } = await client.listTools();
        return Object.fromEntries(tools.map((tool) => [tool.name, {
          description: tool.description,
          parameters: tool.inputSchema,
          execute: (args: unknown) =>
            client.callTool({ name: tool.name, arguments: (args ?? {}) as Record<string, unknown> }),
        }]));
      },
      close: () => client.close(),
    };
  }
}

// ============================================================
// Helpers
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Heuristic: does this error indicate a dropped/broken MCP connection? */
function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message.toLowerCase();
  return (
    m.includes('closed') ||
    m.includes('disconnect') ||
    m.includes('econnreset') ||
    m.includes('epipe') ||
    m.includes('socket') ||
    m.includes('not connected') ||
    m.includes('transport') ||
    m.includes('terminated')
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  // Clear the timer whichever way the race settles, so a resolved connect
  // doesn't leave a dangling timer keeping the event loop alive.
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
