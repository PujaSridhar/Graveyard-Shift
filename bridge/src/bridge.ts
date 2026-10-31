import { actors } from "../generated/index.js"
import { listMessages, post, newerThan, type RelayMessage } from "./relay.js"

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

function loadEnv(): Record<string, string> {
    const path = `${import.meta.dir}/../../.env`
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

const env = { ...loadEnv(), ...process.env } as Record<string, string>

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
let seededBoard = false

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
            console.log(`  ${agent} completed ${cmd.taskId}`)
            return
    }
}

/** Push supervisor decisions back out, so agents hear about reclaims. */
async function drainOutbound(): Promise<void> {
    const view = await job.snapshot()

    if (!seededBoard && view.tasks.length > 0) {
        seededBoard = true
        const open = view.tasks.filter((t) => t.state === "pending")
        if (open.length > 0) {
            const lines = open.map((t) => `${t.id}: ${t.title} [${t.files.join(", ")}]`).join("\n")
            await post(CHANNEL, `OPEN TASKS\n${lines}`, SUPERVISOR_TOKEN!)
        }
    }

    const newDecisions = view.decisions.slice(announcedDecisions)
    announcedDecisions = view.decisions.length

    for (const d of newDecisions) {
        if (d.kind !== "reclaimed") continue
        await post(CHANNEL, `RECLAIMED — ${d.detail}. It is open again.`, SUPERVISOR_TOKEN!)
        console.log(`  announced reclaim: ${d.detail}`)
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
