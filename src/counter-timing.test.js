import assert from 'node:assert/strict';
import test from 'node:test';
import { counterWaitMs } from './counter-timing.js';

test('counter waits for the normal arrival target when there is time', () => {
  assert.equal(counterWaitMs(30000, 11000, 2000), 17000);
});

test('counter sends immediately when the normal arrival target has passed', () => {
  assert.equal(counterWaitMs(12500, 11000, 2000), 0);
  assert.equal(counterWaitMs(5000, 11000, 2000), 0);
});
