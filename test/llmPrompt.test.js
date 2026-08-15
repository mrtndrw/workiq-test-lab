import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_SYSTEM_PROMPT } from '../src/adapters/llmAdapter.js';

test('orchestration prompt makes Work IQ ask a first-class semantic tool', () => {
  assert.match(DEFAULT_SYSTEM_PROMPT, /FIRST-CLASS discovery and grounding tool/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /mcp_ask, ask_work_iq_rest, or ask_work_iq_a2a/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /finding content related to a topic, project, person, meeting, or document/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /choose the one that best fits the task instead of calling all of them redundantly/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /Never route a write through the agentic "ask" tool/);
});
