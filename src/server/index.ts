import { type, agentConfigurationDoc } from "../index.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { fetchModels } from "./models.js";
import { listSkills, syncSkills, type SkillContext, type SkillSnapshot } from "./skills.js";

interface ConfigSchemaField {
  key: string;
  label: string;
  type: "text" | "number" | "boolean" | "select" | "combobox";
  required?: boolean;
  default?: unknown;
  hint?: string;
  options?: Array<{ value: string; label: string }>;
  meta?: Record<string, unknown>;
}

interface AdapterConfigSchema {
  version: number;
  fields: ConfigSchemaField[];
}

interface ServerAdapterModule {
  type: string;
  execute: typeof execute;
  testEnvironment: typeof testEnvironment;
  agentConfigurationDoc?: string;
  supportsLocalAgentJwt?: boolean;
  listModels?: (opts?: { url?: string }) => Promise<Array<{ id: string; label: string }>>;
  getConfigSchema?: () => Promise<AdapterConfigSchema>;
  listSkills?: (ctx: SkillContext) => Promise<SkillSnapshot>;
  syncSkills?: (ctx: SkillContext, desiredSkills: string[]) => Promise<SkillSnapshot>;
  requiresMaterializedRuntimeSkills?: boolean;
}

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    agentConfigurationDoc,
    supportsLocalAgentJwt: true,
    // Skills are resolved per run and surfaced via the prompt index + skill_read
    // tool (ephemeral), not installed into a CLI skills-home — so no
    // materialization step is required.
    requiresMaterializedRuntimeSkills: false,
    listSkills,
    syncSkills,
    async listModels(opts) {
      const url = opts?.url?.trim() || "http://localhost:1234";
      const models = await fetchModels(url);
      return models.map((id) => ({ id, label: id }));
    },
    async getConfigSchema() {
      return {
        version: 1,
        fields: [
          {
            key: "url",
            label: "LM Studio URL",
            type: "text" as const,
            required: true,
            default: "http://localhost:1234",
            hint: "URL des LM Studio Servers",
          },
          {
            key: "defaultModel",
            label: "Modell",
            type: "combobox" as const,
            required: true,
            hint: "LLM-Modell aus LM Studio (wird beim Öffnen von der oben eingetragenen URL geladen)",
            meta: { optionsFromUrlField: "url" },
          },
          {
            key: "fallbackUrl",
            label: "Fallback LM Studio URL (optional)",
            type: "text" as const,
            hint: "Zweite LM-Studio-Instanz (z.B. Mac), die genutzt wird, wenn der Primary nicht erreichbar ist. Leer = kein Fallback.",
          },
          {
            key: "fallbackModel",
            label: "Fallback-Modell (optional)",
            type: "combobox" as const,
            hint: "Modellname auf dem Fallback-Host. Leer = gleicher Name wie Primary-Modell.",
            meta: {
              optionsFromUrlField: "fallbackUrl",
              disabledWhenEmpty: "fallbackUrl",
            },
          },
          {
            key: "probeTimeoutMs",
            label: "Health-Probe Timeout (ms)",
            type: "number" as const,
            default: 2000,
            hint: "Timeout für den kurzen Health-Check vor jedem Heartbeat. Bestimmt, wie schnell der Fallback greift, wenn der Primary-Host aus ist.",
          },
          {
            key: "timeoutMs",
            label: "Timeout (ms)",
            type: "number" as const,
            default: 120000,
            hint: "Timeout für Inferenz in Millisekunden",
          },
          {
            key: "streamingEnabled",
            label: "Token-Streaming",
            type: "boolean" as const,
            default: true,
            hint: "Antwort Token für Token in der UI anzeigen",
          },
          {
            key: "maxIterations",
            label: "Max Tool-Iterationen",
            type: "number" as const,
            default: 25,
            hint: "Maximale Anzahl Tool-Aufrufe pro Heartbeat (Sicherheitslimit)",
          },
          {
            key: "maxRunSeconds",
            label: "Max Run-Laufzeit (s)",
            type: "number" as const,
            default: 300,
            hint: "Wallclock-Budget pro Run. Verhindert durchlaufende Tool-Schleifen, die LM Studio stundenlang belasten.",
          },
          {
            key: "allowedWriteRoots",
            label: "Zusätzlich erlaubte Schreib-Pfade",
            type: "text" as const,
            hint: "Kommagetrennte absolute Pfade, in die der Agent zusätzlich zum Arbeitsverzeichnis schreiben darf (z.B. Obsidian-Vault auf externem Volume).",
          },
          {
            key: "instructionsFilePath",
            label: "Instructions File (AGENTS.md)",
            type: "text" as const,
            hint: "Optionaler absoluter Pfad zu einer Markdown-Datei, die als Agent-Persona an den System-Prompt angehängt wird",
          },
          {
            key: "mcpServers",
            label: "MCP Servers (JSON)",
            type: "text" as const,
            required: false,
            hint: "Map of name → { command, args?, env? }. Each is spawned as a stdio MCP server at run start; its tools become available to the agent as mcp__<name>__<tool>.",
          },
        ],
      };
    },
  };
}
