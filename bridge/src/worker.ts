import { listMessages, post, newerThan } from "./relay.js"

/**
 * A worker agent. Its own process, its own Relay identity, real messages.
 *
 * It reads the channel to learn which tasks exist and which are already taken,
 * claims a free one, and reports progress on a timer. If the supervisor refuses
 * its claim — because another agent got there first — it backs off and takes a
 * different task. That negotiation happens entirely in the channel, with no
 * shared memory between the two processes.
 *
 * Pass --die-after <n> to stop reporting mid-task, which is what a stalled or
 * crashed coding agent looks like from the supervisor's side.
 */

function loadEnv(): Record<string, string> {
    const out: Record<string, string> = {}
    try {
        const text = require("node:fs").readFileSync(`${import.meta.dir}/../../.env`, "utf8") as string
        for (const line of text.split("\n")) {
            const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
            if (m) out[m[1]!] = m[2]!.trim()
        }
    } catch {
        /* fall through */
    }
    return out
}

const env = { ...loadEnv(), ...process.env } as Record<string, string>
const CHANNEL = env.RELAY_CHANNEL ?? "taskboard"

const args = process.argv.slice(2)
const ME = args.find((a) => !a.startsWith("--")) ?? "codex"
const dieIdx = args.indexOf("--die-after")
const DIE_AFTER = dieIdx >= 0 ? Number(args[dieIdx + 1]) : Infinity
const TICK_MS = Number(env.WORKER_TICK_MS ?? 2_500)

const TOKENS: Record<string, string | undefined> = {
    codex: env.RELAY_CODEX_TOKEN,
    "claude-code": env.RELAY_CLAUDE_TOKEN,
}
const token = TOKENS[ME]
if (!token) {
    console.error(`no token for "${ME}" — expected one of ${Object.keys(TOKENS).join(", ")}`)
    process.exit(1)
}

const NOTES = [
    "reading the existing implementation",
    "sketching the change",
    "editing the module",
    "running the tests",
    "cleaning up the diff",
]

let highWater = "0"
let myTask: string | null = null
let ticks = 0
let wentQuiet = false

const known = new Map<string, string>() // taskId -> title
const taken = new Set<string>() // claimed by anyone, including me
const refusedIds = new Set<string>() // the supervisor told us no; only a reclaim clears it

/** Read the channel and update our picture of who owns what. */
async function observe(): Promise<void> {
    const messages = await listMessages(CHANNEL, token!, 40)
    const fresh = messages.filter((m) => newerThan(m.id, highWater)).reverse()
    for (const m of fresh) highWater = m.id

    for (const m of fresh) {
        const text = m.text

        if (m.from.name === "supervisor") {
            // A fresh board means a new run: forget everything we learned from
            // the previous one, or stale claims make every task look taken.
            if (/^OPEN TASKS/im.test(text)) {
                known.clear()
                taken.clear()
                refusedIds.clear()
                myTask = null
                ticks = 0
                wentQuiet = false
                console.log("  new board posted — resetting my view")
            }
            // The opening board: "task-1: title [files]" per line.
            for (const line of text.split("\n")) {
                const open = line.match(/^(task-\d+):\s*(.+?)\s*(?:\[|$)/i)
                if (open) known.set(open[1]!.toLowerCase(), open[2]!.trim())
            }
            // A refusal aimed at an agent: if it's a file lock, the task is still unclaimed; if aimed at us, back off.
            const refused = text.match(/^@([\w-]+) cannot take (task-\d+)\s*—\s*(.+)$/i)
            if (refused) {
                const who = refused[1]!.toLowerCase()
                const id = refused[2]!.toLowerCase()
                const reason = refused[3]!.trim()
                if (/file lock/i.test(reason)) {
                    taken.delete(id)
                } else {
                    taken.add(id)
                }
                if (who === ME.toLowerCase()) {
                    refusedIds.add(id)
                    if (myTask === id) {
                        console.log(`  refused ${id} (${reason}) — backing off to another task`)
                        myTask = null
                        ticks = 0
                    }
                }
            }
            // A completed task releases any file locks it held, so retry previously lock-blocked tasks.
            const completed = text.match(/^COMPLETED.*?(task-\d+)/i)
            if (completed) {
                const id = completed[1]!.toLowerCase()
                taken.add(id)
                refusedIds.clear()
            }
            // A reclaim puts a task back on the market, for everyone (except the agent that just stalled).
            const reclaimed = text.match(/RECLAIMED\s*—\s*(\S+)\s+went quiet.*?(task-\d+)/i)
            if (reclaimed) {
                const stalledAgent = reclaimed[1]!.toLowerCase()
                const id = reclaimed[2]!.toLowerCase()
                if (stalledAgent === ME.toLowerCase()) {
                    wentQuiet = true
                    myTask = id
                    console.log(`  *** supervisor reclaimed ${id} from me — staying offline ***`)
                } else {
                    taken.delete(id)
                    refusedIds.clear()
                    known.set(id, known.get(id) ?? id)
                }
            }
            continue
        }

        // Someone else claiming marks that task as taken.
        const claim = text.match(/^\s*CLAIM\s+(task-\d+)/i)
        if (claim) taken.add(claim[1]!.toLowerCase())

        const done = text.match(/^\s*DONE\s+(task-\d+)/i)
        if (done) taken.add(done[1]!.toLowerCase())
    }
}

function nextFreeTask(): string | null {
    for (const id of [...known.keys()].sort()) {
        if (!taken.has(id) && !refusedIds.has(id)) return id
    }
    return null
}

async function main(): Promise<void> {
    const quietNote = DIE_AFTER < Infinity ? `, going quiet after ${DIE_AFTER} reports` : ""
    console.log(`${ME} online — watching "${CHANNEL}"${quietNote}`)

    for (;;) {
        try {
            await observe()

            if (!myTask) {
                const pick = nextFreeTask()
                if (pick) {
                    myTask = pick
                    taken.add(pick)
                    ticks = 0
                    wentQuiet = false
                    await post(CHANNEL, `CLAIM ${pick}`, token!)
                    console.log(
                        `  claiming ${pick} — ${known.get(pick) ?? ""}` +
                            `  [board: ${[...known.keys()].sort().join(",")} | taken: ${[...taken].sort().join(",") || "none"}]`,
                    )
                }
            } else if (ticks < DIE_AFTER) {
                const note = NOTES[Math.min(ticks, NOTES.length - 1)]!
                await post(CHANNEL, `PROGRESS ${myTask} — ${note}`, token!)
                console.log(`  ${myTask} progress ${ticks + 1}: ${note}`)
                ticks++
                if (ticks >= NOTES.length) {
                    await post(CHANNEL, `DONE ${myTask} — change landed`, token!)
                    console.log(`  completed ${myTask}`)
                    myTask = null
                    ticks = 0
                }
            } else if (!wentQuiet) {
                wentQuiet = true
                console.log(`  *** going quiet on ${myTask} — no more reports from me ***`)
            }
        } catch (err) {
            console.error("  worker error:", err instanceof Error ? err.message : err)
        }
        await new Promise((r) => setTimeout(r, TICK_MS))
    }
}

main()
