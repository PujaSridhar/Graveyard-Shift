/**
 * Live LLM reasoning for the supervisor's reclaim decision.
 *
 * Plain module-scope functions (the "every method must be async" rule only
 * applies to actor classes). No top-level await, no Node-only APIs: global
 * fetch + TextDecoder only. The API key is read from the environment and is
 * never logged.
 */

export type ReclaimContext = {
    taskId: string
    taskTitle: string
    files: string[]
    /** The agent that went quiet. */
    agent: string
    silentForMs: number
    attempts: number
    /** Last progress note reported by the stalled agent before going silent. */
    lastProgressNote?: string
    /** Concrete git diff summary (e.g. "after adding verifyToken() — 18 lines modified in src/auth.ts"). */
    diffSummary?: string
    /** Unified git diff patch from the workspace. */
    diffPatch?: string
    /** Candidates it could be reassigned to. */
    otherAgents: string[]
    /** Most recent last. */
    recentDecisions: { kind: string; detail: string }[]
}

export type DecomposedTask = {
    title: string
    files: string[]
}

const MODELS = ["gpt-5.1", "gpt-4.1-mini"]
const TIMEOUT_MS = 6000
const MAX_CHARS = 220

const SYSTEM_PROMPT =
    "You are the supervisor of a team of coding agents. A task's agent has gone silent and you are reclaiming it. " +
    "In ONE or TWO terse sentences (max 200 characters total), state what the agent was doing when it stalled — " +
    "MUST cite the exact function name and modified line count from the git diff if provided (e.g. 'codex stalled after adding verifyToken() — 18 lines modified in src/auth.ts') — " +
    "and name the agent you are handing the task to. " +
    "Plain text only: no preamble, no bullets, no markdown, no quotes."

function seconds(ms: number): string {
    const s = ms / 1000
    return s >= 10 ? String(Math.round(s)) : s.toFixed(1)
}

/** Deterministic sentence built purely from ctx. */
export function fallbackReclaim(ctx: ReclaimContext): string {
    const next = ctx.otherAgents[0]
    const diffCite = ctx.diffSummary
        ? ` ${ctx.diffSummary}`
        : ctx.lastProgressNote
          ? ` while ${ctx.lastProgressNote}`
          : ` after ${seconds(ctx.silentForMs)}s of silence`
    const tail = next
        ? `reclaiming ${ctx.taskId} and steering ${next} to finish it.`
        : `putting "${ctx.taskTitle}" back up for grabs.`
    return `${ctx.agent} stalled${diffCite} — ${tail}`
}

/** Builds the Agent Relay DM steer payload sent to the surviving agent. */
export function buildSteerMessage(ctx: ReclaimContext, diagnosis: string): string {
    const files = ctx.files.length > 0 ? ` [${ctx.files.join(", ")}]` : ""
    const diffInfo = ctx.diffSummary ? ` Uncommitted diff: ${ctx.diffSummary}.` : ""
    return `STEER ${ctx.taskId}${files} — "${ctx.taskTitle}".${diffInfo} Supervisor: ${diagnosis}`
}

function buildUserPrompt(ctx: ReclaimContext): string {
    const recent = ctx.recentDecisions
        .slice(-4)
        .map((d) => `- ${d.kind}: ${d.detail}`.slice(0, 140))
        .join("\n")
    return [
        `Task ${ctx.taskId}: "${ctx.taskTitle}"`,
        `Files locked: ${ctx.files.slice(0, 6).join(", ") || "none"}`,
        `Silent agent: ${ctx.agent}, quiet for ${seconds(ctx.silentForMs)}s, attempts so far: ${ctx.attempts}`,
        ctx.diffSummary ? `Git diff stat: ${ctx.diffSummary}` : "",
        ctx.diffPatch ? `Git diff patch:\n${ctx.diffPatch}` : "",
        ctx.lastProgressNote ? `Last checkpoint before stall: "${ctx.lastProgressNote}"` : "",
        `Other agents available to steer via Agent Relay: ${ctx.otherAgents.join(", ") || "none"}`,
        recent ? `Recent decisions:\n${recent}` : "",
    ]
        .filter(Boolean)
        .join("\n")
}

function safeEmit(onToken: (chunk: string) => void, chunk: string): void {
    try {
        onToken(chunk)
    } catch {
        // A broken sink must never break the supervisor.
    }
}

/** Stream one model. Returns text so far; throws on failure (caller catches). */
async function streamModel(
    model: string,
    ctx: ReclaimContext,
    apiKey: string,
    signal: AbortSignal,
    onChunk: (chunk: string) => void,
): Promise<void> {
    const body: Record<string, unknown> = {
        model,
        stream: true,
        max_completion_tokens: 90,
        messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildUserPrompt(ctx) },
        ],
    }
    if (model.startsWith("gpt-5")) body.reasoning_effort = "none"
    else body.temperature = 0.4

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal,
    })
    if (!res.ok || !res.body) throw new Error(`openai http ${res.status}`)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim()
            buf = buf.slice(nl + 1)
            if (!line.startsWith("data:")) continue
            const data = line.slice(5).trim()
            if (data === "[DONE]") return
            try {
                const delta = JSON.parse(data)?.choices?.[0]?.delta?.content
                if (typeof delta === "string" && delta) onChunk(delta)
            } catch {
                // ignore malformed keep-alive lines
            }
        }
    }
}

/**
 * Streams a short explanation. Calls onToken with each chunk as it arrives.
 * Resolves with the complete text. Never throws: on any failure (no key,
 * network error, timeout, empty reply) it returns a deterministic fallback
 * and still calls onToken with it.
 */
export async function explainReclaim(
    ctx: ReclaimContext,
    onToken: (chunk: string) => void,
): Promise<string> {
    let text = ""
    try {
        const apiKey = process.env.OPENAI_API_KEY
        if (!apiKey) throw new Error("no api key")

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
        try {
            for (const model of MODELS) {
                try {
                    await streamModel(model, ctx, apiKey, controller.signal, (chunk) => {
                        // Hard cap so a rambling model can't overflow the projector.
                        const room = MAX_CHARS - text.length
                        if (room <= 0) return
                        const piece = chunk.slice(0, room)
                        text += piece
                        safeEmit(onToken, piece)
                    })
                    break
                } catch (err) {
                    // Retry the next model only if nothing was streamed yet and we still have time.
                    if (text.length > 0 || controller.signal.aborted) break
                }
            }
        } finally {
            clearTimeout(timer)
        }
    } catch {
        // fall through to fallback
    }

    const out = text.trim()
    if (out) return out
    const fb = fallbackReclaim(ctx)
    safeEmit(onToken, fb)
    return fb
}

const DECOMPOSE_PROMPT =
    "You are the Graveyard Shift task planner for a multi-agent coding team. " +
    "Break the user's engineering goal into exactly 4 concrete coding tasks. " +
    "Make task 1 and task 2 share at least one file path so the supervisor's file-lock collision guard is exercised, " +
    "while task 3 and task 4 touch independent files. " +
    'Return ONLY a JSON array of 4 objects: [{"title":"short imperative title","files":["src/path.ts"]}]. No markdown fences.'

export function fallbackDecompose(goal?: string): DecomposedTask[] {
    const g = (goal ?? "").trim()
    if (!g) {
        return [
            { title: "refactor the auth middleware", files: ["src/auth.ts", "src/session.ts"] },
            { title: "tighten session token expiry", files: ["src/auth.ts", "src/token.ts"] },
            { title: "add retries to the fetch client", files: ["src/http.ts"] },
            { title: "write tests for the parser", files: ["src/parse.test.ts"] },
        ]
    }
    const slug =
        g
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .split("-")
            .slice(0, 2)
            .join("-") || "core"
    return [
        { title: `implement ${g.slice(0, 42)} core logic`, files: [`src/${slug}.ts`, `src/types.ts`] },
        { title: `wire validation & guards for ${slug}`, files: [`src/${slug}.ts`, `src/guard.ts`] },
        { title: `add telemetry & retry instrumentation`, files: [`src/telemetry.ts`] },
        { title: `add integration tests for ${slug}`, files: [`src/${slug}.test.ts`] },
    ]
}

export async function decomposeGoal(goal: string): Promise<DecomposedTask[]> {
    const trimmed = goal.trim()
    if (!trimmed) return fallbackDecompose()
    try {
        const apiKey = process.env.OPENAI_API_KEY
        if (!apiKey) return fallbackDecompose(trimmed)

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 5500)
        try {
            const res = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
                body: JSON.stringify({
                    model: "gpt-4.1-mini",
                    temperature: 0.3,
                    max_completion_tokens: 260,
                    messages: [
                        { role: "system", content: DECOMPOSE_PROMPT },
                        { role: "user", content: trimmed },
                    ],
                }),
                signal: controller.signal,
            })
            if (!res.ok) return fallbackDecompose(trimmed)
            const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
            const raw = data.choices?.[0]?.message?.content?.trim() ?? ""
            const start = raw.indexOf("[")
            const end = raw.lastIndexOf("]")
            if (start >= 0 && end > start) {
                const parsed = JSON.parse(raw.slice(start, end + 1)) as DecomposedTask[]
                if (Array.isArray(parsed) && parsed.length >= 2) {
                    return parsed.slice(0, 5).map((t, i) => ({
                        title: String(t.title || `task ${i + 1}`).slice(0, 70),
                        files: Array.isArray(t.files) && t.files.length > 0 ? t.files.map(String).slice(0, 3) : [`src/mod-${i + 1}.ts`],
                    }))
                }
            }
        } finally {
            clearTimeout(timer)
        }
    } catch {
        // fall through to deterministic decomposition
    }
    return fallbackDecompose(trimmed)
}
