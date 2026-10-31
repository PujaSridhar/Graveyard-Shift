import { actors } from "../generated/index.js"
import { decomposeGoal, fallbackDecompose } from "../../actor/src/reasoning.ts"

/**
 * Resets the demo to a known starting state. Run this before every rehearsal
 * and before the live demo, so the run is identical every time.
 * Pass a custom goal string on the CLI to decompose it live with OpenAI.
 */

const JOB_ID = process.env.JOB_ID ?? "demo"
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS ?? 3_000)
// Must comfortably exceed a worker's full cycle. Each Agent Relay CLI call
// takes 4-7s, so a list + post + sleep round trip is ~11s; at 12s the
// supervisor reclaimed healthy agents that were simply waiting on Relay.
// The demo's reclaim is triggered on cue by the Stall button, not by waiting.
const STALL_AFTER_MS = Number(process.env.STALL_AFTER_MS ?? 30_000)
const goalArg = process.argv.slice(2).join(" ").trim()

const job = actors.JobSupervisor.get(JOB_ID)
const tasks = goalArg ? await decomposeGoal(goalArg) : fallbackDecompose()

const view = await job.submitJob(tasks, { heartbeatMs: HEARTBEAT_MS, stallAfterMs: STALL_AFTER_MS })
if (goalArg) {
    await job.reportProgress("supervisor", "task-1", `ai planner decomposed goal: "${goalArg}" into ${view.tasks.length} tasks`)
}

console.log(`seeded job "${JOB_ID}" — ${view.tasks.length} tasks`)
console.log(`  heartbeat every ${HEARTBEAT_MS}ms, stall threshold ${STALL_AFTER_MS}ms`)
for (const t of view.tasks) console.log(`  ${t.id}  ${t.title}  [${t.files.join(", ")}]`)
