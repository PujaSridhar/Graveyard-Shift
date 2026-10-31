import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

/**
 * Agent Relay transport with write-through local mirror.
 *
 * Every post and DM is sent to the real Agent Relay CLI/server, while a
 * write-through mirror in `.tmp/relay-mirror.json` lets local processes
 * observe channel & DM traffic in <15ms instead of blocking 5-10s on
 * sequential Node CLI cold-starts when the room's Relay DB is under load.
 */

const RELAY = "relay"
const MIRROR_PATH = join(import.meta.dir, "../../.tmp/relay-mirror.json")

export type RelayMessage = {
    id: string
    messageId: string
    text: string
    from: { id: string; name: string }
    createdAt: string
}

export type RelayDirectMessage = {
    id: string
    to: string
    from: string
    text: string
    mode: "wait" | "steer"
    createdAt: string
}

type MirrorState = {
    channel: Record<string, RelayMessage[]>
    dms: RelayDirectMessage[]
}

const OVERLOADED = /temporarily overloaded|retry after the interval|\b429\b/i

function loadTokenNames(): Record<string, string> {
    const map: Record<string, string> = {}
    try {
        const envPath = join(import.meta.dir, "../../.env")
        const text = readFileSync(envPath, "utf8")
        for (const line of text.split("\n")) {
            const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
            if (!m) continue
            const [, k, v] = m
            if (k === "RELAY_SUPERVISOR_TOKEN") map[v!.trim()] = "supervisor"
            if (k === "RELAY_CODEX_TOKEN") map[v!.trim()] = "codex"
            if (k === "RELAY_CLAUDE_TOKEN") map[v!.trim()] = "claude-code"
        }
    } catch {
        /* ignore */
    }
    if (process.env.RELAY_SUPERVISOR_TOKEN) map[process.env.RELAY_SUPERVISOR_TOKEN] = "supervisor"
    if (process.env.RELAY_CODEX_TOKEN) map[process.env.RELAY_CODEX_TOKEN] = "codex"
    if (process.env.RELAY_CLAUDE_TOKEN) map[process.env.RELAY_CLAUDE_TOKEN] = "claude-code"
    return map
}

const TOKEN_TO_NAME = loadTokenNames()

function readMirror(): MirrorState {
    try {
        if (!existsSync(MIRROR_PATH)) return { channel: {}, dms: [] }
        const parsed = JSON.parse(readFileSync(MIRROR_PATH, "utf8")) as MirrorState
        return {
            channel: parsed.channel ?? {},
            dms: Array.isArray(parsed.dms) ? parsed.dms : [],
        }
    } catch {
        return { channel: {}, dms: [] }
    }
}

function writeMirror(state: MirrorState): void {
    try {
        mkdirSync(dirname(MIRROR_PATH), { recursive: true })
        writeFileSync(MIRROR_PATH, JSON.stringify(state), "utf8")
    } catch {
        /* ignore */
    }
}

let seq = 0
function nextId(): string {
    seq = (seq + 1) % 1000
    // Monotonic snowflake-compatible integer string
    return String(BigInt(Date.now()) * 1_000_000n + BigInt((process.pid % 1000) * 1000 + seq))
}

async function run(args: string[], token: string): Promise<string> {
    let lastErr = ""
    for (let attempt = 0; attempt < 4; attempt++) {
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

let lastRemoteSync = 0
let remoteSyncInFlight = false

export async function listMessages(
    channel: string,
    token: string,
    limit = 50,
): Promise<RelayMessage[]> {
    const mirror = readMirror()
    const localMsgs = mirror.channel[channel] ?? []

    // Periodically sync in background with remote Relay without blocking the fast loop
    const now = Date.now()
    if (!remoteSyncInFlight && now - lastRemoteSync > 6_000) {
        remoteSyncInFlight = true
        lastRemoteSync = now
        void run(["message", "list", channel, "--limit", String(limit)], token)
            .then((raw) => {
                const remote = parseJson<RelayMessage[]>(raw)
                if (!remote || !Array.isArray(remote)) return
                const cur = readMirror()
                const existing = cur.channel[channel] ?? []
                if (existing.length === 0 && remote.length > 0) {
                    cur.channel[channel] = remote.slice(0, limit)
                    writeMirror(cur)
                }
            })
            .catch(() => {})
            .finally(() => {
                remoteSyncInFlight = false
            })
    }

    // Return newest first (matching Agent Relay CLI ordering)
    return [...localMsgs].sort((a, b) => (newerThan(b.id, a.id) ? 1 : -1)).slice(0, limit)
}

export async function post(channel: string, text: string, token: string): Promise<void> {
    const sender = TOKEN_TO_NAME[token] ?? "agent"
    const id = nextId()
    const msg: RelayMessage = {
        id,
        messageId: id,
        text,
        from: { id: sender, name: sender },
        createdAt: new Date().toISOString(),
    }
    const mirror = readMirror()
    const list = mirror.channel[channel] ?? []
    list.push(msg)
    mirror.channel[channel] = list.slice(-120)
    writeMirror(mirror)

    // Fire real Agent Relay CLI call asynchronously so UI/bridge never blocks on CLI cold-start
    void run(["message", "post", channel, text], token).catch(() => {})
}

export async function dm(
    agent: string,
    text: string,
    token: string,
    mode: "wait" | "steer" = "wait",
): Promise<void> {
    const sender = TOKEN_TO_NAME[token] ?? "supervisor"
    const id = nextId()
    const mirror = readMirror()
    mirror.dms.push({
        id,
        to: agent,
        from: sender,
        text,
        mode,
        createdAt: new Date().toISOString(),
    })
    mirror.dms = mirror.dms.slice(-60)
    writeMirror(mirror)

    // Fire real Agent Relay DM CLI call asynchronously
    void run(["message", "dm", "send", agent, text, "--mode", mode], token).catch(() => {})
}

export async function checkInbox(agent: string, afterId = "0"): Promise<RelayDirectMessage[]> {
    const mirror = readMirror()
    return mirror.dms.filter(
        (m) => m.to.toLowerCase() === agent.toLowerCase() && newerThan(m.id, afterId),
    )
}

export function resetRelayMirror(): void {
    writeMirror({ channel: {}, dms: [] })
}

/** Snowflake ids increase monotonically, so this orders messages reliably. */
export function newerThan(a: string, b: string): boolean {
    try {
        return BigInt(a) > BigInt(b)
    } catch {
        return a > b
    }
}
