import assert from 'node:assert/strict'
import test from 'node:test'
import { filterScheduledTasks, TaskScheduler } from '../src/scheduler.js'
import type { ScheduledTask } from '../src/types.js'

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

test('scheduler runs one-time task and persists completion state', async () => {
  const task: ScheduledTask = {
    id: 'one',
    threadId: 'thread',
    prompt: 'hello',
    runAt: new Date(Date.now() + 10).toISOString(),
    createdBy: 'user',
    status: 'scheduled',
  }
  const tasks = { one: task }
  let runs = 0
  const scheduler = new TaskScheduler(tasks, async () => {
    runs += 1
  }, async () => undefined)
  scheduler.start()
  await wait(60)
  assert.equal(runs, 1)
  assert.equal(task.status, 'completed')
  scheduler.stop()
})

test('scheduler repeats until cancellation', async () => {
  const task: ScheduledTask = {
    id: 'repeat',
    threadId: 'thread',
    prompt: 'hello',
    runAt: new Date(Date.now() + 5).toISOString(),
    repeatMs: 15,
    createdBy: 'user',
    status: 'scheduled',
  }
  const scheduler = new TaskScheduler({ repeat: task }, async () => undefined, async () => undefined)
  scheduler.start()
  await wait(50)
  assert.equal(scheduler.cancel('repeat'), true)
  assert.equal(task.status, 'cancelled')
  scheduler.stop()
})

test('task listing hides terminal history unless all is requested', () => {
  const tasks = [
    { id: 'done', threadId: 'thread', prompt: 'done', runAt: new Date(2).toISOString(), createdBy: 'user', status: 'completed' as const },
    { id: 'next', threadId: 'thread', prompt: 'next', runAt: new Date(1).toISOString(), createdBy: 'user', status: 'scheduled' as const },
    { id: 'running', threadId: 'thread', prompt: 'running', runAt: new Date(3).toISOString(), createdBy: 'user', status: 'running' as const },
  ]
  assert.deepEqual(filterScheduledTasks(tasks, false).map((task) => task.id), ['next', 'running'])
  assert.deepEqual(filterScheduledTasks(tasks, true).map((task) => task.id), ['next', 'done', 'running'])
})
