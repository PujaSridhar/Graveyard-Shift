import { actors } from "../generated/index.js"
import { explainReclaim } from "../../actor/src/reasoning.ts"

/**
 * The demo scenario, and the proof that the supervisor works.
 *
 * Two agents claim work. First, file-lock collision detection prevents two
 * agents from modifying src/auth.ts concurrently. Then one agent keeps
 * reporting progress while the other goes silent mid-task. Nobody tells the
 * supervisor. It notices on its own, reclaims the task, and streams live AI
 * reasoning.
 */

const JOB_ID = process.env.JOB_ID ?? "demo"
const job = actors.JobSupervisor.get(JOB_ID)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function render(label: string, view: Awaited<ReturnType<typeof job.snapshot>>) {
    console.log(`\n── ${label} ${"─".repeat(Math.max(0, 54 - label.length))}`)
    for (const t of view.tasks) {
        const who = t.assignee ? ` → ${t.assignee}` : ""
        const tries = t.attempts > 1 ? `  (attempt ${t.attempts})` : ""
        console.log(`  ${t.state.padEnd(8)} ${t.id}  ${t.title} [${t.files.join(", ")}]${who}${tries}`)
    }
    console.log(`  beats: ${view.beats}`)
}

async function main() {
    console.log("Graveyard Shift — file lock & stall detection scenario")

    await job.submitJob(
        [
            { title: "refactor the auth middleware", files: ["src/auth.ts", "src/session.ts"] },
            { title: "tighten session token expiry", files: ["src/auth.ts", "src/token.ts"] },
            { title: "add retries to the fetch client", files: ["src/http.ts"] },
            { title: "write tests for the parser", files: ["src/parse.test.ts"] },
        ],
        { heartbeatMs: 2_000, stallAfterMs: 6_000 },
    )
    render("job submitted", await job.snapshot())

    // codex claims task-1 (locks src/auth.ts).
    await job.claimTask("codex", "task-1")
    // claude-code tries task-2 (also touches src/auth.ts) -> blocked by file lock!
    const collision = await job.claimTask("claude-code", "task-2")
    console.log(`\n  [lock check] claude-code claiming task-2: ok=${collision.ok} (${collision.reason})`)
    // claude-code backs off to task-3 (src/http.ts).
    await job.claimTask("claude-code", "task-3")
    render("both agents claimed (collision avoided)", await job.snapshot())

    // claude-code keeps working. codex reports once then dies.
    await job.reportProgress("codex", "task-1", "editing src/auth.ts middleware")
    await job.reportProgress("claude-code", "task-3", "added backoff helper")
    await sleep(2_500)
    await job.reportProgress("claude-code", "task-3", "wired it into the client")

    console.log("\n*** codex goes silent here — no more progress reports ***")

    // Wait past the stall threshold without touching codex's task.
    for (let i = 0; i < 4; i++) {
        await sleep(2_000)
        await job.reportProgress("claude-code", "task-3", `still going (${i + 1})`)
    }

    const after = await job.snapshot()
    render("after the heartbeat noticed", after)

    const reclaimed = after.decisions.filter((d) => d.kind === "reclaimed")
    const task1 = after.tasks.find((t) => t.id === "task-1")

    if (reclaimed.length > 0 && task1) {
        await job.startReasoning("task-1")
        let full = ""
        await explainReclaim(
            {
                taskId: "task-1",
                taskTitle: task1.title,
                files: task1.files,
                agent: "codex",
                silentForMs: 6_000,
                attempts: task1.attempts,
                lastProgressNote: "editing src/auth.ts middleware",
                otherAgents: ["claude-code"],
                recentDecisions: after.decisions.slice(-6).map((d) => ({ kind: d.kind, detail: d.detail })),
            },
            (chunk) => {
                full += chunk
            },
        )
        await job.setReasoningText(full)
        await job.finishReasoning()
        console.log(`\n  [AI reasoning] ${full}`)
    }

    const finalView = await job.snapshot()
    console.log("\n── supervisor decision log " + "─".repeat(30))
    for (const d of finalView.decisions) {
        console.log(`  [${d.kind.padEnd(9)}] ${d.detail}`)
    }

    console.log("\n── result " + "─".repeat(47))
    if (reclaimed.length > 0 && task1?.state === "pending" && task1.assignee === null && !collision.ok) {
        console.log("  PASS — the supervisor enforced file locks and reclaimed the stalled task on its own.")
        console.log(`  ${reclaimed[0]!.detail}`)
    } else {
        console.log("  FAIL — task-1 was not reclaimed.")
        console.log(`  task-1 is ${task1?.state} assigned to ${task1?.assignee}`)
        process.exitCode = 1
    }

    // The other agent finishes normally, to show the happy path still works.
    await job.completeTask("claude-code", "task-3", "retries landed")
    render("claude-code finished its task", await job.snapshot())
}

main().catch((err) => {
    console.error("scenario failed:", err)
    process.exitCode = 1
})
