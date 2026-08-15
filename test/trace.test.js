import assert from 'node:assert/strict';
import test from 'node:test';

import { Trace, tracedFetch } from '../src/trace.js';

test('live trace steps remove conversation identifiers', () => {
  const events = [];
  const trace = new Trace({ onStep: (event) => events.push(event) });

  trace.info('Continuing conversation (contextId confidential-id)', { kind: 'info' });

  assert.deepEqual(
    events.map(({ title, state }) => ({ title, state })),
    [
      { title: 'Continue existing conversation', state: 'running' },
      { title: 'Continue existing conversation', state: 'complete' },
    ]
  );
  assert.equal(JSON.stringify(events).includes('confidential-id'), false);
});

test('live HTTP steps expose metadata but no request or response content', async () => {
  const events = [];
  const trace = new Trace({ onStep: (event) => events.push(event) });

  await tracedFetch(trace, 'Fetch test resource', 'data:application/json,%7B%22secret%22%3A%22private%22%7D', {
    headers: { Authorization: 'Bearer confidential-token' },
  });

  assert.equal(events[0].state, 'running');
  assert.equal(events.at(-1).state, 'complete');
  assert.equal(events.at(-1).status, 200);
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes('confidential-token'), false);
  assert.equal(serialized.includes('private'), false);
  assert.equal(serialized.includes('data:application'), false);
});
