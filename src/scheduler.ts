import type { ScheduledTask } from './types.js'

type TaskSnapshot = {
  status: ScheduledTask['status']
  runAt: string
  lastError?: string
}

type TaskEntry = {
  key: string
  task: ScheduledTask
}

const TERMINAL_STATUSES = new Set<ScheduledTask['status']>([
  'completed',
  'failed',
  'cancelled',
])
const PERSISTENCE_RETRY_DELAY_MS = 25

export function scheduledTaskDeliveryId(task: ScheduledTask): string {
  return `scheduled:${task.id}:${task.runAt}`
}

export function filterScheduledTasks(tasks: ScheduledTask[], includeAll: boolean): ScheduledTask[] {
  return tasks
    .filter((task) => includeAll || task.status === 'scheduled' || task.status === 'running')
    .sort((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt))
}

export class TaskScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly inFlightExecutions = new Set<Promise<void>>()
  private readonly pendingExecutionTaskIds = new Set<string>()
  private stateChangeTail: Promise<void> = Promise.resolve()
  private stopping = false
  private draining = false
  private stopDrainPromise: Promise<void> | undefined

  constructor(
    private readonly tasks: Record<string, ScheduledTask>,
    private readonly onRun: (task: ScheduledTask) => Promise<void>,
    private readonly onChange: () => Promise<void>,
  ) {}

  start(): void {
    if (this.draining) return
    this.stopping = false
    this.stopDrainPromise = undefined
    for (const task of Object.values(this.tasks)) {
      if (this.pendingExecutionTaskIds.has(task.id)) continue
      if (task.status === 'scheduled') this.armScheduled(task)
      else if (task.status === 'running') this.armRecovery(task)
    }
  }

  /** Stop future timer callbacks without waiting for an already running delivery. */
  stop(): void {
    this.stopping = true
    this.clearTimers()
  }

  /** Stop timers and wait until started deliveries and queued state changes settle. */
  stopAndDrain(): Promise<void> {
    this.stopping = true
    this.clearTimers()
    if (!this.stopDrainPromise) {
      this.draining = true
      this.stopDrainPromise = this.drainScheduler().finally(() => {
        this.draining = false
      })
      this.stopDrainPromise.catch(() => undefined)
    }
    return this.stopDrainPromise
  }

  schedule(task: ScheduledTask): void {
    if (task.status !== 'scheduled' || this.stopping) return
    this.armScheduled(task)
  }

  /** Cancel a task only after its new state has been durably persisted. */
  cancel(taskId: string): Promise<boolean> {
    const operation = this.cancelInternal(taskId)
    operation.catch(() => undefined)
    return operation
  }

  /** Run the next occurrence immediately, retaining repeat configuration. */
  runNow(taskId: string): Promise<boolean> {
    const operation = this.runNowInternal(taskId)
    operation.catch(() => undefined)
    return operation
  }

  /** Delete a completed, failed, or cancelled task after persisting the deletion. */
  deleteTerminal(taskId: string): Promise<boolean> {
    const operation = this.deleteTerminalInternal(taskId)
    operation.catch(() => undefined)
    return operation
  }

  private queueStateChange<T>(change: () => Promise<T>): Promise<T> {
    const result = this.stateChangeTail.then(change)
    this.stateChangeTail = result.then(() => undefined, () => undefined)
    return result
  }

  private clearTimer(taskId: string): void {
    const timer = this.timers.get(taskId)
    if (timer) clearTimeout(timer)
    this.timers.delete(taskId)
  }

  private clearTimers(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  private armScheduled(task: ScheduledTask): void {
    if (this.stopping || task.status !== 'scheduled') return
    this.scheduleTimer(task, false)
  }

  private armScheduledRetry(task: ScheduledTask): void {
    if (this.stopping || task.status !== 'scheduled') return
    this.scheduleTimer(task, false, PERSISTENCE_RETRY_DELAY_MS)
  }

  private armRecovery(task: ScheduledTask): void {
    if (this.stopping || task.status !== 'running') return
    this.scheduleTimer(task, true)
  }

  private armRecoveryRetry(task: ScheduledTask): void {
    if (this.stopping || task.status !== 'running') return
    this.scheduleTimer(task, true, PERSISTENCE_RETRY_DELAY_MS)
  }

  private scheduleTimer(
    task: ScheduledTask,
    recoverRunning: boolean,
    minimumDelay = 0,
  ): void {
    this.clearTimer(task.id)
    const scheduledDelay = recoverRunning ? 0 : Date.parse(task.runAt) - Date.now()
    const delay = Math.max(minimumDelay, Number.isFinite(scheduledDelay) ? scheduledDelay : 0, 0)
    let timer!: NodeJS.Timeout
    timer = setTimeout(() => {
      // A cleared timer may still be queued. Do not let it consume a replacement timer.
      if (this.timers.get(task.id) !== timer) return
      this.timers.delete(task.id)
      const execution = this.trackExecution(task, recoverRunning)
      execution.catch(() => undefined)
    }, delay)
    timer.unref()
    this.timers.set(task.id, timer)
  }

  private trackExecution(
    task: ScheduledTask,
    recoverRunning: boolean,
    alreadyClaimed = false,
  ): Promise<void> {
    if (!alreadyClaimed && this.pendingExecutionTaskIds.has(task.id)) return Promise.resolve()
    if (!alreadyClaimed) this.pendingExecutionTaskIds.add(task.id)

    const execution = this.execute(task, recoverRunning)
    this.inFlightExecutions.add(execution)
    const cleanup = () => {
      this.inFlightExecutions.delete(execution)
      this.pendingExecutionTaskIds.delete(task.id)
      if (
        !this.stopping &&
        this.findTaskEntry(task) !== undefined &&
        task.status === 'running' &&
        !this.timers.has(task.id)
      ) {
        this.armRecoveryRetry(task)
      }
    }
    execution.then(cleanup, cleanup).catch(() => undefined)
    return execution
  }

  private async drainScheduler(): Promise<void> {
    while (true) {
      const stateChanges = this.stateChangeTail
      await Promise.allSettled([...this.inFlightExecutions, stateChanges])
      if (this.inFlightExecutions.size === 0 && stateChanges === this.stateChangeTail) return
    }
  }

  private snapshot(task: ScheduledTask): TaskSnapshot {
    return {
      status: task.status,
      runAt: task.runAt,
      ...(task.lastError !== undefined ? { lastError: task.lastError } : {}),
    }
  }

  private findTask(taskId: string): TaskEntry | undefined {
    const direct = this.tasks[taskId]
    if (direct) return { key: taskId, task: direct }
    const entry = Object.entries(this.tasks).find(([, task]) => task.id === taskId)
    return entry ? { key: entry[0], task: entry[1] } : undefined
  }

  private findTaskEntry(task: ScheduledTask): TaskEntry | undefined {
    const entry = Object.entries(this.tasks).find(([, value]) => value === task)
    return entry ? { key: entry[0], task: entry[1] } : undefined
  }

  private restore(task: ScheduledTask, snapshot: TaskSnapshot): void {
    task.status = snapshot.status
    task.runAt = snapshot.runAt
    if (snapshot.lastError === undefined) delete task.lastError
    else task.lastError = snapshot.lastError
  }

  private matches(task: ScheduledTask, snapshot: TaskSnapshot): boolean {
    return task.status === snapshot.status
      && task.runAt === snapshot.runAt
      && task.lastError === snapshot.lastError
  }

  private freshRunAt(previous: string, delayMs = 0): string {
    const target = Date.now() + Math.max(0, delayMs)
    const candidate = new Date(target).toISOString()
    return candidate === previous ? new Date(target + 1).toISOString() : candidate
  }

  private async cancelInternal(taskId: string): Promise<boolean> {
    this.clearTimer(taskId)
    return this.queueStateChange(async () => {
      const entry = this.findTask(taskId)
      if (!entry) return false
      const task = entry.task

      this.clearTimer(taskId)
      const before = this.snapshot(task)
      task.status = 'cancelled'
      const cancelledState = this.snapshot(task)
      try {
        await this.onChange()
      } catch (error) {
        if (this.matches(task, cancelledState)) {
          this.restore(task, before)
          if (!this.stopping) {
            if (before.status === 'scheduled') this.armScheduled(task)
            else if (before.status === 'running' && !this.pendingExecutionTaskIds.has(taskId)) {
              this.armRecovery(task)
            }
          }
        }
        throw error
      }
      return true
    })
  }

  private async runNowInternal(taskId: string): Promise<boolean> {
    if (this.stopping) throw new Error('Scheduler is stopped')
    if (this.pendingExecutionTaskIds.has(taskId)) {
      throw new Error(`Task ${taskId} is already executing`)
    }

    this.clearTimer(taskId)
    this.pendingExecutionTaskIds.add(taskId)
    try {
      const task = await this.queueStateChange(async () => {
        if (this.stopping) throw new Error('Scheduler is stopped')
        const entry = this.findTask(taskId)
        if (!entry) return undefined
        const current = entry.task
        if (current.status !== 'scheduled') {
          throw new Error(`Task ${taskId} is not scheduled`)
        }

        this.clearTimer(taskId)
        const before = this.snapshot(current)
        current.runAt = this.freshRunAt(before.runAt)
        const persistedOccurrence = this.snapshot(current)
        try {
          await this.onChange()
        } catch (error) {
          if (this.matches(current, persistedOccurrence)) {
            this.restore(current, before)
            if (!this.stopping) this.armScheduled(current)
          }
          throw error
        }
        return current
      })
      if (!task) return false
      if (this.stopping) return false
      await this.trackExecution(task, false, true)
      return true
    } finally {
      this.pendingExecutionTaskIds.delete(taskId)
    }
  }

  private async deleteTerminalInternal(taskId: string): Promise<boolean> {
    return this.queueStateChange(async () => {
      const entry = this.findTask(taskId)
      if (!entry || !TERMINAL_STATUSES.has(entry.task.status)) return false
      const task = entry.task

      this.clearTimer(taskId)
      delete this.tasks[entry.key]
      try {
        await this.onChange()
      } catch (error) {
        if (this.tasks[entry.key] === undefined) this.tasks[entry.key] = task
        throw error
      }
      return true
    })
  }

  private async execute(task: ScheduledTask, recoverRunning: boolean): Promise<void> {
    const runningState = await this.queueStateChange(async (): Promise<TaskSnapshot | undefined> => {
      if (this.findTaskEntry(task) === undefined) return undefined
      if (recoverRunning) {
        return task.status === 'running' ? this.snapshot(task) : undefined
      }
      if (task.status !== 'scheduled') return undefined

      const before = this.snapshot(task)
      task.status = 'running'
      const pendingRunningState = this.snapshot(task)
      try {
        await this.onChange()
      } catch (error) {
        if (this.matches(task, pendingRunningState)) {
          this.restore(task, before)
          if (!this.stopping) this.armScheduledRetry(task)
        }
        throw error
      }
      return this.snapshot(task)
    })
    if (!runningState) return

    let runFailed = false
    let runError: unknown
    try {
      await this.onRun(task)
    } catch (error) {
      runFailed = true
      runError = error
    }

    await this.queueStateChange(async () => {
      if (
        this.findTaskEntry(task) === undefined ||
        task.status !== 'running' ||
        task.runAt !== runningState.runAt
      ) return

      if (runFailed) {
        const failureMessage = runError instanceof Error ? runError.message : String(runError)
        const failedState: TaskSnapshot = {
          status: 'failed',
          runAt: task.runAt,
          lastError: failureMessage,
        }
        task.status = failedState.status
        task.lastError = failureMessage
        try {
          await this.onChange()
        } catch (error) {
          if (this.matches(task, failedState)) {
            this.restore(task, runningState)
            if (!this.stopping) this.armRecoveryRetry(task)
          }
          throw error
        }
        return
      }

      if (task.repeatMs) {
        const nextRunAt = this.freshRunAt(task.runAt, task.repeatMs)
        task.status = 'scheduled'
        task.runAt = nextRunAt
        delete task.lastError
        const persistedState = this.snapshot(task)
        try {
          await this.onChange()
        } catch (error) {
          if (this.matches(task, persistedState)) {
            this.restore(task, runningState)
            if (!this.stopping) this.armRecoveryRetry(task)
          }
          throw error
        }
        // Persist first, then arm. Cancellation can win while onChange awaited.
        if (!this.stopping && this.matches(task, persistedState)) this.armScheduled(task)
        return
      }

      task.status = 'completed'
      delete task.lastError
      const completedState = this.snapshot(task)
      const entry = this.findTaskEntry(task)
      if (!entry) return
      delete this.tasks[entry.key]
      try {
        await this.onChange()
      } catch (error) {
        if (this.matches(task, completedState) && this.tasks[entry.key] === undefined) {
          this.restore(task, runningState)
          this.tasks[entry.key] = task
          if (!this.stopping) this.armRecoveryRetry(task)
        }
        throw error
      }
    })
  }
}
