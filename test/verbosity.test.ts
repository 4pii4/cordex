import assert from 'node:assert/strict'
import test from 'node:test'
import {
  defaultVerbosity,
  showStatusFooter,
} from '../src/verbosity.js'

test('verbosity levels match Kimaki output filtering', () => {
  assert.equal(defaultVerbosity, 'tools_and_text')
  assert.equal(showStatusFooter('tools_and_text'), true)
  assert.equal(showStatusFooter('text_and_essential_tools'), true)
  assert.equal(showStatusFooter('text_only'), false)
})
