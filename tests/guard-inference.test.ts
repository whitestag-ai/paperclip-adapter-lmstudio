import { describe, it, expect } from "vitest";
import { inferTerminalStatusFromFinalMessage } from "../src/server/guard-inference.js";

describe("inferTerminalStatusFromFinalMessage", () => {
  it("returns 'done' when message has issue identifier AND german 'abgeschlossen' phrase", () => {
    const result = inferTerminalStatusFromFinalMessage(
      "Task WHI-427 abgeschlossen. Ich habe eine vollständige Zusammenstellung erstellt.",
    );
    expect(result).toBe("done");
  });

  it("returns 'done' when message has identifier AND english 'marked as done' phrase", () => {
    const result = inferTerminalStatusFromFinalMessage(
      "Task WHI-431 marked as done. Lauf abgeschlossen — 20 Dateien getaggt.",
    );
    expect(result).toBe("done");
  });

  it("returns 'done' when message has 'Triage abgeschlossen' and identifier", () => {
    const result = inferTerminalStatusFromFinalMessage(
      "Triage abgeschlossen für WHI-433, 1 neue Mail als FYI klassifiziert.",
    );
    expect(result).toBe("done");
  });

  it("returns 'done' when message has 'Lauf abgeschlossen' and identifier elsewhere", () => {
    const result = inferTerminalStatusFromFinalMessage(
      "Lauf abgeschlossen — 20 Dateien getaggt, 0 Fehler. Bericht für WHI-431 erstellt.",
    );
    expect(result).toBe("done");
  });

  it("returns null when completion phrase is present but no issue identifier is mentioned", () => {
    const result = inferTerminalStatusFromFinalMessage(
      "Task abgeschlossen. All done!",
    );
    expect(result).toBeNull();
  });

  it("returns null when issue identifier is mentioned but no completion phrase is present", () => {
    const result = inferTerminalStatusFromFinalMessage(
      "I am still working on WHI-436 — research is in progress.",
    );
    expect(result).toBeNull();
  });

  it("returns null on empty message", () => {
    expect(inferTerminalStatusFromFinalMessage("")).toBeNull();
  });

  it("returns null when message reports failure even if it mentions the issue identifier", () => {
    const result = inferTerminalStatusFromFinalMessage(
      "WHI-428 fehlgeschlagen — max_iterations erreicht ohne final answer.",
    );
    expect(result).toBeNull();
  });

  it("matches identifier with mixed-case prefix (e.g. PAP-)", () => {
    const result = inferTerminalStatusFromFinalMessage(
      "Task PAP-142 abgeschlossen.",
    );
    expect(result).toBe("done");
  });

  it("phrase match is case-insensitive", () => {
    const result = inferTerminalStatusFromFinalMessage(
      "Task WHI-1 ABGESCHLOSSEN.",
    );
    expect(result).toBe("done");
  });
});
