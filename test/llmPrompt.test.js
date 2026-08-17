import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAgentUserMessage,
  buildMcpCallArgs,
  DEFAULT_SYSTEM_PROMPT,
  securedSystemPrompt,
  WORK_CONTEXT_INSTRUCTIONS,
} from '../src/adapters/llmAdapter.js';

test('orchestration prompt makes Work IQ ask a first-class semantic tool', () => {
  assert.match(DEFAULT_SYSTEM_PROMPT, /FIRST-CLASS discovery and grounding tool/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /mcp_ask, ask_work_iq_rest, or ask_work_iq_a2a/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /finding content related to a topic, project, person, meeting, or document/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /choose the one that best fits the task instead of calling all of them redundantly/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /Never route a write through the agentic "ask" tool/);
});

test('orchestration prompt explains server-injected Work Context URLs', () => {
  assert.match(DEFAULT_SYSTEM_PROMPT, /Application-provided Work Context/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /mcp_ask when its schema supports fileUrls, or ask_work_iq_rest/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /Do not use A2A or raw MCP entity tools/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /never invent, copy, or replace fileUrls/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /Decide whether the attached content can materially improve the answer/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /do not call a file-aware tool merely because a URL is present/);
  assert.doesNotMatch(DEFAULT_SYSTEM_PROMPT, /requires? that compatible Work IQ ask call/);
  assert.match(securedSystemPrompt('Custom orchestrator instructions'), new RegExp(WORK_CONTEXT_INSTRUCTIONS));
});

test('agent message announces attached files without exposing their URLs', () => {
  const url = 'https://contoso.sharepoint.com/sites/demo/Shared%20Documents/private-plan.docx';
  const message = buildAgentUserMessage('Summarize the attached plan.', {
    files: [{ uri: url }],
    compatibleTools: ['mcp_ask', 'ask_work_iq_rest'],
  });

  assert.match(message, /1 HTTPS Work Context URL is attached/);
  assert.match(message, /mcp_ask or ask_work_iq_rest/);
  assert.match(message, /Decide whether the attached content is relevant/);
  assert.match(message, /When it is relevant, use one of those tools/);
  assert.equal(message.includes(url), false);
});

test('MCP dispatch overrides model-generated fileUrls with validated attachments', () => {
  const url = 'https://contoso.sharepoint.com/sites/demo/Shared%20Documents/private-plan.docx';
  const callArgs = buildMcpCallArgs(
    {
      question: 'Inspect the attached plan.',
      fileUrls: ['https://model-invented.invalid/placeholder.docx'],
    },
    { mcpHasAgentId: true, mcpHasFileUrls: true, mcpHasConversationId: true },
    {
      agentId: 'selected-agent',
      files: [{ uri: url }],
      conversationId: 'existing-conversation',
    }
  );

  assert.deepEqual(callArgs, {
    question: 'Inspect the attached plan.',
    agentId: 'selected-agent',
    fileUrls: [url],
    conversationId: 'existing-conversation',
  });
});

test('agent rejects attached Work Context when no compatible backend is enabled', () => {
  assert.throws(
    () =>
      buildAgentUserMessage('Summarize the attached plan.', {
        files: [{ uri: 'https://contoso.sharepoint.com/plan.docx' }],
        compatibleTools: [],
      }),
    /requires REST or an MCP ask tool that supports fileUrls/
  );
});
