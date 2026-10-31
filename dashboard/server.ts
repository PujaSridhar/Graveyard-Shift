import { actors } from "./generated/index.js"

/**
 * Graveyard Shift dashboard server.
 *
 * Serves one page and brokers access to the JobSupervisor actor:
 *   GET /api/grant     a FRESH websocket grant (call on mount and on every reconnect)
 *   GET /api/snapshot  plain RPC read, used as the polling fallback
 *   GET /api/config    job id and server clock
 */

const PORT = Number(process.env.PORT ?? 3100)
const JOB_ID = process.env.JOB_ID ?? "demo"
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
            return json({ jobId: JOB_ID, serverNow: Date.now() })
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
        return new Response("not found", { status: 404 })
    },
})

console.log(`Graveyard Shift dashboard  http://localhost:${PORT}  (job "${JOB_ID}")`)
