import type { ScheduledTask } from './types.js'

export function filterScheduledTasks(tasks: ScheduledTask[], includeAll: boolean): ScheduledTask[] {
  return tasks
    .filter((task) => includeAll || task.status === 'scheduled' || task.status === 'running')
    .sort((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt))
}

export class TaskScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly tasks: Record<string, ScheduledTask>,
    private readonly onRun: (task: ScheduledTask) => Promise<void>,
    private readonly onChange: () => Promise<void>,
  ) {}

  start(): void {
    for (const task of Object.values(this.tasks)) {
      if (task.status === 'scheduled') this.schedule(task)
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  schedule(task: ScheduledTask): void {
    const existing = this.timers.get(task.id)
    if (existing) clearTimeout(existing)
    const delay = Math.max(0, Date.parse(task.runAt) - Date.now())
    const timer = setTimeout(() => {
      void this.execute(task)
    }, delay)
    timer.unref()
    this.timers.set(task.id, timer)
  }

  cancel(taskId: string): boolean {
    const task = this.tasks[taskId]
    if (!task) return false
    const timer = this.timers.get(taskId)
    if (timer) clearTimeout(timer)
    this.timers.delete(taskId)
    task.status = 'cancelled'
    void this.onChange()
    return true
  }

  private async execute(task: ScheduledTask): Promise<void> {
    this.timers.delete(task.id)
    if (task.status !== 'scheduled') return
    task.status = 'running'
    await this.onChange()
    try {
      await this.onRun(task)
      task.status = task.repeatMs ? 'scheduled' : 'completed'
      delete task.lastError
      if (task.repeatMs) {
        task.runAt = new Date(Date.now() + task.repeatMs).toISOString()
        this.schedule(task)
      }
    } catch (error) {
      task.status = 'failed'
      task.lastError = error instanceof Error ? error.message : String(error)
    }
    await this.onChange()
  }
}
