import assert from 'node:assert/strict'
import test from 'node:test'
import { KeyedSerialQueue } from '../src/serial.js'

test('keyed serial queue prevents same-key overlap', async () => {
  const queue = new KeyedSerialQueue()
  const order: string[] = []
  let releaseFirst: () => void = () => undefined
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const first = queue.run('thread', async () => {
    order.push('first-start')
    await firstGate
    order.push('first-end')
  })
  const second = queue.run('thread', async () => {
    order.push('second-start')
    order.push('second-end')
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(order, ['first-start'])
  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end'])
})

test('keyed serial queue releases after failure', async () => {
  const queue = new KeyedSerialQueue()
  await assert.rejects(queue.run('thread', async () => {
    throw new Error('fixture failure')
  }))
  assert.equal(await queue.run('thread', async () => 'recovered'), 'recovered')
})
