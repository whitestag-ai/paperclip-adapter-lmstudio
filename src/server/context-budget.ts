/**
 * Kontext-Budget: Tool-Ergebnisse kappen und die Historie beschneiden.
 *
 * Warum es das gibt: `messages` wuchs bisher monoton. Jedes Tool-Ergebnis
 * landete ungekuerzt in der Historie — `shell_exec` bis 10 MB, `skill_read`
 * ganze Skill-Bodies, `paperclip_get_issue_context` die komplette
 * API-Antwort. Irgendwann sprengt das Fenster des Modells, und LM Studio
 * antwortet mit `Context size has been exceeded` — der Lauf ist verloren.
 *
 * Gemessen am 23.08.2026 (LM-Studio-Logs, eine Woche): 220 Faelle bei
 * `google/gemma-4-12b`, 120 bei `gemma4-31b-it`, 97 bei
 * `abiray/qwen3.6-35b-a3b`. Entscheidend: `gemma-4-31b-it-mlx` laeuft auf
 * 262144 — dem Modellmaximum — und scheiterte trotzdem 33 mal. Ein groesseres
 * Fenster loest das also nicht, der Prompt muss kleiner werden.
 *
 * Zwei Stufen, absichtlich getrennt:
 *   1. `capToolResult` schneidet ein EINZELNES uebergrosses Ergebnis ab.
 *      Billig, verlustarm, greift an der Quelle.
 *   2. `trimMessages` wirft die AELTESTEN Austausche weg, wenn die Summe
 *      trotzdem nicht passt. Das ist der harte Deckel.
 */

export interface BudgetToolCall {
  id: string;
  function: { name: string; arguments: string };
}

export interface BudgetMessage {
  role: string;
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: BudgetToolCall[];
}

/** Ein einzelnes Tool-Ergebnis darf so viele Zeichen haben (~10k Token). */
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 40_000;

/**
 * Anteil des geladenen Kontextfensters, den der Prompt belegen darf. Der Rest
 * traegt die Antwort des Modells plus die Ungenauigkeit der Token-Schaetzung.
 */
export const DEFAULT_PROMPT_BUDGET_RATIO = 0.8;

/** Grobe Schaetzung: ~4 Zeichen je Token. */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Token-Schaetzung fuer eine ganze Nachrichtenliste.
 *
 * `tool_calls` zaehlen mit: ein Aufruf mit grossem Argument-JSON (ein
 * geschriebener Dateiinhalt zum Beispiel) ist oft groesser als jeder
 * Fliesstext, und wer nur `content` misst, unterschaetzt genau die Laeufe,
 * die spaeter am Fenster scheitern.
 */
export function estimateMessagesTokens(messages: BudgetMessage[]): number {
  let sum = 0;
  for (const m of messages) {
    sum += 4; // Rollen- und Struktur-Overhead je Nachricht
    sum += estimateTokens(m.content);
    for (const tc of m.tool_calls ?? []) {
      sum += estimateTokens(tc.function?.name) + estimateTokens(tc.function?.arguments);
    }
  }
  return sum;
}

/**
 * Ein Tool-Ergebnis auf `maxChars` kuerzen.
 *
 * Der Hinweis am Ende ist Absicht: ohne ihn kann das Modell eine Kuerzung
 * nicht von einem tatsaechlich kurzen Ergebnis unterscheiden und arbeitet
 * stillschweigend mit einer halben Datei weiter.
 *
 * `maxChars <= 0` schaltet die Kuerzung ab.
 */
export function capToolResult(content: string, maxChars: number): string {
  if (maxChars <= 0 || content.length <= maxChars) return content;
  return (
    content.slice(0, maxChars) +
    `\n\n[… gekürzt: ${content.length} Zeichen insgesamt, die ersten ${maxChars} sind oben. ` +
    `Bei Bedarf gezielter abfragen (Filter, Limit, Bereich).]`
  );
}

const TRIM_MARKER_PREFIX = "[Kontext gekürzt:";

/**
 * Die Historie auf `maxTokens` beschneiden.
 *
 * Regeln, jede davon aus einem konkreten Bruchrisiko:
 *  - Systemprompt und die erste User-Nachricht (die Aufgabe) bleiben IMMER.
 *    Ohne sie weiss der Agent nicht mehr, wer er ist und was er tun soll.
 *  - Geworfen wird in GRUPPEN: eine Assistant-Nachricht mit `tool_calls`
 *    zusammen mit allen zugehoerigen `tool`-Antworten. Bleibt eine
 *    `tool`-Nachricht ohne ihren Aufruf zurueck, lehnt LM Studio den ganzen
 *    Request mit 400 ab (verwaiste `tool_call_id`) — aus einem zu grossen
 *    Prompt wuerde ein gar nicht mehr funktionierender.
 *  - Die JUENGSTE Gruppe bleibt auch dann, wenn das Budget rechnerisch nicht
 *    reicht. Ein Modell, das nicht mehr sieht, was es gerade getan hat,
 *    wiederholt es.
 *  - `maxTokens <= 0` schaltet ab.
 */
export function trimMessages(
  messages: BudgetMessage[],
  maxTokens: number,
): { messages: BudgetMessage[]; dropped: number } {
  if (maxTokens <= 0 || estimateMessagesTokens(messages) <= maxTokens) {
    return { messages, dropped: 0 };
  }

  // Kopf = alles bis einschliesslich der ersten User-Nachricht.
  let kopfEnde = 0;
  while (kopfEnde < messages.length && messages[kopfEnde].role !== "user") kopfEnde++;
  if (kopfEnde >= messages.length) return { messages, dropped: 0 }; // kein User -> nichts anfassen
  const kopf = messages.slice(0, kopfEnde + 1);
  const rest = messages.slice(kopfEnde + 1);

  // Rest in Gruppen zerlegen: jede beginnt mit einer Nicht-tool-Nachricht.
  const gruppen: BudgetMessage[][] = [];
  for (const m of rest) {
    if (m.role !== "tool" || gruppen.length === 0) gruppen.push([m]);
    else gruppen[gruppen.length - 1].push(m);
  }
  if (gruppen.length <= 1) return { messages, dropped: 0 }; // nichts wegzunehmen

  // Von vorn Gruppen fallen lassen, die juengste bleibt in jedem Fall.
  let ab = 0;
  const passt = () =>
    estimateMessagesTokens([...kopf, ...gruppen.slice(ab).flat()]) <= maxTokens;
  while (!passt() && ab < gruppen.length - 1) ab++;
  if (ab === 0) return { messages, dropped: 0 };

  const entfernt = gruppen.slice(0, ab).flat().length;
  const marker: BudgetMessage = {
    role: "user",
    content:
      `${TRIM_MARKER_PREFIX} ${entfernt} ältere Nachrichten aus dieser Sitzung ` +
      `wurden entfernt, damit der Prompt ins Kontextfenster passt. Wenn dir ` +
      `etwas fehlt, frage es gezielt erneut ab statt es zu erraten.]`,
  };
  return { messages: [...kopf, marker, ...gruppen.slice(ab).flat()], dropped: entfernt };
}
