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
    /** Candidates it could be reassigned to. */
    otherAgents: string[]
    /** Most recent last. */
    recentDecisions: { kind: string; detail: string }[]
}

const MODELS = ["gpt-5.1", "gpt-4.1-mini"]
const TIMEOUT_MS = 6000
const MAX_CHARS = 220

const SYSTEM_PROMPT =
    "You are the supervisor of a team of coding agents. A task's agent has gone silent and you are reclaiming it. " +
    "In ONE or TWO terse sentences (max 200 characters total), state what you think happened and what you are doing about it, " +
    "naming the task, the silent agent, and the agent you hand it to (if any). " +
    "Plain text only: no preamble, no bullets, no markdown, no quotes."

function seconds(ms: number): string {
    const s = ms / 1000
    return s >= 10 ? String(Math.round(s)) : s.toFixed(1)
}

/** Deterministic sentence built purely from ctx. */
export function fallbackReclaim(ctx: ReclaimContext): string {
    const next = ctx.otherAgents[0]
    const tries = ctx.attempts === 1 ? "one attempt" : `${ctx.attempts} attempts`
    const tail = next ? `handing "${ctx.taskTitle}" to ${next}.` : `putting "${ctx.taskTitle}" back up for grabs.`
    return `${ctx.agent} has been silent for ${seconds(ctx.silentForMs)}s on ${ctx.taskId} after ${tries} — ${tail}`
}

function buildUserPrompt(ctx: ReclaimContext): string {
    const recent = ctx.recentDecisions
        .slice(-4)
        .map((d) => `- ${d.kind}: ${d.detail}`.slice(0, 140))
        .join("\n")
    return [
        `Task ${ctx.taskId}: "${ctx.taskTitle}"`,
        `Files: ${ctx.files.slice(0, 6).join(", ") || "none"}`,
        `Silent agent: ${ctx.agent}, quiet for ${seconds(ctx.silentForMs)}s, attempts so far: ${ctx.attempts}`,
        `Other agents available: ${ctx.otherAgents.join(", ") || "none"}`,
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
