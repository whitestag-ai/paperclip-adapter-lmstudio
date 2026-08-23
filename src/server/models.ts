/**
 * Das aktuell GELADENE Kontextfenster eines Modells — oder null.
 *
 * Quelle ist LM Studios eigene REST-Schnittstelle (`/api/v0/models/<id>`,
 * Feld `loaded_context_length`). Das OpenAI-kompatible `/v1/models` kennt das
 * Feld nicht.
 *
 * Warum der Adapter das ueberhaupt wissen will: das Prompt-Budget soll sich
 * an der Maschine ausrichten, auf der das Modell gerade liegt, statt an einer
 * fest verdrahteten Zahl. Dieselbe Flotte faehrt 98304 auf der RTX und 262144
 * auf dem MacBook; ein gemeinsamer Festwert waere fuer das eine zu gross und
 * fuer das andere Verschwendung.
 *
 * Faellt still auf null zurueck — die Kuerzung ist eine Schutzmassnahme und
 * darf einen Lauf nie verhindern.
 */
export async function fetchLoadedContextLength(
  baseUrl: string,
  model: string,
  timeoutMs = 5000,
): Promise<number | null> {
  try {
    const response = await fetch(
      `${baseUrl}/api/v0/models/${encodeURIComponent(model)}`,
      { method: "GET", signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!response.ok) return null;
    const data = (await response.json()) as { loaded_context_length?: number | null };
    const n = data?.loaded_context_length;
    return typeof n === "number" && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export async function fetchModels(baseUrl: string): Promise<string[]> {
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return [];

    const data = (await response.json()) as { data: Array<{ id: string }> };
    return data.data.map((m) => m.id);
  } catch {
    return [];
  }
}
