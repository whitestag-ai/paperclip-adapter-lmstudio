import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolDefinition } from "./tools.js";
import type { ToolResult } from "./paperclip-tools.js";

const PREFIX = "mcp";
const SEP = "__";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpLogger {
  (stream: "stdout" | "stderr", text: string): Promise<void> | void;
}

export function encodeMcpToolName(server: string, tool: string): string {
  return [PREFIX, server, tool].join(SEP);
}

export function decodeMcpToolName(
  name: string,
): { server: string; tool: string } | null {
  const parts = name.split(SEP);
  if (parts.length < 3 || parts[0] !== PREFIX) return null;
  const server = parts[1];
  const tool = parts.slice(2).join(SEP);
  if (!server || !tool) return null;
  return { server, tool };
}

interface Connected {
  client: Client;
  tools: ToolDefinition[];
}

export class McpRegistry {
  private servers = new Map<string, Connected>();

  static async connect(
    config: Record<string, McpServerConfig>,
    log: McpLogger,
  ): Promise<McpRegistry> {
    const reg = new McpRegistry();
    for (const [name, spec] of Object.entries(config ?? {})) {
      try {
        const transport = new StdioClientTransport({
          command: spec.command,
          args: spec.args ?? [],
          env: { ...process.env, ...(spec.env ?? {}) } as Record<string, string>,
        });
        const client = new Client(
          { name: "paperclip-adapter-lmstudio", version: "1.0.0" },
          { capabilities: {} },
        );
        await client.connect(transport);
        const listed = await client.listTools();
        const tools: ToolDefinition[] = listed.tools.map((t) => ({
          type: "function",
          function: {
            name: encodeMcpToolName(name, t.name),
            description: t.description ?? `MCP tool ${t.name} on ${name}`,
            parameters: {
              type: "object",
              properties:
                (t.inputSchema?.properties as Record<string, unknown>) ?? {},
              required: (t.inputSchema?.required as string[]) ?? undefined,
            },
          },
        }));
        reg.servers.set(name, { client, tools });
        await log("stdout", `[mcp] connected "${name}" (${tools.length} tools)\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await log("stderr", `[mcp] failed to connect "${name}": ${msg}\n`);
      }
    }
    return reg;
  }

  toolDefinitions(): ToolDefinition[] {
    return [...this.servers.values()].flatMap((s) => s.tools);
  }

  toolNames(): string[] {
    return this.toolDefinitions().map((t) => t.function.name);
  }

  has(name: string): boolean {
    return decodeMcpToolName(name) !== null;
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<ToolResult> {
    const decoded = decodeMcpToolName(name);
    if (!decoded) return { content: `Not an MCP tool: ${name}`, isError: true };
    const entry = this.servers.get(decoded.server);
    if (!entry)
      return {
        content: `MCP server not connected: ${decoded.server}`,
        isError: true,
      };
    try {
      const res = await entry.client.callTool(
        { name: decoded.tool, arguments: args },
        undefined,
        { timeout: timeoutMs },
      );
      const text = Array.isArray(res.content)
        ? res.content
            .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
            .join("\n")
        : JSON.stringify(res.content);
      return { content: text, isError: res.isError === true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `MCP call failed (${name}): ${msg}`, isError: true };
    }
  }

  async close(): Promise<void> {
    for (const { client } of this.servers.values()) {
      try {
        await client.close();
      } catch {
        /* best-effort */
      }
    }
    this.servers.clear();
  }
}
