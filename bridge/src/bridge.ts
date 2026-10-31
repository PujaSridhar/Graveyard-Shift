import { actors } from "../generated/index.js"
import { listMessages, post, dm, newerThan, type RelayMessage } from "./relay.js"
import { explainReclaim, buildSteerMessage, type ReclaimContext } from "../../actor/src/reasoning.ts"

/**
 * The bridge between the agents and the supervisor.
 *
 * Agents are separate processes that talk on a Relay channel. They do not call
 * the actor directly — they say what they are doing, in a channel a human can
 * read, and the bridge turns that into supervisor calls. Traffic flows both
 * ways: when the supervisor reclaims a task, the bridge announces it so the
 * agents find out the same way a teammate would.
 */

// -------------------------------------------------------------------- config

function loadEnvFile(path: string): Record<string, string> {
    const out: Record<string, string> = {}
    try {
        const text = require("node:fs").readFileSync(path, "utf8") as string
        for (const line of text.split("\n")) {
            const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
            if (m) out[m[1]!] = m[2]!.trim()
        }
    } catch {
        // fall through to process.env
    }
    return out
}

// Relay tokens live at the repo root; the model key lives with the actor.
const env = {
    ...loadEnvFile(`${import.meta.dir}/../../.env`),
    ...loadEnvFile(`${import.meta.dir}/../../actor/.env`),
    ...process.env,
} as Record<string, string>

// reasoning.ts reads process.env directly, so make the key visible to it here.
// The key stays in this process and never reaches the actor or durable state.
if (env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY) {
    process.env.OPENAI_API_KEY = env.OPENAI_API_KEY
}

const CHANNEL = env.RELAY_CHANNEL ?? "taskboard"
const SUPERVISOR_TOKEN = env.RELAY_SUPERVISOR_TOKEN
const JOB_ID = env.JOB_ID ?? "demo"
const POLL_MS = Number(env.BRIDGE_POLL_MS ?? 1_000)

if (!SUPERVISOR_TOKEN) {
    console.error("missing RELAY_SUPERVISOR_TOKEN in .env")
    process.exit(1)
}

const job = actors.JobSupervisor.get(JOB_ID)

// ------------------------------------------------------------------ protocol

type Command =
    | { kind: "claim"; taskId: string }
    | { kind: "progress"; taskId: string; note: string }
    | { kind: "done"; taskId: string; summary: string }

/**
 * Agents speak in plain sentences that happen to start with a keyword, so the
 * channel stays readable by a human watching the demo.
 */
function parse(text: string): Command | null {
    const claim = text.match(/^\s*CLAIM\s+(task-\d+)/i)
    if (claim) return { kind: "claim", taskId: claim[1]!.toLowerCase() }

    const progress = text.match(/^\s*PROGRESS\s+(task-\d+)\s*[:\-—]?\s*(.*)$/i)
    if (progress) return { kind: "progress", taskId: progress[1]!.toLowerCase(), note: progress[2]!.trim() || "working" }

    const done = text.match(/^\s*DONE\s+(task-\d+)\s*[:\-—]?\s*(.*)$/i)
    if (done) return { kind: "done", taskId: done[1]!.toLowerCase(), summary: done[2]!.trim() || "finished" }

    return null
}

// ------------------------------------------------------------------- the loop

let highWater = "0"
let announcedDecisions = 0
let lastStartedAt = 0

async function drainInbound(): Promise<void> {
    const messages = await listMessages(CHANNEL, SUPERVISOR_TOKEN!, 50)
    // Relay returns newest first; process oldest first so order is causal.
    const fresh = messages.filter((m) => newerThan(m.id, highWater)).reverse()

    for (const msg of fresh) {
        highWater = newerThan(msg.id, highWater) ? msg.id : highWater
        if (msg.from.name === "supervisor") continue

        const cmd = parse(msg.text)
        if (!cmd) continue
        await apply(msg, cmd)
    }
}

async function apply(msg: RelayMessage, cmd: Command): Promise<void> {
    const agent = msg.from.name
    switch (cmd.kind) {
        case "claim": {
            const res = await job.claimTask(agent, cmd.taskId)
            if (!res.ok) {
                await post(CHANNEL, `@${agent} cannot take ${cmd.taskId} — ${res.reason}`, SUPERVISOR_TOKEN!)
                console.log(`  refused ${agent} -> ${cmd.taskId}: ${res.reason}`)
            } else {
                console.log(`  ${agent} claimed ${cmd.taskId}`)
            }
            return
        }
        case "progress":
            await job.reportProgress(agent, cmd.taskId, cmd.note)
            console.log(`  ${agent} progress on ${cmd.taskId}`)
            return
        case "done":
            await job.completeTask(agent, cmd.taskId, cmd.summary)
            await post(CHANNEL, `COMPLETED — ${agent} finished ${cmd.taskId}. File locks released.`, SUPERVISOR_TOKEN!)
            console.log(`  ${agent} completed ${cmd.taskId}`)
            return
    }
}

/** Push supervisor decisions back out, so agents hear about reclaims and new boards. */
async function drainOutbound(): Promise<void> {
    const view = await job.snapshot()

    // Whenever a fresh job is submitted (via seed.ts or dashboard UI), announce the new board!
    if (view.startedAt > 0 && view.startedAt !== lastStartedAt && view.tasks.length > 0) {
        const isReset = lastStartedAt > 0
        lastStartedAt = view.startedAt
        if (isReset) announcedDecisions = 0
        const open = view.tasks.filter((t) => t.state === "pending")
        if (open.length > 0) {
            const lines = open.map((t) => `${t.id}: ${t.title} [${t.files.join(", ")}]`).join("\n")
            await post(CHANNEL, `OPEN TASKS\n${lines}`, SUPERVISOR_TOKEN!)
            console.log(`  announced fresh board (${open.length} tasks) for job started at ${view.startedAt}`)
        }
    }

    if (view.decisions.length < announcedDecisions) {
        announcedDecisions = 0
    }
    const newDecisions = view.decisions.slice(announcedDecisions)
    announcedDecisions = view.decisions.length

    for (const d of newDecisions) {
        if (d.kind !== "reclaimed") continue
        await post(CHANNEL, `RECLAIMED — ${d.detail}. It is open again.`, SUPERVISOR_TOKEN!)
        console.log(`  announced reclaim: ${d.detail}`)
        enqueueReasoning(d.detail, view)
    }
}

let reasoningQueue: Promise<void> = Promise.resolve()

function enqueueReasoning(detail: string, view: Awaited<ReturnType<typeof job.snapshot>>): void {
    reasoningQueue = reasoningQueue.then(() => streamReasoning(detail, view)).catch(() => {})
}

function findOtherAgents(view: Awaited<ReturnType<typeof job.snapshot>>, silentAgent: string): string[] {
    const seen = new Set<string>()
    for (const t of view.tasks) {
        if (t.assignee && t.assignee !== silentAgent) seen.add(t.assignee)
    }
    for (const d of view.decisions) {
        const m = d.detail.match(/^([\w.-]+) (?:claimed|on|finished)\b/)
        if (m && m[1] && m[1] !== silentAgent && m[1] !== "supervisor" && m[1] !== "lock") {
            seen.add(m[1])
        }
    }
    if (seen.size === 0) {
        seen.add(silentAgent === "claude-code" ? "codex" : "claude-code")
    }
    return [...seen]
}

function findLastProgressNote(view: Awaited<ReturnType<typeof job.snapshot>>, agent: string, taskId: string): string | undefined {
    const prefix = `${agent} on ${taskId}: `
    for (let i = view.decisions.length - 1; i >= 0; i--) {
        const d = view.decisions[i]!
        if (d.kind === "progress" && d.detail.startsWith(prefix)) {
            return d.detail.slice(prefix.length).trim()
        }
    }
    return undefined
}

/**
 * Ask the model to explain the reclaim, streaming each chunk into the actor so
 * the dashboard renders it live, then steer the surviving agent via Agent Relay DM.
 */
async function streamReasoning(detail: string, view: Awaited<ReturnType<typeof job.snapshot>>): Promise<void> {
    const parsed = detail.match(/^(\S+) went quiet for (\d+)s on (task-\d+)/)
    if (!parsed) return

    const [, agent, silentSecs, taskId] = parsed
    const task = view.tasks.find((t) => t.id === taskId)
    if (!task) return

    const others = findOtherAgents(view, agent!)
    const lastProgressNote = findLastProgressNote(view, agent!, taskId!)
    const ctx: ReclaimContext = {
        taskId: taskId!,
        taskTitle: task.title,
        files: task.files,
        agent: agent!,
        silentForMs: Number(silentSecs) * 1000,
        attempts: task.attempts,
        lastProgressNote,
        otherAgents: others,
        recentDecisions: view.decisions.slice(-8).map((x) => ({ kind: x.kind, detail: x.detail })),
    }

    try {
        await job.startReasoning(taskId!)
        const started = Date.now()
        let first = 0
        let full = ""
        let lastPush = 0
        let chain: Promise<unknown> = Promise.resolve()

        const diagnosis = await explainReclaim(ctx, (chunk) => {
            if (!first) first = Date.now() - started
            full += chunk
            const now = Date.now()
            if (now - lastPush < 70) return
            lastPush = now
            const text = full
            chain = chain.then(() => job.setReasoningText(text)).catch(() => {})
        })

        chain = chain.then(() => job.setReasoningText(full || diagnosis)).catch(() => {})
        await chain
        await job.finishReasoning()
        console.log(`  reasoning streamed (first token ${first}ms, total ${Date.now() - started}ms)`)

        // Steer the surviving agent via Agent Relay DM with handoff context!
        const nextAgent = others[0]
        if (nextAgent) {
            const steerText = buildSteerMessage(ctx, diagnosis)
            const chkInfo = lastProgressNote ? ` (checkpoint: "${lastProgressNote}")` : ""
            await job.reportProgress(
                "supervisor",
                taskId!,
                `relay dm [steer] → @${nextAgent}: take over ${taskId} [${task.files.join(", ")}]${chkInfo}`,
            )
            await dm(nextAgent, steerText, SUPERVISOR_TOKEN!, "steer").catch(() => {})
            console.log(`  steered @${nextAgent} via Agent Relay DM for ${taskId}`)
        }
    } catch (err) {
        console.error("  reasoning failed:", err instanceof Error ? err.message : err)
        await job.finishReasoning().catch(() => {})
    }
}

async function tick(): Promise<void> {
    try {
        await drainInbound()
        await drainOutbound()
    } catch (err) {
        console.error("  tick failed:", err instanceof Error ? err.message : err)
    }
}

async function main(): Promise<void> {
    console.log(`bridge up — channel "${CHANNEL}", job "${JOB_ID}", polling ${POLL_MS}ms`)
    // Ignore anything already on the board when we start.
    const existing = await listMessages(CHANNEL, SUPERVISOR_TOKEN!, 50)
    for (const m of existing) if (newerThan(m.id, highWater)) highWater = m.id
    const view = await job.snapshot()
    announcedDecisions = view.decisions.length
    console.log(`  skipping ${existing.length} existing messages, ${announcedDecisions} existing decisions`)

    for (;;) {
        await tick()
        await new Promise((r) => setTimeout(r, POLL_MS))
    }
}

main().catch((err) => {
    console.error("bridge died:", err)
    process.exitCode = 1
})
