import { actors } from "./generated/index.js"
import { decomposeGoal, fallbackDecompose } from "../actor/src/reasoning.ts"
import { resetRelayMirror } from "../bridge/src/relay.ts"
import { resetWorkspace } from "../bridge/src/workspace.ts"

/**
 * Graveyard Shift dashboard server.
 *
 * Serves one page and brokers access to the JobSupervisor actor:
 *   GET  /api/grant     a FRESH websocket grant (call on mount and on every reconnect)
 *   GET  /api/snapshot  plain RPC read, used as the polling fallback
 *   GET  /api/config    job id and server clock
 *   POST /api/seed      seed default tasks or AI-decompose a custom engineering goal
 *   POST /api/stall     simulate an immediate agent stall on a claimed task
 */

function loadEnvFile(path: string): Record<string, string> {
    const out: Record<string, string> = {}
    try {
        const text = require("node:fs").readFileSync(path, "utf8") as string
        for (const line of text.split("\n")) {
            const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
            if (m) out[m[1]!] = m[2]!.trim()
        }
    } catch {
        /* ignore */
    }
    return out
}

const fileEnv = {
    ...loadEnvFile(`${import.meta.dir}/../.env`),
    ...loadEnvFile(`${import.meta.dir}/../actor/.env`),
}
if (fileEnv.OPENAI_API_KEY && !process.env.OPENAI_API_KEY) {
    process.env.OPENAI_API_KEY = fileEnv.OPENAI_API_KEY
}

const PORT = Number(process.env.PORT ?? 3100)
const JOB_ID = process.env.JOB_ID ?? "demo"
const RELAY_CHANNEL = process.env.RELAY_CHANNEL ?? fileEnv.RELAY_CHANNEL ?? "taskboard"
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS ?? 3_000)
const STALL_AFTER_MS = Number(process.env.STALL_AFTER_MS ?? 12_000)
const job = () => actors.JobSupervisor.get(JOB_ID)

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
    })

const fail = (err: unknown) => json({ error: err instanceof Error ? err.message : String(err) }, 502)

const page = Bun.file(new URL("./index.html", import.meta.url).pathname)

Bun.serve({
    port: PORT,
    async fetch(req) {
        const { pathname } = new URL(req.url)

        if (pathname === "/" || pathname === "/index.html") {
            return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } })
        }
        if (pathname === "/api/config") {
            return json({ jobId: JOB_ID, relayChannel: RELAY_CHANNEL, serverNow: Date.now() })
        }
        if (pathname === "/api/grant") {
            try {
                const grant = await actors.JobSupervisor.prepareWebsocket({
                    actorId: JOB_ID,
                    metadata: { viewer: "dashboard" },
                })
                return json({ ...grant, serverNow: Date.now() })
            } catch (err) {
                return fail(err)
            }
        }
        if (pathname === "/api/snapshot") {
            try {
                return json({ view: await job().snapshot(), serverNow: Date.now() })
            } catch (err) {
                return fail(err)
            }
        }
        if (pathname === "/api/seed" && req.method === "POST") {
            try {
                let goal = ""
                try {
                    const body = (await req.json()) as { goal?: string }
                    goal = (body?.goal ?? "").trim()
                } catch {
                    /* empty body */
                }
                const tasks = goal ? await decomposeGoal(goal) : fallbackDecompose()
                const view = await job().submitJob(tasks, {
                    heartbeatMs: HEARTBEAT_MS,
                    stallAfterMs: STALL_AFTER_MS,
                })
                if (goal) {
                    await job().reportProgress(
                        "supervisor",
                        "task-1",
                        `ai planner decomposed goal "${goal}" into ${view.tasks.length} tasks with file-lock graph`,
                    )
                }
                return json({ ok: true, view: await job().snapshot(), serverNow: Date.now() })
            } catch (err) {
                return fail(err)
            }
        }
        if (pathname === "/api/stall" && req.method === "POST") {
            try {
                let target = "codex"
                try {
                    const body = (await req.json()) as { target?: string }
                    if (body?.target) target = body.target
                } catch {
                    /* default to codex */
                }
                await job().reportProgress("operator", target, "__stall__")
                return json({ ok: true, view: await job().snapshot(), serverNow: Date.now() })
            } catch (err) {
                return fail(err)
            }
        }
        return new Response("not found", { status: 404 })
    },
})

console.log(`Graveyard Shift dashboard  http://localhost:${PORT}  (job "${JOB_ID}")`)
