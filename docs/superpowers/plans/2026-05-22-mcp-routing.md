# MCP Routing for lmstudio Adapter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `paperclip-adapter-lmstudio` agents call MCP tools declared in their `adapterConfig.mcpServers`, so the Health Insights agents (HEA company) can actually read health data instead of flailing through the filesystem.

**Architecture:** At run start, spawn each configured MCP stdio server, connect a client, and fetch its tool list. Convert those tools to the adapter's `ToolDefinition` shape with a `mcp__<server>__<tool>` name prefix, merge them into the tool list sent to the LLM, and route any `mcp__`-prefixed tool call through the corresponding MCP client. Connections are opened after endpoint resolution and closed in a `finally` so no MCP child processes leak.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), `@modelcontextprotocol/sdk` (stdio client), vitest.

---

## Background Facts (verified in repo)

- Tools sent to the LLM are the static `PAPERCLIP_TOOLS: ToolDefinition[]` from `src/server/tools.ts`, passed at `src/server/execute.ts:410` and `:425`.
- `ToolDefinition` shape (`src/server/tools.ts:1-12`): `{ type: "function", function: { name, description, parameters: { type:"object", properties, required? } } }`.
- Dispatch is prefix-based in `src/server/tool-executor.ts:13-26` (`paperclip_` / `fs_` / `shell_`|`git_`), returning `ToolResult = { content: string; isError: boolean }` (from `src/server/paperclip-tools.ts`).
- `dispatchTool` is called once per tool call at `src/server/execute.ts:523`.
- Config is read at the top of `execute()` (`src/server/execute.ts:248-279`); `config.mcpServers` is currently never read.
- `mcpServers` config block (already present on the CHO agent) looks like:
  ```json
  { "paperclip-health": {
      "command": "/abs/path/to/paperclip-health-mcp",
      "args": [],
      "env": { "PAPERCLIP_HEALTH_DB_URL": "postgresql://…" } } }
  ```

**Runtime prerequisite (NOT part of this plan):** the CHO agent's `PAPERCLIP_HEALTH_DB_URL` currently has the placeholder password `temp-change-me-walter`. The real `paperclip_health_mcp` role password must be set before a live run can read data. This plan makes the routing work; the password is a config fix Walter applies separately.

---

## Task 1: Add the MCP SDK dependency

**Files:**
- Modify: `package.json` (dependencies)

- [ ] **Step 1: Add the dependency**

```bash
cd "/Users/walterschoenenbroecher.de/SynologyDrive/Mac/Claude Code MAC/opensource/paperclip-adapter-lmstudio"
pnpm add @modelcontextprotocol/sdk@^1.0.0
```

- [ ] **Step 2: Verify it resolves and the project still builds**

Run: `pnpm install && pnpm exec tsc --noEmit`
Expected: no errors; `@modelcontextprotocol/sdk` present in `package.json` dependencies.

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add @modelcontextprotocol/sdk for MCP routing"
```

---

## Task 2: MCP client module — connect, list tools, dispatch, close

**Files:**
- Create: `src/server/mcp-client.ts`
- Test: `tests/mcp-client.test.ts` (repo convention: tests live in `tests/`, import from `../src/server/…js`; `tsconfig` only compiles `src/`)

This module owns all MCP lifecycle. It exposes a `McpRegistry` that holds connected clients keyed by server name and knows how to (a) produce `ToolDefinition[]` for the LLM, (b) dispatch a `mcp__server__tool` call, (c) close everything.

**Naming contract:** an MCP tool `get_daily` on server `paperclip-health` becomes the LLM-visible tool name `mcp__paperclip-health__get_daily`. Dispatch splits on `__`: `["mcp", server, ...toolParts]`, rejoining tool parts with `__` so tool names containing `__` survive.

- [ ] **Step 1: Write failing tests for name encoding/decoding**

```typescript
// tests/mcp-client.test.ts
import { describe, it, expect } from "vitest";
import { encodeMcpToolName, decodeMcpToolName } from "../src/server/mcp-client.js";

describe("mcp tool name encoding", () => {
  it("encodes server + tool into a mcp__ prefixed name", () => {
    expect(encodeMcpToolName("paperclip-health", "get_daily")).toBe(
      "mcp__paperclip-health__get_daily",
    );
  });

  it("decodes back to server and tool", () => {
    expect(decodeMcpToolName("mcp__paperclip-health__get_daily")).toEqual({
      server: "paperclip-health",
      tool: "get_daily",
    });
  });

  it("preserves tool names that themselves contain __", () => {
    const encoded = encodeMcpToolName("srv", "a__b");
    expect(decodeMcpToolName(encoded)).toEqual({ server: "srv", tool: "a__b" });
  });

  it("returns null for non-mcp names", () => {
    expect(decodeMcpToolName("paperclip_get_inbox")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/mcp-client.test.ts`
Expected: FAIL — `mcp-client.js` / exports do not exist.

- [ ] **Step 3: Implement the module**

```typescript
// src/server/mcp-client.ts
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

  /** Spawn + connect each configured server. Failures are logged and skipped. */
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
          // Inherit parent env so PATH etc. resolve, then layer the configured env.
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

  /** Route a mcp__server__tool call to its client. */
  async call(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<ToolResult> {
    const decoded = decodeMcpToolName(name);
    if (!decoded) return { content: `Not an MCP tool: ${name}`, isError: true };
    const entry = this.servers.get(decoded.server);
    if (!entry) {
      return { content: `MCP server not connected: ${decoded.server}`, isError: true };
    }
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
        // best-effort; transport kills the child process on close
      }
    }
    this.servers.clear();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/mcp-client.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/mcp-client.ts tests/mcp-client.test.ts
git commit -m "feat: add MCP client registry with stdio transport and name encoding"
```

---

## Task 3: Route mcp__ calls through the registry in dispatchTool

**Files:**
- Modify: `src/server/tool-executor.ts:5-26`
- Test: append a new `describe` block to the existing `tests/tool-executor.test.ts`

- [ ] **Step 1: Write the failing test**

Append this block to `tests/tool-executor.test.ts` (the file already imports `dispatchTool` from `../src/server/tool-executor.js`; add the `McpRegistry` import at the top):

```typescript
// add near the top of tests/tool-executor.test.ts:
import { McpRegistry } from "../src/server/mcp-client.js";

describe("dispatchTool MCP routing", () => {
  it("routes mcp__ tools to the registry", async () => {
    const registry = { has: () => true, call: vi.fn().mockResolvedValue({ content: "ok", isError: false }) } as unknown as McpRegistry;
    const result = await dispatchTool({
      name: "mcp__paperclip-health__get_daily",
      args: { date: "2026-05-22" },
      cwd: "/tmp",
      paperclipCtx: {} as never,
      mcpRegistry: registry,
      mcpCallTimeoutMs: 30000,
    });
    expect(result).toEqual({ content: "ok", isError: false });
    expect(registry.call).toHaveBeenCalledWith(
      "mcp__paperclip-health__get_daily",
      { date: "2026-05-22" },
      30000,
    );
  });

  it("returns unknown-tool error for mcp__ names when no registry given", async () => {
    const result = await dispatchTool({
      name: "mcp__x__y",
      args: {},
      cwd: "/tmp",
      paperclipCtx: {} as never,
    });
    expect(result.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/tool-executor.test.ts`
Expected: FAIL — `mcpRegistry`/`mcpCallTimeoutMs` not accepted; `mcp__` falls through to "Unknown tool".

- [ ] **Step 3: Implement — extend DispatchParams and add the branch**

Replace the contents of `src/server/tool-executor.ts` with:

```typescript
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/tool-executor.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/tool-executor.ts tests/tool-executor.test.ts
git commit -m "feat: route mcp__ tool calls through McpRegistry in dispatchTool"
```

---

## Task 4: Wire the registry into the run lifecycle in execute()

**Files:**
- Modify: `src/server/execute.ts` — imports, config parse (~248-279), connect after endpoint resolve (~322), merge tools at the two `callChatCompletion` sites (410, 425), pass registry to `dispatchTool` (523), `buildSystemPrompt` (56-64, 369), and wrap the loop in try/finally.

This task has no new unit test of its own (it is integration glue exercised by Task 5's smoke test and `tsc`). Keep each edit minimal.

- [ ] **Step 1: Add the import**

At the top of `src/server/execute.ts`, after the existing `import { PAPERCLIP_TOOLS } from "./tools.js";` line, add:

```typescript
import { McpRegistry, type McpServerConfig } from "./mcp-client.js";
```

- [ ] **Step 2: Parse mcpServers config**

In `execute()`, immediately after the `allowedWriteRoots` block (ends at `src/server/execute.ts:279`), add:

```typescript
  const mcpServersConfig =
    (config.mcpServers as Record<string, McpServerConfig> | undefined) ?? {};
```

- [ ] **Step 3: Connect the registry after endpoint resolution**

Immediately after the fallback-logging block that ends at `src/server/execute.ts:333` (the `if (onFallback) { … }`), add:

```typescript
  const mcpRegistry = await McpRegistry.connect(mcpServersConfig, ctx.onLog);
  const mcpTools = mcpRegistry.toolDefinitions();
  const tools = mcpTools.length > 0 ? [...PAPERCLIP_TOOLS, ...mcpTools] : PAPERCLIP_TOOLS;
```

- [ ] **Step 4: Use the merged `tools` at both call sites**

In the first `callChatCompletion` (currently `src/server/execute.ts:410`), change `tools: PAPERCLIP_TOOLS,` to:

```typescript
        tools,
```

In the fallback-retry `callChatCompletion` (currently `src/server/execute.ts:425`), change `tools: PAPERCLIP_TOOLS,` to:

```typescript
            tools,
```

- [ ] **Step 5: Pass the registry to dispatchTool**

In the `dispatchTool({ … })` call (currently `src/server/execute.ts:523-529`), add the two new fields so it reads:

```typescript
      const result = await dispatchTool({
        name: toolCall.function.name,
        args,
        cwd,
        paperclipCtx,
        allowedWriteRoots,
        mcpRegistry,
        mcpCallTimeoutMs: Math.max(1000, Math.min(30000, remainingRunMs() || 30000)),
      });
```

- [ ] **Step 6: Tell the model the MCP tools exist**

Change `buildSystemPrompt` (`src/server/execute.ts:56`) signature to accept the MCP tool names, and emit a fourth category. Update the signature line to:

```typescript
function buildSystemPrompt(
  agent: ExecutionContext["agent"],
  context: Record<string, unknown>,
  mcpToolNames: string[] = [],
): string {
```

Then, inside the `parts` array, replace the line
`"- Shell & Git: execute commands, git operations (shell_exec, git_*)",`
with:

```typescript
    "- Shell & Git: execute commands, git operations (shell_exec, git_*)",
    ...(mcpToolNames.length > 0
      ? [
          `- Domain tools (MCP): prefer these for domain data over shell/grep — ${mcpToolNames.join(", ")}`,
        ]
      : []),
```

Update the call site (`src/server/execute.ts:369`) to pass the names:

```typescript
    { role: "system", content: buildSystemPrompt(ctx.agent, systemPromptContext, mcpRegistry.toolNames()) },
```

- [ ] **Step 7: Close the registry in a finally**

Wrap the `for (let iteration …)` loop and everything after it up to the function's end in a `try { … } finally { await mcpRegistry.close(); }`. Concretely: insert `try {` on the line directly before `for (let iteration = 0; …)` (currently `src/server/execute.ts:382`), and insert the matching `} finally { await mcpRegistry.close(); }` immediately before the closing brace of `execute()`. Every `return` inside the loop then runs cleanup on the way out.

- [ ] **Step 8: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors. (If the `try` wrapping introduces a "not all code paths return" error, confirm the post-loop fallthrough `return` is inside the `try`.)

- [ ] **Step 9: Run the full unit suite**

Run: `pnpm exec vitest run`
Expected: all tests pass (existing + Tasks 2-3).

- [ ] **Step 10: Commit**

```bash
git add src/server/execute.ts
git commit -m "feat: connect MCP servers per run, merge tools, route + cleanup"
```

---

## Task 5: Config-schema entry + live smoke test

**Files:**
- Modify: `src/server/index.ts` (config schema — `getConfigSchema`, near the existing `timeoutMs` key around `src/server/index.ts:87`)
- Manual: live run against the real `paperclip-health` MCP server

- [ ] **Step 1: Add a schema hint for mcpServers (optional, JSON object)**

In the config schema array in `src/server/index.ts`, add an entry alongside the existing keys (mirror the shape of the neighbouring `timeoutMs` entry):

```typescript
          {
            key: "mcpServers",
            label: "MCP Servers (JSON)",
            type: "json",
            required: false,
            hint: "Map of name → { command, args?, env? }. Each is spawned as a stdio MCP server at run start; its tools become available as mcp__<name>__<tool>.",
          },
```

(If the schema's `type` union has no `"json"` member, use the same `type` the adapter already uses for free-form object/string config and document the JSON shape in the hint. Verify against the existing entries before committing.)

- [ ] **Step 2: Build the adapter**

Run: `pnpm run build` (or the package's build script; check `package.json` `scripts`)
Expected: `dist/` rebuilt with no errors.

- [ ] **Step 3: Live smoke test against the health MCP server**

Precondition: set the real `paperclip_health_mcp` password in the CHO agent's `PAPERCLIP_HEALTH_DB_URL` (replace `temp-change-me-walter`).

Unpark and run one issue:
```bash
cd "/Users/walterschoenenbroecher.de/SynologyDrive/2026/AI/Claude Code/Paperclip"
TOK=$(python3 -c "import json;print(json.load(open('$HOME/.paperclip/auth.json'))['credentials']['http://localhost:3100']['token'])")
paperclipai issue update HEA-61 --status todo --api-key "$TOK"
```
Then watch the run log (`~/.paperclip/instances/default/logs/server.log`, or the dashboard run view).
Expected: log shows `[mcp] connected "paperclip-health" (N tools)`, the agent calls a `mcp__paperclip-health__*` tool, gets real data back, and closes HEA-61 with a `done` status answering the nutrition-data question — no LLM timeout, no filesystem grep flailing.

- [ ] **Step 4: Commit**

```bash
git add src/server/index.ts
git commit -m "feat: expose mcpServers in adapter config schema"
```

---

## Self-Review

- **Spec coverage:** dependency (T1), connect+listTools+call+close (T2), dispatch routing (T3), lifecycle wiring + tool merge + system-prompt advertisement + cleanup (T4), config schema + live verification (T5). All four design points from the diagnosis (read config, spawn, merge tools, route) are covered.
- **Type consistency:** `ToolResult` `{content,isError}` matches `paperclip-tools.ts`; `ToolDefinition` matches `tools.ts:1-12`; `encodeMcpToolName`/`decodeMcpToolName`/`McpRegistry.{connect,toolDefinitions,toolNames,has,call,close}` names are used identically across T2/T3/T4.
- **Placeholders:** none — every code step shows full content. The two "verify against existing schema" notes in T5 are genuine repo-shape checks, not deferred work.
- **Open runtime item (out of scope):** real DB password for `paperclip_health_mcp`.
