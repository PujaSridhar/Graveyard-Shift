/**
 * Thin wrapper over the Agent Relay CLI.
 *
 * We shell out rather than use the SDK because the CLI surface is the one we
 * have verified end to end. Relay's backend returns transient "database is
 * temporarily overloaded" errors under load — the whole room is hammering it —
 * so every call retries with backoff.
 */

const RELAY = "relay"

export type RelayMessage = {
    id: string
    messageId: string
    text: string
    from: { id: string; name: string }
    createdAt: string
}

/**
 * Match only the server's actual overload phrasing.
 *
 * This used to be /overloaded|rate.?limit|retry.?after/i, tested against the
 * whole CLI output — which includes message text. Any task titled "add rate
 * limiting" therefore looked like an overload, every retry failed, and the
 * entire Relay layer died. Keep this narrow and anchored to the server's words.
 */
const OVERLOADED = /temporarily overloaded|retry after the interval|\b429\b/i

async function run(args: string[], token: string): Promise<string> {
    let lastErr = ""
    for (let attempt = 0; attempt < 5; attempt++) {
        const proc = Bun.spawn([RELAY, ...args, "--token", token], {
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env },
        })
        const [out, err] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ])
        await proc.exited
        const combined = `${out}\n${err}`

        if (!OVERLOADED.test(combined)) return combined

        lastErr = combined.trim().split("\n").filter(Boolean).pop() ?? "overloaded"
        await new Promise((r) => setTimeout(r, 300 * 2 ** attempt))
    }
    throw new Error(`relay ${args[0]} ${args[1]} failed after retries: ${lastErr}`)
}

/** Relay prints its JSON mixed with a telemetry notice, so pull out the JSON body. */
function parseJson<T>(raw: string): T | null {
    const start = raw.search(/[[{]/)
    if (start === -1) return null
    const body = raw.slice(start)
    try {
        return JSON.parse(body) as T
    } catch {
        return null
    }
}

export async function listMessages(
    channel: string,
    token: string,
    limit = 50,
): Promise<RelayMessage[]> {
    const raw = await run(["message", "list", channel, "--limit", String(limit)], token)
    return parseJson<RelayMessage[]>(raw) ?? []
}

export async function post(channel: string, text: string, token: string): Promise<void> {
    await run(["message", "post", channel, text], token)
}

export async function dm(
    agent: string,
    text: string,
    token: string,
    mode: "wait" | "steer" = "wait",
): Promise<void> {
    await run(["message", "dm", "send", agent, text, "--mode", mode], token)
}

/** Snowflake ids increase monotonically, so this orders messages reliably. */
export function newerThan(a: string, b: string): boolean {
    try {
        return BigInt(a) > BigInt(b)
    } catch {
        return a > b
    }
}
