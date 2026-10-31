import { actors } from "../generated/index.js"

/**
 * Resets the demo to a known starting state. Run this before every rehearsal
 * and before the live demo, so the run is identical every time.
 */

const JOB_ID = process.env.JOB_ID ?? "demo"
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS ?? 3_000)
const STALL_AFTER_MS = Number(process.env.STALL_AFTER_MS ?? 10_000)

const job = actors.JobSupervisor.get(JOB_ID)

const view = await job.submitJob(
    [
        { title: "refactor the auth middleware", files: ["src/auth.ts"] },
        { title: "add retries to the fetch client", files: ["src/http.ts"] },
        { title: "write tests for the parser", files: ["src/parse.test.ts"] },
    ],
    { heartbeatMs: HEARTBEAT_MS, stallAfterMs: STALL_AFTER_MS },
)

console.log(`seeded job "${JOB_ID}" — ${view.tasks.length} tasks`)
console.log(`  heartbeat every ${HEARTBEAT_MS}ms, stall threshold ${STALL_AFTER_MS}ms`)
for (const t of view.tasks) console.log(`  ${t.id}  ${t.title}`)
