import assert from 'node:assert/strict'
import test from 'node:test'
import {
  filterScheduledTasks,
  scheduledTaskDeliveryId,
  TaskScheduler,
} from '../src/scheduler.js'
import type { ScheduledTask } from '../src/types.js'

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

test('scheduled delivery ids are stable per occurrence and change for repeats', () => {
  const task: ScheduledTask = {
    id: 'repeat',
    threadId: 'thread',
    prompt: 'hello',
    runAt: '2026-07-18T00:00:00.000Z',
    repeatMs: 1_000,
    createdBy: 'user',
    status: 'scheduled',
  }
  const first = scheduledTaskDeliveryId(task)
  assert.equal(first, scheduledTaskDeliveryId(task))
  task.runAt = '2026-07-18T00:00:01.000Z'
  assert.notEqual(scheduledTaskDeliveryId(task), first)
})

test('scheduler runs one-time task and persists completion state', async () => {
  const task: ScheduledTask = {
    id: 'one',
    threadId: 'thread',
    prompt: 'hello',
    runAt: new Date(Date.now() + 10).toISOString(),
    createdBy: 'user',
    status: 'scheduled',
  }
  const tasks: Record<string, ScheduledTask> = { one: task }
  let runs = 0
  const scheduler = new TaskScheduler(tasks, async () => {
    runs += 1
  }, async () => undefined)
  scheduler.start()
  await wait(60)
  assert.equal(runs, 1)
  assert.equal(task.status, 'completed')
  assert.equal(tasks.one, undefined)
  scheduler.stop()
})

test('scheduler recovers a persisted running occurrence with its stable delivery id', async () => {
  const task: ScheduledTask = {
    id: 'recover-one',
    threadId: 'thread',
    prompt: 'hello',
    runAt: new Date(Date.now() + 60_000).toISOString(),
    createdBy: 'user',
    status: 'running',
  }
  const occurrenceDeliveryId = scheduledTaskDeliveryId(task)
  let recoveredDeliveryId: string | undefined
  let runs = 0
  let resolveCompleted: (() => void) | undefined
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve
  })
  const tasks: Record<string, ScheduledTask> = { one: task }
  const scheduler = new TaskScheduler(tasks, async (runningTask) => {
    runs += 1
    recoveredDeliveryId = scheduledTaskDeliveryId(runningTask)
  }, async () => {
    if (task.status === 'completed') resolveCompleted?.()
  })

  scheduler.start()
  scheduler.start()
  await Promise.race([
    completed,
    wait(1_000).then(() => assert.fail('persisted running task was not recovered immediately')),
  ])

  assert.equal(recoveredDeliveryId, occurrenceDeliveryId)
  assert.equal(runs, 1)
  assert.equal(task.status, 'completed')
  assert.equal(tasks.one, undefined)
  scheduler.stop()
})

test('recovered repeating task advances its delivery id only after the occurrence succeeds', async () => {
  const task: ScheduledTask = {
    id: 'recover-repeat',
    threadId: 'thread',
    prompt: 'hello',
    runAt: '2026-07-18T00:00:00.000Z',
    repeatMs: 60_000,
    createdBy: 'user',
    status: 'running',
  }
  const recoveredOccurrenceDeliveryId = scheduledTaskDeliveryId(task)
  let attemptedDeliveryId: string | undefined
  let resolveRescheduled: (() => void) | undefined
  const rescheduled = new Promise<void>((resolve) => {
    resolveRescheduled = resolve
  })
  const scheduler = new TaskScheduler({ repeat: task }, async (runningTask) => {
    attemptedDeliveryId = scheduledTaskDeliveryId(runningTask)
  }, async () => {
    if (task.status === 'scheduled') resolveRescheduled?.()
  })

  scheduler.start()
  await Promise.race([
    rescheduled,
    wait(1_000).then(() => assert.fail('recovered repeating task was not rescheduled')),
  ])

  assert.equal(attemptedDeliveryId, recoveredOccurrenceDeliveryId)
  assert.equal(task.status, 'scheduled')
  assert.notEqual(scheduledTaskDeliveryId(task), recoveredOccurrenceDeliveryId)
  scheduler.stop()
})

test('cancelling an in-flight recovered repeat remains final after delivery settles', async (t) => {
  for (const outcome of ['resolve', 'reject'] as const) {
    await t.test(`onRun ${outcome}s`, async () => {
      const runAt = '2026-07-18T00:00:00.000Z'
      const task: ScheduledTask = {
        id: `cancel-in-flight-${outcome}`,
        threadId: 'thread',
        prompt: 'hello',
        runAt,
        repeatMs: 15,
        createdBy: 'user',
        status: 'running',
      }
      let resolveRun: (() => void) | undefined
      let rejectRun: ((error: Error) => void) | undefined
      const inFlight = new Promise<void>((resolve, reject) => {
        resolveRun = resolve
        rejectRun = reject
      })
      let resolveStarted: (() => void) | undefined
      const started = new Promise<void>((resolve) => {
        resolveStarted = resolve
      })
      let runs = 0
      const scheduler = new TaskScheduler({ [task.id]: task }, async () => {
        runs += 1
        resolveStarted?.()
        await inFlight
      }, async () => undefined)

      try {
        scheduler.start()
        await Promise.race([
          started,
          wait(1_000).then(() => assert.fail('recovered task did not start immediately')),
        ])

        assert.equal(await scheduler.cancel(task.id), true)
        assert.equal(task.status, 'cancelled')
        if (outcome === 'resolve') resolveRun?.()
        else rejectRun?.(new Error('delivery failed after cancellation'))

        await wait(60)
        assert.equal(task.status, 'cancelled')
        assert.equal(task.runAt, runAt)
        assert.equal(runs, 1)
      } finally {
        scheduler.stop()
      }
    })
  }
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
  assert.equal(await scheduler.cancel('repeat'), true)
  assert.equal(task.status, 'cancelled')
  scheduler.stop()
})

test('cancel waits for persistence before reporting success', async () => {
  const task: ScheduledTask = {
    id: 'cancel-durable',
    threadId: 'thread',
    prompt: 'hello',
    runAt: new Date(Date.now() + 60_000).toISOString(),
    createdBy: 'user',
    status: 'scheduled',
  }
  let releasePersist: (() => void) | undefined
  const persisted = new Promise<void>((resolve) => {
    releasePersist = resolve
  })
  const scheduler = new TaskScheduler({ [task.id]: task }, async () => undefined, async () => {
    await persisted
  })

  const cancellation = scheduler.cancel(task.id)
  let settled = false
  cancellation.finally(() => {
    settled = true
  }).catch(() => undefined)
  await wait(10)
  assert.equal(task.status, 'cancelled')
  assert.equal(settled, false)

  releasePersist?.()
  assert.equal(await cancellation, true)
  assert.equal(settled, true)
  assert.equal(await scheduler.cancel('missing'), false)
  await scheduler.stopAndDrain()
})

test('failed cancellation rolls back and rearms the original occurrence', async () => {
  const originalRunAt = new Date(Date.now() + 70).toISOString()
  const task: ScheduledTask = {
    id: 'cancel-rollback',
    threadId: 'thread',
    prompt: 'hello',
    runAt: originalRunAt,
    createdBy: 'user',
    status: 'scheduled',
  }
  let changes = 0
  let runs = 0
  const scheduler = new TaskScheduler({ [task.id]: task }, async () => {
    runs += 1
  }, async () => {
    changes += 1
    if (changes === 1) throw new Error('state save failed')
  })

  scheduler.start()
  await assert.rejects(scheduler.cancel(task.id), /state save failed/)
  assert.equal(task.status, 'scheduled')
  assert.equal(task.runAt, originalRunAt)

  await wait(130)
  assert.equal(runs, 1)
  assert.equal(task.status, 'completed')
  await scheduler.stopAndDrain()
})

test('overlapping cancellations serialize persistence and cannot stale-rollback success', async () => {
  const task: ScheduledTask = {
    id: 'cancel-overlap',
    threadId: 'thread',
    prompt: 'hello',
    runAt: new Date(Date.now() + 60_000).toISOString(),
    createdBy: 'user',
    status: 'scheduled',
  }
  let releaseFirstPersist: (() => void) | undefined
  const firstPersistGate = new Promise<void>((resolve) => {
    releaseFirstPersist = resolve
  })
  let resolveFirstPersistStarted: (() => void) | undefined
  const firstPersistStarted = new Promise<void>((resolve) => {
    resolveFirstPersistStarted = resolve
  })
  let changes = 0
  const scheduler = new TaskScheduler({ [task.id]: task }, async () => undefined, async () => {
    changes += 1
    if (changes !== 1) return
    resolveFirstPersistStarted?.()
    await firstPersistGate
    throw new Error('first save failed')
  })

  scheduler.start()
  const first = scheduler.cancel(task.id)
  await firstPersistStarted
  const second = scheduler.cancel(task.id)
  releaseFirstPersist?.()

  await assert.rejects(first, /first save failed/)
  assert.equal(await second, true)
  assert.equal(task.status, 'cancelled')
  assert.equal(changes, 2)
  await scheduler.stopAndDrain()
})

test('failed in-flight cancellation lets the settled execution finalize', async () => {
  const task: ScheduledTask = {
    id: 'cancel-in-flight-rollback',
    threadId: 'thread',
    prompt: 'hello',
    runAt: new Date(Date.now() + 60_000).toISOString(),
    repeatMs: 60_000,
    createdBy: 'user',
    status: 'running',
  }
  let releaseRun: (() => void) | undefined
  const runGate = new Promise<void>((resolve) => {
    releaseRun = resolve
  })
  let resolveRunStarted: (() => void) | undefined
  const runStarted = new Promise<void>((resolve) => {
    resolveRunStarted = resolve
  })
  let releaseCancelPersist: (() => void) | undefined
  const cancelPersistGate = new Promise<void>((resolve) => {
    releaseCancelPersist = resolve
  })
  let resolveCancelPersistStarted: (() => void) | undefined
  const cancelPersistStarted = new Promise<void>((resolve) => {
    resolveCancelPersistStarted = resolve
  })
  let resolveRescheduled: (() => void) | undefined
  const rescheduled = new Promise<void>((resolve) => {
    resolveRescheduled = resolve
  })
  let changes = 0
  const scheduler = new TaskScheduler({ [task.id]: task }, async () => {
    resolveRunStarted?.()
    await runGate
  }, async () => {
    changes += 1
    if (changes === 1) {
      resolveCancelPersistStarted?.()
      await cancelPersistGate
      throw new Error('cancel save failed')
    }
    if (task.status === 'scheduled') resolveRescheduled?.()
  })

  scheduler.start()
  await runStarted
  const cancellation = scheduler.cancel(task.id)
  await cancelPersistStarted
  releaseRun?.()
  await wait(0)
  releaseCancelPersist?.()

  await assert.rejects(cancellation, /cancel save failed/)
  await rescheduled
  assert.equal(task.status, 'scheduled')
  assert.equal(await scheduler.cancel(task.id), true)
  await scheduler.stopAndDrain()
})

test('runNow persists a fresh occurrence before executing it once', async () => {
  const originalRunAt = new Date(Date.now() + 60_000).toISOString()
  const task: ScheduledTask = {
    id: 'run-now',
    threadId: 'thread',
    prompt: 'hello',
    runAt: originalRunAt,
    createdBy: 'user',
    status: 'scheduled',
  }
  const persisted: Array<{ status: ScheduledTask['status']; runAt: string }> = []
  let deliveredId: string | undefined
  let runs = 0
  const tasks: Record<string, ScheduledTask> = { [task.id]: task }
  const scheduler = new TaskScheduler(tasks, async (runningTask) => {
    runs += 1
    deliveredId = scheduledTaskDeliveryId(runningTask)
  }, async () => {
    persisted.push({ status: task.status, runAt: task.runAt })
  })

  scheduler.start()
  assert.equal(await scheduler.runNow(task.id), true)
  assert.equal(runs, 1)
  assert.equal(task.status, 'completed')
  assert.equal(tasks[task.id], undefined)
  assert.notEqual(task.runAt, originalRunAt)
  assert.equal(deliveredId, scheduledTaskDeliveryId(task))
  assert.deepEqual(persisted.map((entry) => entry.status), [
    'scheduled',
    'running',
    'completed',
  ])
  assert.ok(persisted.every((entry) => entry.runAt === task.runAt))

  assert.equal(await scheduler.runNow('missing'), false)
  assert.equal(await scheduler.runNow(task.id), false)
  const terminal = { ...task, id: 'terminal', status: 'completed' as const }
  tasks[terminal.id] = terminal
  await assert.rejects(scheduler.runNow(terminal.id), /not scheduled/)
  await scheduler.stopAndDrain()
})

test('runNow rearms its fresh occurrence when the running transition save fails', async () => {
  const task: ScheduledTask = {
    id: 'run-now-running-save-retry',
    threadId: 'thread',
    prompt: 'hello',
    runAt: new Date(Date.now() + 60_000).toISOString(),
    createdBy: 'user',
    status: 'scheduled',
  }
  const tasks: Record<string, ScheduledTask> = { [task.id]: task }
  const originalRunAt = task.runAt
  let changes = 0
  let runs = 0
  let deliveredId: string | undefined
  let resolveCompleted: (() => void) | undefined
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve
  })
  const scheduler = new TaskScheduler(tasks, async (runningTask) => {
    runs += 1
    deliveredId = scheduledTaskDeliveryId(runningTask)
  }, async () => {
    changes += 1
    if (changes === 2) throw new Error('running save failed')
    if (task.status === 'completed') resolveCompleted?.()
  })

  await assert.rejects(scheduler.runNow(task.id), /running save failed/)
  const freshRunAt = task.runAt
  assert.notEqual(freshRunAt, originalRunAt)
  assert.equal(task.status, 'scheduled')

  await Promise.race([
    completed,
    wait(1_000).then(() => assert.fail('fresh run-now occurrence was not retried')),
  ])
  assert.equal(runs, 1)
  assert.equal(deliveredId, `scheduled:${task.id}:${freshRunAt}`)
  assert.equal(tasks[task.id], undefined)
  await scheduler.stopAndDrain()
})

test('failed one-shot deletion persistence restores the running occurrence for recovery', async () => {
  const task: ScheduledTask = {
    id: 'one-shot-delete-rollback',
    threadId: 'thread',
    prompt: 'hello',
    runAt: new Date(Date.now() + 5).toISOString(),
    createdBy: 'user',
    status: 'scheduled',
  }
  const tasks: Record<string, ScheduledTask> = { [task.id]: task }
  const deliveryIds: string[] = []
  let failDeletion = true
  let resolveDeletionAttempted: (() => void) | undefined
  const deletionAttempted = new Promise<void>((resolve) => {
    resolveDeletionAttempted = resolve
  })
  let resolveDeleted: (() => void) | undefined
  const deleted = new Promise<void>((resolve) => {
    resolveDeleted = resolve
  })
  const scheduler = new TaskScheduler(tasks, async (runningTask) => {
    deliveryIds.push(scheduledTaskDeliveryId(runningTask))
  }, async () => {
    if (tasks[task.id] !== undefined) return
    if (failDeletion) {
      resolveDeletionAttempted?.()
      throw new Error('state save failed')
    }
    resolveDeleted?.()
  })

  scheduler.start()
  await deletionAttempted
  await scheduler.stopAndDrain()
  assert.equal(tasks[task.id], task)
  assert.equal(task.status, 'running')

  failDeletion = false
  scheduler.start()
  await deleted
  await scheduler.stopAndDrain()
  assert.equal(tasks[task.id], undefined)
  assert.equal(task.status, 'completed')
  assert.equal(deliveryIds.length, 2)
  assert.equal(deliveryIds[0], deliveryIds[1])
})

test('failed runNow persistence restores and rearms the prior occurrence', async () => {
  const originalRunAt = new Date(Date.now() + 70).toISOString()
  const task: ScheduledTask = {
    id: 'run-now-rollback',
    threadId: 'thread',
    prompt: 'hello',
    runAt: originalRunAt,
    createdBy: 'user',
    status: 'scheduled',
  }
  let changes = 0
  let runs = 0
  let deliveredId: string | undefined
  const scheduler = new TaskScheduler({ [task.id]: task }, async (runningTask) => {
    runs += 1
    deliveredId = scheduledTaskDeliveryId(runningTask)
  }, async () => {
    changes += 1
    if (changes === 1) throw new Error('state save failed')
  })

  scheduler.start()
  await assert.rejects(scheduler.runNow(task.id), /state save failed/)
  assert.equal(task.status, 'scheduled')
  assert.equal(task.runAt, originalRunAt)

  await wait(130)
  assert.equal(runs, 1)
  assert.equal(deliveredId, `scheduled:${task.id}:${originalRunAt}`)
  await scheduler.stopAndDrain()
})

test('deleteTerminal persists deletion and restores it on failure', async () => {
  const completed: ScheduledTask = {
    id: 'completed',
    threadId: 'thread',
    prompt: 'done',
    runAt: new Date().toISOString(),
    createdBy: 'user',
    status: 'completed',
  }
  const scheduled: ScheduledTask = {
    id: 'scheduled',
    threadId: 'thread',
    prompt: 'later',
    runAt: new Date(Date.now() + 60_000).toISOString(),
    createdBy: 'user',
    status: 'scheduled',
  }
  const tasks = { completed, scheduled }
  let absentWhilePersisting = false
  const scheduler = new TaskScheduler(tasks, async () => undefined, async () => {
    absentWhilePersisting = tasks.completed === undefined
  })

  assert.equal(await scheduler.deleteTerminal('missing'), false)
  assert.equal(await scheduler.deleteTerminal('scheduled'), false)
  assert.equal(await scheduler.deleteTerminal('completed'), true)
  assert.equal(absentWhilePersisting, true)
  assert.equal(tasks.completed, undefined)

  const failed: ScheduledTask = { ...completed, id: 'failed-delete', status: 'failed' }
  const failedTasks: Record<string, ScheduledTask> = { [failed.id]: failed }
  const failingScheduler = new TaskScheduler(failedTasks, async () => undefined, async () => {
    throw new Error('state save failed')
  })
  await assert.rejects(failingScheduler.deleteTerminal(failed.id), /state save failed/)
  assert.equal(failedTasks[failed.id], failed)
  await scheduler.stopAndDrain()
  await failingScheduler.stopAndDrain()
})

test('deleteTerminal does not clear a non-terminal task timer', async () => {
  const task: ScheduledTask = {
    id: 'delete-scheduled-preserves-timer',
    threadId: 'thread',
    prompt: 'hello',
    runAt: new Date(Date.now() + 15).toISOString(),
    createdBy: 'user',
    status: 'scheduled',
  }
  const tasks: Record<string, ScheduledTask> = { [task.id]: task }
  let runs = 0
  const scheduler = new TaskScheduler(tasks, async () => {
    runs += 1
  }, async () => undefined)

  scheduler.start()
  assert.equal(await scheduler.deleteTerminal(task.id), false)
  await wait(60)
  assert.equal(runs, 1)
  assert.equal(tasks[task.id], undefined)
  await scheduler.stopAndDrain()
})

test('stopAndDrain waits for active execution and prevents a repeat timer from rearming', async () => {
  const task: ScheduledTask = {
    id: 'drain',
    threadId: 'thread',
    prompt: 'hello',
    runAt: new Date(Date.now() + 5).toISOString(),
    repeatMs: 10,
    createdBy: 'user',
    status: 'scheduled',
  }
  let releaseRun: (() => void) | undefined
  const runGate = new Promise<void>((resolve) => {
    releaseRun = resolve
  })
  let resolveStarted: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve
  })
  let runs = 0
  const scheduler = new TaskScheduler({ [task.id]: task }, async () => {
    runs += 1
    resolveStarted?.()
    await runGate
  }, async () => undefined)

  scheduler.start()
  await started
  const firstDrain = scheduler.stopAndDrain()
  const secondDrain = scheduler.stopAndDrain()
  assert.equal(firstDrain, secondDrain)
  scheduler.start()
  let drained = false
  firstDrain.then(() => {
    drained = true
  }).catch(() => undefined)
  await wait(20)
  assert.equal(drained, false)

  releaseRun?.()
  await firstDrain
  assert.equal(task.status, 'scheduled')
  await wait(30)
  assert.equal(runs, 1)
  await assert.rejects(scheduler.runNow(task.id), /stopped/)
  await scheduler.stopAndDrain()
})

test('a repeating task is not armed until its next occurrence is persisted', async () => {
  const task: ScheduledTask = {
    id: 'repeat-persist-first',
    threadId: 'thread',
    prompt: 'hello',
    runAt: new Date(Date.now() + 5).toISOString(),
    repeatMs: 20,
    createdBy: 'user',
    status: 'scheduled',
  }
  let releaseNextPersist: (() => void) | undefined
  const nextPersistGate = new Promise<void>((resolve) => {
    releaseNextPersist = resolve
  })
  let resolveNextPersistStarted: (() => void) | undefined
  const nextPersistStarted = new Promise<void>((resolve) => {
    resolveNextPersistStarted = resolve
  })
  let releaseSecondRun: (() => void) | undefined
  const secondRunGate = new Promise<void>((resolve) => {
    releaseSecondRun = resolve
  })
  let resolveSecondRun: (() => void) | undefined
  const secondRunStarted = new Promise<void>((resolve) => {
    resolveSecondRun = resolve
  })
  let runs = 0
  const scheduler = new TaskScheduler({ [task.id]: task }, async () => {
    runs += 1
    if (runs === 2) {
      resolveSecondRun?.()
      await secondRunGate
    }
  }, async () => {
    if (task.status === 'scheduled' && runs === 1) {
      resolveNextPersistStarted?.()
      await nextPersistGate
    }
  })

  scheduler.start()
  await nextPersistStarted
  await wait(45)
  assert.equal(runs, 1)

  releaseNextPersist?.()
  await secondRunStarted
  assert.equal(runs, 2)
  assert.equal(await scheduler.cancel(task.id), true)
  releaseSecondRun?.()
  await scheduler.stopAndDrain()
  assert.equal(task.status, 'cancelled')
})

test('timer persistence failures do not become unhandled rejections', async () => {
  const task: ScheduledTask = {
    id: 'handled-rejection',
    threadId: 'thread',
    prompt: 'hello',
    runAt: new Date(Date.now() + 5).toISOString(),
    createdBy: 'user',
    status: 'scheduled',
  }
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  const tasks: Record<string, ScheduledTask> = { [task.id]: task }
  let changes = 0
  let runs = 0
  let resolveCompleted: (() => void) | undefined
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve
  })
  const scheduler = new TaskScheduler(tasks, async () => {
    runs += 1
  }, async () => {
    changes += 1
    if (changes === 1) throw new Error('state save failed')
    if (task.status === 'completed') resolveCompleted?.()
  })

  try {
    scheduler.start()
    await Promise.race([
      completed,
      wait(1_000).then(() => assert.fail('scheduled occurrence was not retried')),
    ])
    assert.deepEqual(unhandled, [])
    assert.equal(runs, 1)
    assert.equal(task.status, 'completed')
    assert.equal(tasks[task.id], undefined)
  } finally {
    process.off('unhandledRejection', onUnhandled)
    await scheduler.stopAndDrain()
  }
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
