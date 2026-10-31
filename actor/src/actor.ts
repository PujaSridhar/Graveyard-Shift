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

export type JobView = {
    tasks: Task[]
    decisions: Decision[]
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
        this.decisions = appendDecision(this.decisions, "submitted", `${this.tasks.length} tasks queued`)

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

    async snapshot(): Promise<JobView> {
        return {
            tasks: this.tasks,
            decisions: this.decisions,
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
