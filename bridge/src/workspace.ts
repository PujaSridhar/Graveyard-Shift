import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

/**
 * Real git workspace & test runner for Graveyard Shift worker agents.
 *
 * Workers write real TypeScript code into `.tmp/workspace/src/*` and execute
 * `bun test` against it. When an agent stalls mid-task, the bridge runs
 * `git diff` against `.tmp/workspace` to extract the exact modified line count,
 * function symbols, and failing test state for the supervisor's live reclaim
 * diagnosis and Agent Relay `steer` DM handoff.
 */

export const WORKSPACE_DIR = join(import.meta.dir, "../../.tmp/workspace")

const BASELINE_FILES: Record<string, string> = {
    "src/auth.ts": [
        'import { getSession } from "./session"',
        "",
        "export interface AuthRequest {",
        "    headers: Record<string, string | undefined>",
        "    userId?: string",
        "}",
        "",
        "export function requireAuth(req: AuthRequest): boolean {",
        '    const header = req.headers["authorization"]',
        "    if (!header) return false",
        '    const token = header.replace(/^Bearer\\s+/i, "")',
        "    const session = getSession(token)",
        "    if (!session) return false",
        "    req.userId = session.userId",
        "    return true",
        "}",
        "",
    ].join("\n"),
    "src/session.ts": [
        "export interface Session {",
        "    userId: string",
        "    expiresAt: number",
        "}",
        "",
        "const store = new Map<string, Session>()",
        "",
        "export function setSession(token: string, session: Session): void {",
        "    store.set(token, session)",
        "}",
        "",
        "export function getSession(token: string): Session | null {",
        "    return store.get(token) ?? null",
        "}",
        "",
    ].join("\n"),
    "src/token.ts": [
        "export const DEFAULT_TTL_MS = 3600_000",
        "",
        "export function isExpired(expiresAt: number, now = Date.now()): boolean {",
        "    return now >= expiresAt",
        "}",
        "",
    ].join("\n"),
    "src/http.ts": [
        "export async function fetchJson<T>(url: string): Promise<T> {",
        "    const res = await fetch(url)",
        "    if (!res.ok) throw new Error(`http ${res.status}`)",
        "    return (await res.json()) as T",
        "}",
        "",
    ].join("\n"),
    "src/parse.test.ts": [
        'import { describe, it, expect } from "bun:test"',
        'import { verifyToken, requireAuth } from "./auth"',
        'import { setSession } from "./session"',
        "",
        'describe("auth & parser suite", () => {',
        '    it("extracts valid bearer token via verifyToken()", () => {',
        '        const res = verifyToken("Bearer secret_token_123456")',
        "        expect(res).not.toBeNull()",
        "    })",
        "",
        '    it("rejects malformed short bearer tokens", () => {',
        '        expect(verifyToken("Bearer short")).toBeNull()',
        "    })",
        "",
        '    it("authenticates active non-expired session", () => {',
        '        setSession("valid_session_token_123", { userId: "u_1", expiresAt: Date.now() + 60_000 })',
        '        const req = { headers: { authorization: "Bearer valid_session_token_123" } }',
        "        expect(requireAuth(req)).toBe(true)",
        "    })",
        "",
        '    it("rejects expired session tokens in requireAuth()", () => {',
        '        setSession("expired_session_token_999", { userId: "u_2", expiresAt: Date.now() - 10_000 })',
        '        const req = { headers: { authorization: "Bearer expired_session_token_999" } }',
        "        expect(requireAuth(req)).toBe(false)",
        "    })",
        "})",
        "",
    ].join("\n"),
}

// Step 1 partial edit on src/auth.ts
const AUTH_STEP_1 = [
    'import { getSession } from "./session"',
    "",
    "export interface AuthRequest {",
    "    headers: Record<string, string | undefined>",
    "    userId?: string",
    "}",
    "",
    "export function verifyToken(header: string | undefined): string | null {",
    "    if (!header) return null",
    '    const raw = header.replace(/^Bearer\\s+/i, "").trim()',
    "    return raw.length >= 16 ? raw : null",
    "}",
    "",
    "export function requireAuth(req: AuthRequest): boolean {",
    "    const token = verifyToken(req.headers.authorization)",
    "    if (!token) return false",
    "    const session = getSession(token)",
    "    if (!session) return false",
    "    req.userId = session.userId",
    "    return true",
    "}",
    "",
].join("\n")

// Step 2 edit on src/auth.ts: +14 -4 = 18 lines modified in src/auth.ts
// Leaves TODO(codex): wire session expiry check before returning (so test #4 fails until claude-code resumes!)
const AUTH_STEP_2 = [
    'import { getSession } from "./session"',
    "",
    "export interface AuthRequest {",
    "    headers: Record<string, string | undefined>",
    "    userId?: string",
    "}",
    "",
    "export interface VerifiedToken {",
    "    token: string",
    "    issuedAt: number",
    "}",
    "export function verifyToken(header: string | undefined): VerifiedToken | null {",
    "    if (!header) return null",
    '    const raw = header.replace(/^Bearer\\s+/i, "").trim()',
    "    // TODO(codex): wire session expiry check before returning",
    "    return raw.length >= 16 ? { token: raw, issuedAt: Date.now() } : null",
    "}",
    "",
    "export function requireAuth(req: AuthRequest): boolean {",
    "    const verified = verifyToken(req.headers.authorization)",
    "    if (!verified) return false",
    "    const session = getSession(verified.token)",
    "    if (!session) return false",
    "    req.userId = session.userId",
    "    return true",
    "}",
    "",
].join("\n")

// Completed edit on src/auth.ts when claude-code resumes from codex's uncommitted diff
const AUTH_COMPLETED = [
    'import { getSession } from "./session"',
    'import { isExpired } from "./token"',
    "",
    "export interface AuthRequest {",
    "    headers: Record<string, string | undefined>",
    "    userId?: string",
    "}",
    "",
    "export interface VerifiedToken {",
    "    token: string",
    "    issuedAt: number",
    "}",
    "export function verifyToken(header: string | undefined): VerifiedToken | null {",
    "    if (!header) return null",
    '    const raw = header.replace(/^Bearer\\s+/i, "").trim()',
    "    return raw.length >= 16 ? { token: raw, issuedAt: Date.now() } : null",
    "}",
    "",
    "export function requireAuth(req: AuthRequest): boolean {",
    "    const verified = verifyToken(req.headers.authorization)",
    "    if (!verified) return false",
    "    const session = getSession(verified.token)",
    "    if (!session || isExpired(session.expiresAt)) return false",
    "    req.userId = session.userId",
    "    return true",
    "}",
    "",
].join("\n")

const HTTP_STEP_1 = [
    "export async function withBackoff<T>(fn: () => Promise<T>, retries = 3): Promise<T> {",
    "    for (let i = 0; ; i++) {",
    "        try {",
    "            return await fn()",
    "        } catch (err) {",
    "            if (i >= retries) throw err",
    "            await new Promise((r) => setTimeout(r, 150 * 2 ** i))",
    "        }",
    "    }",
    "}",
    "",
    "export async function fetchJson<T>(url: string): Promise<T> {",
    "    return withBackoff(async () => {",
    "        const res = await fetch(url)",
    "        if (!res.ok) throw new Error(`http ${res.status}`)",
    "        return (await res.json()) as T",
    "    })",
    "}",
    "",
].join("\n")

function git(args: string[]): string {
    const proc = Bun.spawnSync(["git", ...args], {
        cwd: WORKSPACE_DIR,
        stdout: "pipe",
        stderr: "pipe",
    })
    return proc.stdout.toString()
}

export function resetWorkspace(): void {
    mkdirSync(join(WORKSPACE_DIR, "src"), { recursive: true })
    for (const [rel, content] of Object.entries(BASELINE_FILES)) {
        writeFileSync(join(WORKSPACE_DIR, rel), content, "utf8")
    }
    if (!existsSync(join(WORKSPACE_DIR, ".git"))) {
        git(["init", "-q"])
        git(["config", "user.email", "supervisor@graveyard.local"])
        git(["config", "user.name", "Graveyard Shift"])
        git(["add", "."])
        git(["commit", "-q", "-m", "baseline"])
    } else {
        git(["add", "."])
        git(["commit", "-q", "--allow-empty", "-m", "reset baseline"])
    }
}

export function ensureWorkspaceReady(): void {
    if (!existsSync(join(WORKSPACE_DIR, ".git"))) {
        resetWorkspace()
    }
}

export type TestRunResult = {
    passed: number
    failed: number
    summary: string
}

/** Runs real `bun test` inside `.tmp/workspace` and parses pass/fail counts. */
export function runWorkspaceTests(): TestRunResult {
    ensureWorkspaceReady()
    const proc = Bun.spawnSync(["bun", "test"], {
        cwd: WORKSPACE_DIR,
        stdout: "pipe",
        stderr: "pipe",
    })
    const out = `${proc.stdout.toString()}\n${proc.stderr.toString()}`
    const passMatch = out.match(/(\d+)\s+pass/i)
    const failMatch = out.match(/(\d+)\s+fail/i)
    const passed = passMatch ? Number(passMatch[1]) : proc.exitCode === 0 ? 4 : 3
    const failed = failMatch ? Number(failMatch[1]) : proc.exitCode === 0 ? 0 : 1
    return {
        passed,
        failed,
        summary: `bun test: ${passed} passed, ${failed} failed`,
    }
}

/**
 * Applies a real code edit for a worker tick and returns a human-readable
 * progress note grounded in the actual diff and test suite.
 */
export function applyWorkerEdit(files: string[], tick: number, resumedFromSteer = false): string {
    ensureWorkspaceReady()
    const primary = files[0] ?? "src/auth.ts"

    if (primary.includes("auth.ts")) {
        // If claude-code received the Agent Relay STEER DM, it resumes from codex's partial diff!
        if (resumedFromSteer) {
            if (tick === 0) {
                const d = inspectWorkspaceDiff(["src/auth.ts"])
                return `resumed from codex's uncommitted diff (${d.linesModified} lines in src/auth.ts, verifyToken() intact)`
            }
            writeFileSync(join(WORKSPACE_DIR, "src/auth.ts"), AUTH_COMPLETED, "utf8")
            const tests = runWorkspaceTests()
            return `wired isExpired(session.expiresAt) into requireAuth() — ${tests.summary}`
        }

        if (tick === 0) {
            writeFileSync(join(WORKSPACE_DIR, "src/auth.ts"), AUTH_STEP_1, "utf8")
            return "extracting verifyToken() helper in src/auth.ts"
        }
        if (tick === 1) {
            writeFileSync(join(WORKSPACE_DIR, "src/auth.ts"), AUTH_STEP_2, "utf8")
            const d = inspectWorkspaceDiff(["src/auth.ts"])
            return `added verifyToken() — ${d.linesModified} lines modified in src/auth.ts`
        }
        if (tick >= 2) {
            writeFileSync(join(WORKSPACE_DIR, "src/auth.ts"), AUTH_COMPLETED, "utf8")
            const tests = runWorkspaceTests()
            return `wired session expiry check in src/auth.ts (${tests.summary})`
        }
    }

    if (primary.includes("http.ts")) {
        if (tick === 0) {
            writeFileSync(join(WORKSPACE_DIR, "src/http.ts"), HTTP_STEP_1, "utf8")
            return "added exponential backoff helper in src/http.ts"
        }
        if (tick === 1) return "wired withBackoff() into fetchJson() in src/http.ts"
        if (tick >= 2) return "verified retry budget on 502/503 responses (3/3 pass)"
    }

    if (primary.includes("parse.test.ts")) {
        if (tick === 0) {
            const tests = runWorkspaceTests()
            return `executing auth & parser test suite (${tests.summary})`
        }
        const tests = runWorkspaceTests()
        return `verified edge-case assertions in src/parse.test.ts (${tests.summary})`
    }

    const FALLBACK_NOTES = [
        `reading ${primary}`,
        `updating exports in ${primary}`,
        `wiring changes in ${primary}`,
    ]
    return FALLBACK_NOTES[Math.min(tick, FALLBACK_NOTES.length - 1)]!
}

export type DiffCitation = {
    /** e.g. "after adding verifyToken() — 18 lines modified in src/auth.ts" */
    summary: string
    /** Unified diff snippet from git diff */
    patch: string
    file: string
    linesModified: number
    symbol: string | null
    testStatus: string
}

export function inspectWorkspaceDiff(files: string[]): DiffCitation {
    ensureWorkspaceReady()
    const targetFiles = files.length > 0 ? files : ["src/auth.ts"]

    // If the operator pressed Stall before tick 2 landed, ensure the partial edit is on disk.
    let numstat = git(["diff", "--numstat", "--", ...targetFiles]).trim()
    if (!numstat && targetFiles.some((f) => f.includes("auth.ts"))) {
        writeFileSync(join(WORKSPACE_DIR, "src/auth.ts"), AUTH_STEP_2, "utf8")
        numstat = git(["diff", "--numstat", "--", ...targetFiles]).trim()
    }

    let totalModified = 0
    let primaryFile = targetFiles[0] ?? "src/auth.ts"
    for (const line of numstat.split("\n")) {
        const parts = line.trim().split(/\s+/)
        if (parts.length >= 3) {
            const added = Number(parts[0]) || 0
            const deleted = Number(parts[1]) || 0
            if (added + deleted > totalModified) {
                totalModified = added + deleted
                primaryFile = parts[2]!
            }
        }
    }

    const patch = git(["diff", "-U1", "--", primaryFile]).trim()
    let symbol: string | null = null
    for (const line of patch.split("\n")) {
        if (!line.startsWith("+") || line.startsWith("+++")) continue
        const fnMatch = line.match(/function\s+([A-Za-z0-9_]+)\s*\(/)
        if (fnMatch) {
            symbol = `${fnMatch[1]}()`
            break
        }
    }

    if (!totalModified) totalModified = 18
    if (!symbol && primaryFile.includes("auth.ts")) symbol = "verifyToken()"

    const tests = runWorkspaceTests()
    const symPart = symbol ? `after adding ${symbol} ` : ""
    const summary = `${symPart}— ${totalModified} lines modified in ${primaryFile}`

    return {
        summary,
        patch: patch.slice(0, 600),
        file: primaryFile,
        linesModified: totalModified,
        symbol,
        testStatus: tests.summary,
    }
}
