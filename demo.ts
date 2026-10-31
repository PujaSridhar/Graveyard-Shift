/**
 * One-command stage launcher for Graveyard Shift.
 *
 * Usage:
 *   bun run demo.ts              # seeds the job and runs bridge + dashboard + both Relay workers
 *   bun run demo.ts "your goal"  # AI-decomposes your custom goal, seeds it, and runs the full stack
 */

const ROOT = import.meta.dir
const goal = process.argv.slice(2).join(" ").trim()

const children: ReturnType<typeof Bun.spawn>[] = []

function spawnTagged(label: string, color: string, cmd: string[], cwd: string) {
    const proc = Bun.spawn(cmd, {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
    })
    children.push(proc)

    const pipeLines = async (stream: ReadableStream<Uint8Array> | null) => {
        if (!stream) return
        const reader = stream.getReader()
        const dec = new TextDecoder()
        let buf = ""
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buf += dec.decode(value, { stream: true })
            let nl: number
            while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl)
                buf = buf.slice(nl + 1)
                if (line.trim()) console.log(`${color}[${label}]\x1b[0m ${line}`)
            }
        }
    }
    void pipeLines(proc.stdout)
    void pipeLines(proc.stderr)
    return proc
}

function cleanup() {
    for (const c of children) {
        try {
            c.kill()
        } catch {}
    }
}
process.on("SIGINT", () => {
    cleanup()
    process.exit(0)
})
process.on("SIGTERM", () => {
    cleanup()
    process.exit(0)
})

async function main() {
    console.log("\x1b[1mGraveyard Shift — Stage Launcher\x1b[0m")

    // 1. Seed the supervisor actor
    // --env-file is required: the OpenAI key lives in actor/.env, and without it
    // decomposeGoal() silently returns a templated plan instead of an AI one.
    const seedArgs = ["bun", "--env-file=../actor/.env", "run", "src/seed.ts", ...(goal ? [goal] : [])]
    const seedProc = Bun.spawnSync(seedArgs, { cwd: `${ROOT}/bridge`, env: { ...process.env } })
    console.log(seedProc.stdout.toString().trim())
    if (seedProc.exitCode !== 0) {
        console.error(seedProc.stderr.toString())
    }

    // 2. Check if dashboard is already listening on :3100; if not, start it
    let dashUp = false
    try {
        const res = await fetch("http://localhost:3100/api/config")
        dashUp = res.ok
    } catch {}
    if (!dashUp) {
        spawnTagged("dashboard", "\x1b[36m", ["bun", "--env-file=../.env", "server.ts"], `${ROOT}/dashboard`)
    } else {
        console.log("\x1b[36m[dashboard]\x1b[0m already live at http://localhost:3100")
    }

    // 3. Start the Agent Relay bridge and worker processes
    spawnTagged("bridge   ", "\x1b[35m", ["bun", "run", "src/bridge.ts"], `${ROOT}/bridge`)
    await new Promise((r) => setTimeout(r, 800))
    spawnTagged("codex    ", "\x1b[33m", ["bun", "run", "src/worker.ts", "codex", "--die-after", "2"], `${ROOT}/bridge`)
    await new Promise((r) => setTimeout(r, 400))
    spawnTagged("claude   ", "\x1b[32m", ["bun", "run", "src/worker.ts", "claude-code"], `${ROOT}/bridge`)

    console.log("\n\x1b[1;32mStage ready → http://localhost:3100\x1b[0m (Press Ctrl+C to stop)\n")
    await new Promise(() => {})
}

main()
