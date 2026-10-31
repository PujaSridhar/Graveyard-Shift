// Runnable script (not a framework):
//   cd actor && bun run src/reasoning.test.ts
import { explainReclaim, type ReclaimContext } from "./reasoning"

const ctx: ReclaimContext = {
    taskId: "task-1",
    taskTitle: "Refactor the auth middleware",
    files: ["src/auth/middleware.ts", "src/auth/session.ts"],
    agent: "codex",
    silentForMs: 14_000,
    attempts: 2,
    otherAgents: ["claude-code", "cursor"],
    recentDecisions: [
        { kind: "claimed", detail: "codex claimed task-1" },
        { kind: "progress", detail: "codex: reading src/auth/session.ts" },
        { kind: "reclaimed", detail: "task-1 reclaimed from codex after 9s silence (attempt 1)" },
        { kind: "claimed", detail: "codex claimed task-1" },
    ],
}

async function run(label: string): Promise<void> {
    console.log(`\n=== ${label} ===`)
    const t0 = Date.now()
    let first = -1
    let chunks = 0
    process.stdout.write("streamed: ")
    const full = await explainReclaim(ctx, (c) => {
        if (first < 0) first = Date.now() - t0
        chunks++
        process.stdout.write(c)
    })
    const total = Date.now() - t0
    console.log(`\nreturned (${full.length} chars): ${full}`)
    console.log(`chunks=${chunks} first-token=${first}ms total=${total}ms`)
}

await run("live (API key from .env)")
await run("live again (latency sample)")

const saved = process.env.OPENAI_API_KEY
delete process.env.OPENAI_API_KEY
await run("fallback (key unset)")
process.env.OPENAI_API_KEY = "sk-invalid-deliberately-bad"
await run("fallback (invalid key)")
if (saved) process.env.OPENAI_API_KEY = saved
