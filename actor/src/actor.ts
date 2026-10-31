import { Actor, Emittable, Persisted, type ActorSocket } from "terse-sdk/actor"

/**
 * Graveyard Shift — the supervisor you currently are.
 *
 * One actor per job. It holds the task graph, and an alarm heartbeat checks
 * whether each claimed task is still making progress. When an agent goes
 * silent, the supervisor takes the task back and puts it up for grabs again.
 *
 * The heartbeat interval is a demo dial: 5s on stage, 90s in real use.
 *
 * Note: the runtime requires every method on an actor class to be async, so
 * the pure helpers live at module scope instead.
 */

export type TaskState = "pending" | "claimed" | "done"

export type Task = {
    id: string
    title: string
    /** Files this task is expected to touch, so agents can spot collisions. */
    files: string[]
    state: TaskState
    assignee: string | null
    claimedAt: number | null
    lastProgressAt: number | null
    attempts: number
}

export type Decision = {
    at: number
    /** Machine-readable so the dashboard can style it. */
    kind: "submitted" | "claimed" | "progress" | "completed" | "reclaimed" | "note"
    detail: string
}

/**
 * The supervisor's live reasoning about a reclaim, streamed in token by token.
 * The model call happens outside the actor so the API key never enters durable
 * state; the actor owns the text and broadcasts it as it arrives.
 */
export type Reasoning = {
    taskId: string
    text: string
    streaming: boolean
    startedAt: number
}

export type JobView = {
    tasks: Task[]
    decisions: Decision[]
    reasoning: Reasoning | null
    heartbeatMs: number
    stallAfterMs: number
    startedAt: number
    lastBeatAt: number
    beats: number
}

// ---------------------------------------------------------------- pure helpers

function patchTask(tasks: Task[], taskId: string, patch: Partial<Task>): Task[] {
    return tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t))
}

function appendDecision(decisions: Decision[], kind: Decision["kind"], detail: string): Decision[] {
    return [...decisions, { at: Date.now(), kind, detail }]
}

function stalledFor(task: Task, now: number): number {
    return now - (task.lastProgressAt ?? task.claimedAt ?? now)
}

// ----------------------------------------------------------------- the actor

export class JobSupervisor extends Actor<{ viewer: string }, { kind: string }, JobView> {
    /** The task graph. Reassign on every change — mutating in place does not persist. */
    @Persisted
    @Emittable
    tasks: Task[] = []

    /** Everything the supervisor decided and why. This is the morning report. */
    @Persisted
    @Emittable
    decisions: Decision[] = []

    /** How often the supervisor wakes to check on its agents. */
    @Persisted
    @Emittable
    heartbeatMs = 5_000

    /** No progress for this long while claimed means the agent has stalled. */
    @Persisted
    @Emittable
    stallAfterMs = 12_000

    /** Wall-clock proof of how long this job has been alive. */
    @Persisted
    @Emittable
    startedAt = 0

    @Persisted
    @Emittable
    lastBeatAt = 0

    /** How many times the supervisor has woken itself up. */
    @Persisted
    @Emittable
    beats = 0

    /** The live explanation of the most recent reclaim. */
    @Persisted
    @Emittable
    reasoning: Reasoning | null = null

    // ------------------------------------------------- live reasoning stream

    /** Opens a fresh explanation. Called when a reclaim has just been recorded. */
    async startReasoning(taskId: string): Promise<void> {
        this.reasoning = { taskId, text: "", streaming: true, startedAt: Date.now() }
        this.broadcast(await this.snapshot())
    }

    /**
     * Sets the whole text so far, rather than appending a delta.
     *
     * Each call is a separate RPC and they can arrive out of order, which with
     * deltas produced visibly scrambled text. Sending the cumulative string
     * makes the write idempotent and order-independent: a stale message can
     * only ever lose a race to a longer one, so we ignore shorter payloads.
     */
    async setReasoningText(text: string): Promise<void> {
        if (!this.reasoning) return
        if (text.length < this.reasoning.text.length) return
        this.reasoning = { ...this.reasoning, text }
        this.broadcast(await this.snapshot())
    }

    async finishReasoning(): Promise<void> {
        if (!this.reasoning) return
        this.reasoning = { ...this.reasoning, streaming: false }
        this.decisions = appendDecision(this.decisions, "note", `supervisor: ${this.reasoning.text}`)
        this.broadcast(await this.snapshot())
    }

    // ------------------------------------------------------------- job setup

    async submitJob(
        titles: { title: string; files?: string[] }[],
        opts?: { heartbeatMs?: number; stallAfterMs?: number },
    ): Promise<JobView> {
        this.startedAt = Date.now()
        if (opts?.heartbeatMs) this.heartbeatMs = opts.heartbeatMs
        if (opts?.stallAfterMs) this.stallAfterMs = opts.stallAfterMs

        this.tasks = titles.map((t, i) => ({
            id: `task-${i + 1}`,
            title: t.title,
            files: t.files ?? [],
            state: "pending" as TaskState,
            assignee: null,
            claimedAt: null,
            lastProgressAt: null,
            attempts: 0,
        }))
        // A fresh job starts a fresh log, so re-seeding gives an identical run.
        this.decisions = appendDecision([], "submitted", `${this.tasks.length} tasks queued`)
        this.beats = 0
        this.lastBeatAt = 0
        this.reasoning = null

        this.alarm.set(Date.now() + this.heartbeatMs)
        const view = await this.snapshot()
        this.broadcast(view)
        return view
    }

    // --------------------------------------------------------- agent actions

    /** An agent takes a task. One actor is single-threaded, so no double-assignment. */
    async claimTask(agent: string, taskId: string): Promise<{ ok: boolean; reason?: string }> {
        const task = this.tasks.find((t) => t.id === taskId)
        if (!task) return { ok: false, reason: "no such task" }
        if (task.state === "claimed") return { ok: false, reason: `already held by ${task.assignee}` }
        if (task.state === "done") return { ok: false, reason: "already done" }

        // File-lock collision guard: prevent two agents from editing the same file concurrently.
        const conflict = this.tasks.find(
            (t) =>
                t.state === "claimed" &&
                t.id !== taskId &&
                t.assignee !== agent &&
                t.files.some((f) => task.files.includes(f)),
        )
        if (conflict) {
            const shared = task.files.filter((f) => conflict.files.includes(f))
            const reason = `file lock on ${shared.join(", ")} (held by ${conflict.assignee} on ${conflict.id})`
            this.decisions = appendDecision(
                this.decisions,
                "note",
                `lock guard: blocked ${agent} on ${taskId} — ${shared.join(", ")} locked by ${conflict.assignee} (${conflict.id})`,
            )
            this.broadcast(await this.snapshot())
            return { ok: false, reason }
        }

        const now = Date.now()
        this.tasks = patchTask(this.tasks, taskId, {
            state: "claimed",
            assignee: agent,
            claimedAt: now,
            lastProgressAt: now,
            attempts: task.attempts + 1,
        })
        this.decisions = appendDecision(this.decisions, "claimed", `${agent} claimed ${taskId} — ${task.title}`)

        this.alarm.set(Date.now() + this.heartbeatMs)
        this.broadcast(await this.snapshot())
        return { ok: true }
    }

    /** The agent is alive and working. This is what stops the supervisor reclaiming. */
    async reportProgress(agent: string, taskId: string, note: string): Promise<void> {
        if (agent === "supervisor") {
            this.decisions = appendDecision(this.decisions, "note", note)
            this.broadcast(await this.snapshot())
            return
        }
        if (agent === "operator" && note === "__stall__") {
            const target =
                this.tasks.find((t) => t.state === "claimed" && (t.id === taskId || t.assignee === taskId)) ??
                this.tasks.find((t) => t.state === "claimed")
            if (!target) return
            const now = Date.now()
            const backdated = now - Math.max(1000, this.stallAfterMs - 1400)
            this.tasks = patchTask(this.tasks, target.id, {
                claimedAt: Math.min(target.claimedAt ?? backdated, backdated),
                lastProgressAt: backdated,
            })
            this.decisions = appendDecision(
                this.decisions,
                "note",
                `supervisor: signal drop detected on ${target.assignee} (${target.id}) — watching closely`,
            )
            this.alarm.set(now + 1500)
            this.broadcast(await this.snapshot())
            return
        }

        const task = this.tasks.find((t) => t.id === taskId)
        if (!task || task.assignee !== agent) return

        this.tasks = patchTask(this.tasks, taskId, { lastProgressAt: Date.now() })
        this.decisions = appendDecision(this.decisions, "progress", `${agent} on ${taskId}: ${note}`)
        this.broadcast(await this.snapshot())
    }

    async completeTask(agent: string, taskId: string, summary: string): Promise<void> {
        const task = this.tasks.find((t) => t.id === taskId)
        if (!task || task.assignee !== agent) return

        this.tasks = patchTask(this.tasks, taskId, { state: "done", lastProgressAt: Date.now() })
        this.decisions = appendDecision(this.decisions, "completed", `${agent} finished ${taskId}: ${summary}`)
        this.broadcast(await this.snapshot())
    }

    // ---------------------------------------------------------- the heartbeat

    /**
     * The whole product. Wakes on its own, with nothing connected, and decides
     * whether anyone has gone quiet.
     */
    async onAlarm(): Promise<void> {
        const now = Date.now()
        this.lastBeatAt = now
        this.beats = this.beats + 1

        for (const task of this.tasks) {
            if (task.state !== "claimed") continue
            const since = stalledFor(task, now)
            if (since < this.stallAfterMs) continue

            const who = task.assignee ?? "unknown"
            this.tasks = patchTask(this.tasks, task.id, {
                state: "pending",
                assignee: null,
                claimedAt: null,
                lastProgressAt: null,
            })
            this.decisions = appendDecision(
                this.decisions,
                "reclaimed",
                `${who} went quiet for ${Math.round(since / 1000)}s on ${task.id} — reassigning`,
            )
        }

        const finished = this.tasks.length > 0 && this.tasks.every((t) => t.state === "done")
        if (!finished) this.alarm.set(Date.now() + this.heartbeatMs)

        this.broadcast(await this.snapshot())
    }

    // ----------------------------------------------------------------- views

    /** Temporary: reports what the actor sandbox exposes. Never returns the key itself. */
    async diagnose(): Promise<{ hasEnv: boolean; keyLen: number; hasFetch: boolean; hasAbort: boolean }> {
        const key = typeof process !== "undefined" ? process.env?.OPENAI_API_KEY : undefined
        return {
            hasEnv: typeof process !== "undefined" && !!process.env,
            keyLen: key ? key.length : 0,
            hasFetch: typeof fetch === "function",
            hasAbort: typeof AbortController === "function",
        }
    }

    async snapshot(): Promise<JobView> {
        return {
            tasks: this.tasks,
            decisions: this.decisions,
            reasoning: this.reasoning,
            heartbeatMs: this.heartbeatMs,
            stallAfterMs: this.stallAfterMs,
            startedAt: this.startedAt,
            lastBeatAt: this.lastBeatAt,
            beats: this.beats,
        }
    }

    async onConnect(socket: ActorSocket<{ viewer: string }, JobView>): Promise<void> {
        socket.send(await this.snapshot())
    }

    async onMessage(
        socket: ActorSocket<{ viewer: string }, JobView>,
        _message: { kind: string },
    ): Promise<void> {
        socket.send(await this.snapshot())
    }
}
