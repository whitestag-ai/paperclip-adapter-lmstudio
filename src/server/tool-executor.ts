import { executePaperclipTool, PaperclipContext, ToolResult } from "./paperclip-tools.js";
import { executeFsTool } from "./fs-tools.js";
import { executeShellTool } from "./shell-tools.js";
import type { McpRegistry } from "./mcp-client.js";

export interface DispatchParams {
  name: string;
  args: Record<string, unknown>;
  cwd: string;
  paperclipCtx: PaperclipContext;
  allowedWriteRoots?: string[];
  mcpRegistry?: McpRegistry;
  mcpCallTimeoutMs?: number;
}

export async function dispatchTool(params: DispatchParams): Promise<ToolResult> {
  const {
    name,
    args,
    cwd,
    paperclipCtx,
    allowedWriteRoots = [],
    mcpRegistry,
    mcpCallTimeoutMs = 30000,
  } = params;

  if (name.startsWith("mcp__")) {
    if (mcpRegistry && mcpRegistry.has(name)) {
      return mcpRegistry.call(name, args, mcpCallTimeoutMs);
    }
    return { content: `Unknown MCP tool: ${name}`, isError: true };
  }
  if (name.startsWith("paperclip_")) {
    return executePaperclipTool(name, args, paperclipCtx);
  }
  if (name.startsWith("fs_")) {
    return executeFsTool(name, args, cwd, allowedWriteRoots);
  }
  if (name.startsWith("shell_") || name.startsWith("git_")) {
    return executeShellTool(name, args, cwd);
  }
  return { content: `Unknown tool: ${name}`, isError: true };
}
