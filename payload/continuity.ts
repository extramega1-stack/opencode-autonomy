/**
 * continuity.ts — Keeps a long agentic session from losing the thread.
 *
 * Two independent jobs, one of them opt-in:
 *
 * 1. Handoff on compaction (always on, no downside).
 *    opencode's compaction prompt is generic, so the summary it writes is a
 *    narrative of the conversation. That narrative is the first thing to rot,
 *    and the goal usually dies with it. This hook appends ground truth to the
 *    compaction prompt: the actual goal (the session's first user message,
 *    which is the most durable part of a conversation), the work that is not
 *    committed yet, the recent commits, and the todo items still open. The
 *    summary is then anchored to the repository rather than to the chat.
 *
 *    We only push to `output.context`, never set `output.prompt`, so opencode
 *    keeps its own context-restoration prompt and this is additive.
 *
 * 2. Auto-continue (opt-in, off by default).
 *    When a session goes idle with work still open, the agent has stopped
 *    early. If enabled, this sends a short continuation prompt. It costs
 *    tokens and it acts without you, so it stays off until you ask for it, and
 *    it stops on a budget, on a stall, or when the todos are done.
 *
 * Configuration lives in ~/.config/opencode/continuity.json:
 *
 *   {
 *     "auto_continue": false,
 *     "max_continues": 20,
 *     "max_minutes": 180,
 *     "cooldown_seconds": 90,
 *     "stall_limit": 2,
 *     "recent_commits": 5,
 *     "max_handoff_chars": 4000
 *   }
 *
 * Context pressure is published to ~/.local/state/opencode-vpn/context.json so
 * the bar widget and the Plasma tray can show it without an API.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const CONFIG_FILE = join(homedir(), ".config/opencode/continuity.json")
const STATE_DIR = join(homedir(), ".local/state/opencode-vpn")
const SESSIONS_DIR = join(STATE_DIR, "sessions")
// Un archivo por sesión: con dos chats abiertos, un único context.json lo
// pisaba el otro y el indicador alternaba entre ambos.
const SESSION_FILE = (id) => join(SESSIONS_DIR, `${id}.json`)
// El panel no conoce el puerto del server de opencode, así que la petición de
// compactar viaja por un archivo y el plugin la atiende.
const COMPACT_REQUEST = join(STATE_DIR, "compact-request.json")
const COMPACT_RESULT = join(STATE_DIR, "compact-result.json")
const LOADED_FILE = join(STATE_DIR, "continuity-loaded.json")
const STALE_MS = 7 * 24 * 60 * 60 * 1000

const DEFAULTS = {
  auto_continue: false,
  max_continues: 20,
  max_minutes: 180,
  cooldown_seconds: 90,
  stall_limit: 2,
  recent_commits: 5,
  max_handoff_chars: 4000,
  // Un umbral de "el agente dijo que terminó" para los casos en que la lista de
  // tareas quedó vacía pero el objetivo no. Con 0 queda desactivado.
  done_grace: 0,
}

// The compaction threshold opencode will use, when it is lower than the raw
// input limit: compaction.reserved is subtracted from limit.input.
const CONTEXT_LIMIT = 400000
const RESERVED = 20000
const COMPACT_AT = CONTEXT_LIMIT - RESERVED

function loadConfig() {
  const cfg = { ...DEFAULTS }
  try {
    if (existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"))
      for (const key of Object.keys(DEFAULTS)) {
        if (raw[key] !== undefined) cfg[key] = raw[key]
      }
    }
  } catch {
    // A broken config must not take the session down; defaults are safe.
  }
  return cfg
}

function clip(text, max) {
  const value = String(text ?? "").trim()
  if (value.length <= max) return value
  return value.slice(0, max) + "\n… (recortado)"
}

/**
 * The generated SDK returns either the bare value or `{ data: ... }` depending
 * on responseStyle, and the wire format is a plain array. Normalise all three
 * instead of betting on one.
 */
function unwrap(response, key) {
  if (Array.isArray(response)) return response
  if (response && Array.isArray(response.data)) return response.data
  if (response && response[key] !== undefined) {
    const inner = response[key]
    if (Array.isArray(inner)) return inner
  }
  return []
}

function humanTokens(n) {
  const value = Number(n) || 0
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(2) + "M"
  if (value >= 1000) return Math.round(value / 1000) + "k"
  return String(value)
}

export const ContinuityPlugin = async (ctx) => {
  const { client, $, directory, worktree } = ctx
  const cfg = loadConfig()
  const root = worktree || directory

  // Per-session bookkeeping.
  const stats = new Map()

  function slot(sessionID) {
    if (!stats.has(sessionID)) {
      stats.set(sessionID, {
        started: Date.now(),
        continues: 0,
        lastContinue: 0,
        stalls: 0,
        lastFingerprint: null,
        compactions: 0,
        lastError: null,
        lastEnrich: 0,
      })
    }
    return stats.get(sessionID)
  }

  async function log(level, message, extra) {
    try {
      await client.app.log({
        body: { service: "continuity", level, message, extra },
      })
    } catch {
      // Never let logging break a session.
    }
  }

  /** Run a git command in the project root, returning "" on any problem. */
  async function git(args) {
    try {
      const out = await $`git ${args}`.cwd(root).quiet()
      return (out.stdout?.toString() || "").trim()
    } catch {
      return ""
    }
  }

  /** The session's first user message: the goal, in the most durable form. */
  async function readGoal(sessionID) {
    try {
      const list = unwrap(await client.session.messages({ path: { id: sessionID } }))
      for (const entry of list) {
        if (entry?.info?.role !== "user") continue
        const text = (entry.parts || [])
          .filter((p) => p?.type === "text" && p?.text)
          .map((p) => p.text)
          .join("\n")
          .trim()
        if (!text) continue
        // Synthetic continuation prompts are not the goal.
        if (/^Continue if you have next steps$/i.test(text)) continue
        if (entry.info.synthetic) continue
        return text
      }
    } catch {
      // fall through
    }
    return ""
  }

  async function readTodos(sessionID) {
    try {
      return unwrap(await client.session.todo({ path: { id: sessionID } }))
    } catch {
      return []
    }
  }

  /** Ground truth to append to the compaction prompt. */
  async function buildHandoff(sessionID) {
    const parts = []
    const goal = await readGoal(sessionID)
    if (goal) {
      parts.push(
        "## Objetivo original de esta sesión\n" +
          "Es la primera instrucción que dio la persona. Si la sesión se reanuda " +
          "sin contexto, esto es lo que hay que conseguir:\n\n" +
          clip(goal, 1200),
      )
    }

    const todos = await readTodos(sessionID)
    const open = todos.filter((t) => t.status !== "completed")
    if (open.length) {
      const lines = open
        .slice(0, 20)
        .map((t) => `- [${t.status}] ${t.content}${t.priority ? ` (prioridad: ${t.priority})` : ""}`)
      parts.push(
        "## Qué falta (lista de tareas del agente)\n" +
          lines.join("\n") +
          (open.length > 20 ? `\n… y ${open.length - 20} más` : ""),
      )
    } else if (todos.length) {
      parts.push("## Tareas\nTodas las tareas de la lista están marcadas como completadas.")
    }

    const status = await git(["status", "--short", "--branch"])
    if (status) {
      parts.push(
        "## Estado del repositorio (sin commitear)\n" +
          "Esto es el trabajo a medio hacer. Es la fuente de verdad, no el chat:\n\n" +
          clip(status, 1500),
      )
    }

    const stat = await git(["diff", "--stat", "HEAD"])
    if (stat) {
      parts.push("## Cambios respecto de HEAD\n" + clip(stat, 1200))
    }

    const logLines = await git(["log", "--oneline", `-${cfg.recent_commits}`])
    if (logLines) {
      parts.push(
        "## Últimos commits\n" +
          logLines +
          "\n(Si el trabajo pedido ya está commiteado, no lo rehagás.)",
      )
    }

    return parts.join("\n\n")
  }

  /**
   * A cheap fingerprint of "did anything actually happen", to detect a stalled
   * session.
   *
   * The first version hashed HEAD + `git status` only, which made the detector
   * useless in two very common situations: a directory that is not a git repo
   * (git fails, the hash never changes, so every continue counted as a stall)
   * and a repo where the agent is legitimately reading/planning without writing
   * anything yet. Both cases produced the same result — the plugin stopped after
   * two continues and never ran again.
   *
   * So the signal is now two independent layers:
   *
   *   repo    — the working tree, when there is one. Real writes show up here.
   *   work    — the number of tool calls the session has actually performed.
   *             This moves whenever the agent does *anything*, including in a
   *             non-git directory, and it is the layer that survives compaction
   *             because it is derived from the session message list rather than
   *             from local files.
   *
   * `hash` is the pair, so a change in either layer counts as progress.
   */
  async function fingerprint(sessionID) {
    const head = await git(["rev-parse", "--short", "HEAD"])
    const inRepo = Boolean(head)
    const dirty = inRepo ? await git(["status", "--porcelain"]) : ""
    let repoHash = 0
    const repoText = (head || "no-repo") + "|" + dirty
    for (let i = 0; i < repoText.length; i++) {
      repoHash = (repoHash * 31 + repoText.charCodeAt(i)) | 0
    }

    const work = await countToolCalls(sessionID)
    return {
      head,
      inRepo,
      dirty: dirty.split("\n").filter(Boolean).length,
      work,
      repoHash,
      hash: repoHash + ":" + work,
    }
  }

  /**
   * How many tool calls this session has executed. It is a coarse progress
   * signal, not a metric: any tool call counts, so the number moves whenever
   * the agent does anything at all — including reading and planning in a
   * directory that is not a git repo, where the repo layer stays frozen.
   */
  async function countToolCalls(sessionID) {
    try {
      const list = unwrap(await client.session.messages({ path: { id: sessionID } }))
      let n = 0
      for (const entry of list) {
        for (const part of entry?.parts || []) {
          if (part?.type === "tool") n += 1
        }
      }
      return n
    } catch {
      // Unknown, not zero: a sentinel keeps the hash moving instead of pinning
      // it, which is what a real stall looks like.
      return -1
    }
  }

  /** Current context size, as opencode itself computes it. */
  async function readContextTokens(sessionID, eventTokens) {
    if (eventTokens) return eventTokens
    try {
      const list = unwrap(await client.session.messages({ path: { id: sessionID } }))
      for (let i = list.length - 1; i >= 0; i--) {
        const info = list[i]?.info
        if (info?.role !== "assistant") continue
        const total = info?.tokens?.total
        if (total) return total
      }
    } catch {
      // fall through
    }
    return 0
  }

  async function publish(sessionID, patch) {
    const s = slot(sessionID)
    const previous = readState(sessionID)

    // The event stream only tells us about changes, so a plugin that loads
    // mid-session would show zeroes until something happens. Enrich at most
    // once a minute to keep the gauge honest without polling the API.
    let enriched = { title: previous?.title, todos_pending: previous?.todos_pending, todos_total: previous?.todos_total }
    const stale = !previous?.updated ||
      Date.now() - Date.parse(previous.updated) > 60_000
    if (stale) {
      s.lastEnrich = Date.now()
      try {
        const info = await client.session.get({ path: { id: sessionID } })
        const title = info?.data?.title || info?.title
        if (title) enriched.title = title
      } catch {
        // Not fatal: the gauge just keeps the previous title.
      }
      try {
        const todos = await readTodos(sessionID)
        enriched.todos_total = todos.length
        enriched.todos_pending = todos.filter((t) => t.status !== "completed").length
      } catch {
        // Same.
      }
      pruneSessions()
    }

    const merged = {
      session_id: sessionID,
      title: patch?.title ?? enriched.title ?? "",
      tokens: patch?.tokens ?? previous?.tokens ?? 0,
      compact_at: COMPACT_AT,
      context_limit: CONTEXT_LIMIT,
      percent: 0,
      todos_pending: patch?.todos_pending ?? enriched.todos_pending ?? 0,
      todos_total: patch?.todos_total ?? enriched.todos_total ?? 0,
      compactions: s.compactions,
      continues: s.continues,
      max_continues: cfg.max_continues,
      auto_continue: cfg.auto_continue,
      stalled: s.stalls,
      last_error: s.lastError,
      updated: new Date().toISOString(),
    }
    merged.percent = merged.compact_at
      ? Math.min(100, Math.round((merged.tokens / merged.compact_at) * 100))
      : 0
    try {
      mkdirSync(SESSIONS_DIR, { recursive: true })
      writeFileSync(SESSION_FILE(sessionID), JSON.stringify(merged, null, 2) + "\n")
    } catch {
      // Non-fatal.
    }
  }

  function readState(sessionID) {
    try {
      return JSON.parse(readFileSync(SESSION_FILE(sessionID), "utf8"))
    } catch {
      return {}
    }
  }

  /** Borra los archivos de sesiones que ya no existen o están-coldos. */
  function pruneSessions() {
    try {
      const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"))
      const now = Date.now()
      for (const f of files) {
        const path = join(SESSIONS_DIR, f)
        try {
          if (now - statSync(path).mtimeMs > STALE_MS) unlinkSync(path)
        } catch {
          // Another process got there first.
        }
      }
    } catch {
      // Directory not created yet.
    }
  }

  async function toast(message, variant) {
    try {
      await client.tui.showToast({ body: { message, variant } })
    } catch {
      // No TUI attached (headless run): the log is enough.
    }
  }

  // ---- Compactación a pedido -------------------------------------------
  // El relay escribe compact-request.json; el plugin lo atiende y deja el
  // resultado en compact-result.json. Nada de esto requiere conocer el puerto
  // del server de opencode, así que funciona igual desde la barra o la bandeja.

  const compactState = { handled: "", heartbeat: 0 }

  /** Toca el marcador para que el relay sepa que hay un plugin vivo. */
  function heartbeat() {
    const now = Date.now()
    // 30s de granularity: alcanza para saber que el proceso está, y no
    // escribe en disco cada 3s.
    if (now - compactState.heartbeat < 30_000) return
    compactState.heartbeat = now
    try {
      mkdirSync(STATE_DIR, { recursive: true })
      writeFileSync(LOADED_FILE, JSON.stringify({
        loaded_at: new Date().toISOString(),
        beat_at: new Date().toISOString(),
        auto_continue: cfg.auto_continue,
        compact_at: COMPACT_AT,
        root,
      }, null, 2) + "\n")
    } catch {
      // Non-fatal.
    }
  }

  function writeCompactResult(payload) {
    try {
      mkdirSync(STATE_DIR, { recursive: true })
      writeFileSync(COMPACT_RESULT, JSON.stringify(payload, null, 2) + "\n")
    } catch {
      // Non-fatal.
    }
  }

  /** La sesión a compactar: la indicada, o la más recientemente actualizada. */
  function pickSession(requested) {
    if (requested) return requested
    try {
      const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"))
      let best = null
      let bestTime = ""
      for (const f of files) {
        const path = join(SESSIONS_DIR, f)
        try {
          const data = JSON.parse(readFileSync(path, "utf8"))
          if (!data.session_id) continue
          if ((data.updated || "") > bestTime) {
            bestTime = data.updated || ""
            best = data.session_id
          }
        } catch {
          continue
        }
      }
      return best
    } catch {
      return null
    }
  }

  async function checkCompactRequest() {
    let request
    try {
      request = JSON.parse(readFileSync(COMPACT_REQUEST, "utf8"))
    } catch {
      return
    }
    const id = request?.id
    if (!id || compactState.handled === id) return
    compactState.handled = id

    const sessionID = pickSession(request.session)
    if (!sessionID) {
      writeCompactResult({ id, ok: false, error: "no hay sesiones conocidas todavía" })
      return
    }
    try {
      await client.session.summarize({ path: { id: sessionID }, body: {} })
      writeCompactResult({ id, ok: true, session: sessionID, at: new Date().toISOString() })
      await log("info", "compactación manual", { sessionID })
      await toast("Contexto compactado")
    } catch (e) {
      const message = String(e?.message || e)
      writeCompactResult({ id, ok: false, session: sessionID, error: message, at: new Date().toISOString() })
      await log("error", "compactación manual falló", { sessionID, error: message })
      await toast("No se pudo compactar")
    }
  }

  /** Decide whether to push a stopped session forward, and do it. */
  async function maybeContinue(sessionID) {
    if (!cfg.auto_continue) return
    const s = slot(sessionID)

    if (Date.now() - s.started > cfg.max_minutes * 60_000) {
      await log("warn", "auto-continue: se alcanzó el límite de tiempo", { sessionID })
      await toast(`Continuidad: se alcanzó el límite de ${cfg.max_minutes} min`)
      return
    }
    if (s.continues >= cfg.max_continues) {
      await log("warn", "auto-continue: se agotaron los intentos", {
        sessionID,
        continues: s.continues,
      })
      await toast(`Continuidad: se agotaron los ${cfg.max_continues} intentos`)
      return
    }
    if (Date.now() - s.lastContinue < cfg.cooldown_seconds * 1000) return

    const todos = await readTodos(sessionID)
    const open = todos.filter((t) => t.status !== "completed")
    if (!open.length) {
      await log("info", "auto-continue: no queda nada pendiente", { sessionID })
      return
    }

    const now = await fingerprint(sessionID)
    const moved = s.lastFingerprint !== null && s.lastFingerprint !== now.hash
    if (!moved && s.lastFingerprint !== null) {
      s.stalls += 1
      await log("warn", "auto-continue: sin progreso", {
        sessionID,
        stalls: s.stalls,
        inRepo: now.inRepo,
        work: now.work,
      })
      if (s.stalls >= cfg.stall_limit) {
        await toast(`Continuidad: sin avance en ${s.stalls} intentos, me detengo`)
        await log("warn", "auto-continue: detenido por stagnation", {
          sessionID,
          stalls: s.stalls,
        })
        return
      }
    } else {
      s.stalls = 0
    }
    const resuming = s.lastFingerprint !== null
    s.lastFingerprint = now.hash
    s.lastContinue = Date.now()
    s.continues += 1

    const goal = await readGoal(sessionID)
    // El tono cambia según por qué se reanuda. La primera vez que el plugin
    // actúa en una sesión no hay por qué sospechar de nada raro: es el agente
    // terminando un turno. Cuando ya se reanudó varias veces, el mensaje tiene
    // que decirle qué hacer con la information que ya tiene, porque si no se
    // reimprime el plan y vuelve a detenerse en el mismo punto.
    const message = resuming
      ? "La sesión se detuvo sin avanzar. Esto ya pasó " +
        `${s.continues} veces.\n\n` +
        (goal ? `Objetivo original: ${clip(goal, 600)}\n\n` : "") +
        "Pendiente:\n" +
        open.slice(0, 10).map((t) => `- ${t.content}`).join("\n") +
        "\n\nHacé esto ahora, en este orden:\n" +
        "1. No vuelvas a planificar. Elegí la primera tarea pendiente de la " +
        "lista y empezá a ejecutarla.\n" +
        "2. Si una técnica falló dos veces, cambiala: leé el error, listá las " +
        "causas posibles y tomá la que no probaste. No repitas el mismo intento.\n" +
        "3. Si el error es del entorno (permisos, credenciales, un comando que " +
        "no existe), resolvelo o explicalo en el informe final, pero no te " +
        "detengas por eso.\n" +
        "4. Si creés que el objetivo ya está cumplido, marcalo así y seguí con " +
        "lo que quede de la lista.\n\n" +
        "No respondas con un plan ni con una pregunta. Actuá."
      : "La sesión quedó detenida y todavía hay trabajo pendiente.\n\n" +
        (goal ? `Objetivo original: ${clip(goal, 600)}\n\n` : "") +
        "Pendiente según tu propia lista de tareas:\n" +
        open.slice(0, 10).map((t) => `- ${t.content}`).join("\n") +
        "\n\nRetomá desde donde estabas. No repitas lo ya hecho: revisá el estado " +
        "real del repositorio antes de actuar. Si el objetivo ya está cumplido, " +
        "decilo y detenete."

    await log("info", "auto-continue: reanudando", {
      sessionID,
      continues: s.continues,
      pending: open.length,
      escalado: resuming,
      inRepo: now.inRepo,
      work: now.work,
    })
    try {
      await client.session.prompt({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text: message }] },
      })
      await publish(sessionID, { todos_pending: open.length, todos_total: todos.length })
    } catch (e) {
      s.lastError = String(e?.message || e)
      await log("error", "auto-continue: no se pudo reanudar", { error: s.lastError })
    }
  }

  // El panel no habla con el server de opencode, sino con el relay, que
  // escribe este archivo; el plugin lo atiende.
  setInterval(() => {
    heartbeat()
    checkCompactRequest().catch(() => {})
  }, 3000)

  // El marcador va PRIMERO y sin await delante: si client.app.log() se cuelga
  // (server lento o sin conexión) y lo awaited antes, el heartbeat no arrancó
  // nunca y el plugin parecía no haber cargado.
  compactState.heartbeat = 0
  heartbeat()

  log("info", "plugin inicializado", {
    auto_continue: cfg.auto_continue,
    compact_at: COMPACT_AT,
    root,
  }).catch(() => {})

  return {
    /** 1. Anchor every compaction to the repository, not to the chat. */
    "experimental.session.compacting": async (input, output) => {
      const sessionID = input?.sessionID
      if (!sessionID) return
      const s = slot(sessionID)
      s.compactions += 1
      try {
        const handoff = await buildHandoff(sessionID)
        if (handoff) {
          output.context.push(
            "## Estado real del proyecto (generado automáticamente)\n" +
              "Lo que sigue viene del repositorio y de tu lista de tareas, no del " +
              "historial de la conversación. Si el resumen de arriba se degrada o " +
              "se contradice, este bloque manda.\n\n" +
              clip(handoff, cfg.max_handoff_chars),
          )
        }
        await log("info", "handoff inyectado en la compactación", {
          sessionID,
          chars: handoff.length,
          compactions: s.compactions,
        })
        await publish(sessionID, {})
      } catch (e) {
        await log("error", "handoff: fallo", { error: String(e?.message || e) })
      }
    },

    /** 2. Keep the loop going when the agent stops with work open. */
    event: async ({ event }) => {
      if (!event?.type) return

      if (event.type === "session.idle") {
        const sessionID = event.properties?.sessionID
        if (sessionID) await maybeContinue(sessionID)
        return
      }

      if (event.type === "session.error") {
        const sessionID = event.properties?.sessionID
        const message = String(
          event.properties?.error?.data?.message ||
            event.properties?.error?.name ||
            "",
        )
        const s = slot(sessionID)
        s.lastError = message || s.lastError
        if (/rate limit|429/i.test(message)) {
          await log("info", "rate limit en la sesión", { sessionID, message })
        }
        return
      }

      if (event.type === "session.compacted") {
        const sessionID = event.properties?.sessionID
        if (sessionID) {
          await log("info", "sesión compactada", { sessionID })
          await publish(sessionID, {})
        }
        return
      }

      if (event.type === "todo.updated") {
        const sessionID = event.properties?.sessionID
        if (sessionID) await publish(sessionID, {})
        return
      }

      // Keep the context gauge fresh without hammering the API.
      if (event.type === "message.updated") {
        const info = event.properties?.info
        if (info?.role === "assistant" && info?.tokens) {
          const sessionID = info.sessionID
          const tokens = info.tokens.total ||
            (info.tokens.input || 0) + (info.tokens.output || 0) +
              ((info.tokens.cache?.read) || 0)
          if (sessionID && tokens) await publish(sessionID, { tokens })
        }
      }
    },
  }
}
