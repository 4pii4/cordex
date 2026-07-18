import assert from 'node:assert/strict'
import test from 'node:test'
import { parseBtwMessage } from '../src/btw.js'

test('btw suffix parsing matches Kimaki message forms', () => {
  assert.deepEqual(parseBtwMessage('fix the bug. btw'), {
    prompt: 'fix the bug',
    fork: true,
  })
  assert.deepEqual(parseBtwMessage('done!btw.'), {
    prompt: 'done',
    fork: true,
  })
  assert.deepEqual(parseBtwMessage('first line\nBTW'), {
    prompt: 'first line',
    fork: true,
  })
  assert.deepEqual(parseBtwMessage('hello btw'), {
    prompt: 'hello btw',
    fork: false,
  })
  assert.deepEqual(parseBtwMessage('btw fix this'), {
    prompt: 'btw fix this',
    fork: false,
  })
})
