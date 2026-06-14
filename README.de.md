# paperclip-adapter-lmstudio

Paperclip-Adapter für LM Studio (OpenAI-kompatible lokale LLMs) mit vollständigem Tool-Use.

## Was ist das?

Der Adapter verbindet Paperclip-Agenten mit lokalen LLMs in LM Studio und implementiert einen vollständigen Agent-Loop mit Tool-Use:

- **18 Tools** über Paperclip-API, Dateisystem und Shell/Git
- **OpenAI Function Calling** Standard (funktioniert mit allen LM Studio Modellen die Function Calling unterstützen)
- **Hybrid-Streaming:** Tool-Iterationen als Request-Response, finale Antwort als Token-Stream
- **Sicherheit:** Path-Traversal-Schutz, Shell-Timeouts, Run-ID-Audit-Trail
- **Paperclip-Skills:** dem Agent zugewiesene Skills werden in den System-Prompt eingespeist (siehe unten)

## Voraussetzungen

- Node.js 18+
- LM Studio läuft und die API ist aktiviert (Default: http://localhost:1234)
- Mindestens ein Modell in LM Studio geladen das Function Calling unterstützt (z.B. Gemma, Qwen, Llama)

## Installation

```bash
cd paperclip-adapter-lmstudio
pnpm install
pnpm build
```

Registrierung in `~/.paperclip/adapter-plugins.json`:

```json
[
  {
    "packageName": "paperclip-adapter-lmstudio",
    "localPath": "/absoluter/pfad/zu/paperclip-adapter-lmstudio",
    "type": "lmstudio_local",
    "installedAt": "2026-04-18T00:00:00.000Z"
  }
]
```

Paperclip-Server neu starten.

## Konfiguration (pro Agent)

| Feld | Typ | Default | Beschreibung |
|------|-----|---------|-------------|
| `url` | text | `http://localhost:1234` | Primary LM-Studio-URL |
| `defaultModel` | select | — | Primary-Modell |
| `fallbackUrl` | text | leer | Fallback LM-Studio-URL (z.B. Mac). Leer = kein Fallback |
| `fallbackModel` | text | leer | Fallback-Modellname. Leer = identisch mit `defaultModel` |
| `probeTimeoutMs` | number | `2000` | Timeout für Health-Probe vor jedem Heartbeat |
| `timeoutMs` | number | `120000` | Voller Call-Timeout |
| `streamingEnabled` | boolean | `true` | Token-Streaming |
| `maxIterations` | number | `25` | Max. Tool-Aufrufe pro Heartbeat |

## Fallback-Endpoint

Wenn ein zweiter LM-Studio-Host verfügbar ist (z.B. Mac als Backup für den Windows-PC), kann er als Fallback konfiguriert werden:

```json
{
  "url": "http://192.168.1.50:1234",
  "defaultModel": "gemma-4-31b-it",
  "fallbackUrl": "http://localhost:1234",
  "fallbackModel": "gemma-4-27b-it"
}
```

Ablauf pro Heartbeat:

1. Adapter ruft `GET {primaryUrl}/v1/models` mit `probeTimeoutMs` auf.
2. Probe OK → Primary wird für den Heartbeat verwendet.
3. Probe fehlt (Verbindung abgelehnt / DNS / Timeout) → Fallback wird geprüft und verwendet. Ein Meta-Event im Run-Transcript markiert den Wechsel.
4. Auch Fallback nicht erreichbar → Run schlägt fehl mit `errorCode: "llm_unreachable"`.

Wechselt der Adapter mitten im Heartbeat (z.B. weil der Primary während eines Calls abstürzt), bleibt er sticky auf dem Fallback bis zum Heartbeat-Ende. Der nächste Heartbeat probiert wieder Primary zuerst.

## Paperclip-Skills

Die Skills, die du einem Agent in Paperclip zuweist, werden vom Server an jeden Run geliefert (über die Adapter-Config-Keys `paperclipRuntimeSkills` und `paperclipSkillSync`). Da dieser Adapter seine eigene Agent-Loop mit handgebautem System-Prompt fährt — statt einer CLI, die ein Skills-Verzeichnis selbst entdeckt — bringt er sie selbst ein, mit **Progressive Disclosure**, damit der Basis-Prompt auch bei vielen Skills klein bleibt:

- Der System-Prompt erhält einen kompakten **`## Available Skills`**-Index — pro Skill nur **Name + Beschreibung** (je eine Zeile), nicht den vollen Inhalt.
- Ein `skill_read`-Tool wird dem Modell angeboten (nur wenn der Agent Skills hat). Das Modell ruft `skill_read` mit dem Skill-Namen auf, um die vollständige `SKILL.md` bei Bedarf zu laden — direkt bevor es eine passende Aufgabe angeht.

Auflösungsregeln:

- Skills, die im `SKILL.md`-Frontmatter als `required` markiert sind, sind immer aktiv.
- Explizit für den Agent ausgewählte Skills kommen oben drauf (gematcht nach Key, Runtime-Name oder Slug).
- Sowohl gebündelte (`paperclipai/paperclip/*`) als auch Firmen-Katalog-Skills (`local/*`) werden unterstützt.
- Ein Skill, dessen `SKILL.md` nicht lesbar ist, wird übersprungen — er bricht den Run nie ab.

Jeder Run mit Skills loggt ein `system`-Event mit den angebotenen Skills. Warum Progressive Disclosure: ein Skill-Body hat im Schnitt ~1,8k Tokens — 10–19 Skills (üblich bei größeren Agents) eifrig einzuspeisen würde jeden Prompt um 18–35k Tokens aufblähen und auf lokalen Modellen mit knappem Kontextfenster die eigentliche Aufgabe verdrängen.

## Verfügbare Tools

**Paperclip-API (8):** `paperclip_get_identity`, `paperclip_get_inbox`, `paperclip_checkout_issue`, `paperclip_update_issue`, `paperclip_add_comment`, `paperclip_get_issue_context`, `paperclip_get_comments`, `paperclip_create_subtask`

**Dateisystem (5):** `fs_read_file`, `fs_write_file`, `fs_list_directory`, `fs_glob`, `fs_grep`

**Shell & Git (5):** `shell_exec`, `git_status`, `git_diff`, `git_commit`, `git_log`

## Tests

```bash
pnpm test
```

## Modell-Empfehlungen

Tool-Use erfordert Function Calling. Getestete Modelle:

- **gemma-4-31b-it** — solide Tool-Use, empfohlen für Haupt-Agents
- **qwen/qwen3-14b** — schnell, Tool-Use funktioniert
- **qwen2.5-32b-instruct** — sehr gute Tool-Use-Genauigkeit

Modelle ohne Function Calling Support produzieren oft Kauderwelsch — vorher mit einem simplen API-Call testen.

## Troubleshooting

- **Agent antwortet nicht / hängt:** Timeout prüfen, bei 70B+ Modellen auf 300s+ erhöhen
- **Tool-Calls werden ignoriert:** Modell-Kompatibilität prüfen (muss Function Calling können)
- **Max iterations reached:** `maxIterations` erhöhen oder Aufgaben kleiner machen
- **Fallback greift nicht:** `fallbackUrl` und Erreichbarkeit des Fallback-Hosts prüfen. Logs zeigen `llm_unreachable`-Error mit beiden Probe-Reasons.
- **Fallback wird zu langsam erkannt:** `probeTimeoutMs` verringern (z.B. auf 1000ms).
