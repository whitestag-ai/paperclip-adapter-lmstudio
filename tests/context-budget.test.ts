import { describe, expect, it } from "vitest";
import {
  capToolResult,
  estimateTokens,
  estimateMessagesTokens,
  trimMessages,
  type BudgetMessage,
} from "../src/server/context-budget.js";

describe("capToolResult", () => {
  it("leaves small results untouched", () => {
    expect(capToolResult("kurz", 100)).toBe("kurz");
  });

  it("truncates oversized results and says so", () => {
    const out = capToolResult("x".repeat(500), 100);
    expect(out.startsWith("x".repeat(100))).toBe(true);
    // The note must stay a bounded addition — it may grow by the digits of the
    // reported length, but never with the input itself, or capping a 10 MB
    // result would save nothing.
    expect(out.length - 100).toBeLessThan(200);
    expect(capToolResult("x".repeat(5_000_000), 100).length - 100).toBeLessThan(200);
    // The model must be able to tell truncation from a genuinely short result,
    // otherwise it silently reasons on half a file.
    expect(out).toMatch(/gekürzt|truncated/i);
    expect(out).toContain("500");
  });

  it("is disabled by a non-positive limit", () => {
    const gross = "y".repeat(10_000);
    expect(capToolResult(gross, 0)).toBe(gross);
    expect(capToolResult(gross, -1)).toBe(gross);
  });
});

describe("estimateTokens", () => {
  it("uses the ~4 chars per token rule", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("counts every message including its role overhead", () => {
    const msgs: BudgetMessage[] = [
      { role: "system", content: "a".repeat(400) },
      { role: "user", content: "b".repeat(400) },
    ];
    // 100 + 100 tokens plus a small per-message overhead
    expect(estimateMessagesTokens(msgs)).toBeGreaterThanOrEqual(200);
    expect(estimateMessagesTokens(msgs)).toBeLessThan(240);
  });

  it("counts tool_calls, not just content", () => {
    const ohne: BudgetMessage[] = [{ role: "assistant", content: "" }];
    const mit: BudgetMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "1", function: { name: "shell_exec", arguments: "z".repeat(400) } },
        ],
      },
    ];
    expect(estimateMessagesTokens(mit)).toBeGreaterThan(estimateMessagesTokens(ohne) + 90);
  });
});

describe("trimMessages", () => {
  // Realistic shape of a run: one system, one user, then assistant/tool pairs.
  function verlauf(paare: number, groesse = 4000): BudgetMessage[] {
    const msgs: BudgetMessage[] = [
      { role: "system", content: "SYS" },
      { role: "user", content: "AUFGABE" },
    ];
    for (let i = 0; i < paare; i++) {
      msgs.push({
        role: "assistant",
        content: "",
        tool_calls: [{ id: `c${i}`, function: { name: "read_file", arguments: "{}" } }],
      });
      msgs.push({ role: "tool", tool_call_id: `c${i}`, content: "R".repeat(groesse) });
    }
    return msgs;
  }

  it("does nothing when the budget fits", () => {
    const msgs = verlauf(2);
    const { messages, dropped } = trimMessages(msgs, 1_000_000);
    expect(dropped).toBe(0);
    expect(messages).toEqual(msgs);
  });

  it("is disabled by a non-positive budget", () => {
    const msgs = verlauf(50);
    expect(trimMessages(msgs, 0).dropped).toBe(0);
  });

  it("drops the oldest exchanges until the budget holds", () => {
    const msgs = verlauf(10); // ~10k tokens of tool output
    const { messages, dropped } = trimMessages(msgs, 3000);
    expect(dropped).toBeGreaterThan(0);
    expect(estimateMessagesTokens(messages)).toBeLessThanOrEqual(3000);
  });

  it("never drops the system prompt or the task", () => {
    const { messages } = trimMessages(verlauf(20), 500);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toBe("SYS");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toBe("AUFGABE");
  });

  it("never leaves a tool message without its assistant call", () => {
    // This is the one that breaks production: LM Studio rejects the whole
    // request with a 400 when a tool_call_id has no matching tool_calls entry.
    const { messages } = trimMessages(verlauf(12), 2500);
    const offen = new Set<string>();
    for (const m of messages) {
      if (m.role === "assistant") for (const tc of m.tool_calls ?? []) offen.add(tc.id);
      if (m.role === "tool") {
        expect(offen.has(m.tool_call_id!)).toBe(true);
      }
    }
  });

  it("keeps the most recent exchange even under a tiny budget", () => {
    // Dropping everything would leave the model blind to what it just did.
    const { messages } = trimMessages(verlauf(8), 1);
    const letzte = messages[messages.length - 1];
    expect(letzte.role).toBe("tool");
    expect(letzte.tool_call_id).toBe("c7");
  });

  it("leaves a marker so the model knows history was cut", () => {
    const { messages } = trimMessages(verlauf(10), 2500);
    const text = messages.map((m) => m.content ?? "").join("\n");
    expect(text).toMatch(/gekürzt|truncated|entfernt/i);
  });

  it("handles a history without any tool exchange", () => {
    const msgs: BudgetMessage[] = [
      { role: "system", content: "S" },
      { role: "user", content: "U".repeat(40_000) },
    ];
    // Nothing droppable — return unchanged rather than mangling the request.
    const { messages, dropped } = trimMessages(msgs, 100);
    expect(dropped).toBe(0);
    expect(messages).toEqual(msgs);
  });
});
