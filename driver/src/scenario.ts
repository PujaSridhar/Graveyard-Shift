import { actors } from "../generated/index.js"

/**
 * The demo scenario, and the proof that the supervisor works.
 *
 * Two agents claim work. One keeps reporting progress. The other goes silent
 * mid-task — exactly what happens when a real agent stalls or its process dies.
 * Nobody tells the supervisor. It notices on its own and takes the task back.
 */

const JOB_ID = process.env.JOB_ID ?? "demo"
const job = actors.JobSupervisor.get(JOB_ID)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function render(label: string, view: Awaited<ReturnType<typeof job.snapshot>>) {
    console.log(`\n── ${label} ${"─".repeat(Math.max(0, 54 - label.length))}`)
    for (const t of view.tasks) {
        const who = t.assignee ? ` → ${t.assignee}` : ""
        const tries = t.attempts > 1 ? `  (attempt ${t.attempts})` : ""
        console.log(`  ${t.state.padEnd(8)} ${t.id}  ${t.title}${who}${tries}`)
    }
    console.log(`  beats: ${view.beats}`)
}

async function main() {
    console.log("Graveyard Shift — stall detection scenario")

    await job.submitJob(
        [
            { title: "refactor the auth middleware", files: ["src/auth.ts"] },
            { title: "add retries to the fetch client", files: ["src/http.ts"] },
            { title: "write tests for the parser", files: ["src/parse.test.ts"] },
        ],
        { heartbeatMs: 2_000, stallAfterMs: 6_000 },
    )
    render("job submitted", await job.snapshot())

    // Both agents pick up work.
    await job.claimTask("codex", "task-1")
    await job.claimTask("claude-code", "task-2")
    render("both agents claimed", await job.snapshot())

    // claude-code keeps working. codex is about to die.
    await job.reportProgress("claude-code", "task-2", "added backoff helper")
    await sleep(2_500)
    await job.reportProgress("claude-code", "task-2", "wired it into the client")

    console.log("\n*** codex goes silent here — no more progress reports ***")

    // Wait past the stall threshold without touching codex's task.
    for (let i = 0; i < 5; i++) {
        await sleep(2_000)
        await job.reportProgress("claude-code", "task-2", `still going (${i + 1})`)
    }

    const after = await job.snapshot()
    render("after the heartbeat noticed", after)

    const reclaimed = after.decisions.filter((d) => d.kind === "reclaimed")
    const task1 = after.tasks.find((t) => t.id === "task-1")

    console.log("\n── supervisor decision log " + "─".repeat(30))
    for (const d of after.decisions) {
        console.log(`  [${d.kind.padEnd(9)}] ${d.detail}`)
    }

    console.log("\n── result " + "─".repeat(47))
    if (reclaimed.length > 0 && task1?.state === "pending" && task1.assignee === null) {
        console.log("  PASS — the supervisor reclaimed the stalled task on its own.")
        console.log(`  ${reclaimed[0]!.detail}`)
    } else {
        console.log("  FAIL — task-1 was not reclaimed.")
        console.log(`  task-1 is ${task1?.state} assigned to ${task1?.assignee}`)
        process.exitCode = 1
    }

    // The other agent finishes normally, to show the happy path still works.
    await job.completeTask("claude-code", "task-2", "retries landed")
    render("claude-code finished its task", await job.snapshot())
}

main().catch((err) => {
    console.error("scenario failed:", err)
    process.exitCode = 1
})
