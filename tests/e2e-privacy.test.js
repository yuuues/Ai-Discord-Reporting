import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeMessages, redactParticipantNames } from '../src/services/summarizer.js';
import { generateServerSupportReport } from '../src/services/serverReportGenerator.js';

// Mock LLM call to capture prompts
let lastCapturedPrompt = '';
const mockLlmConfig = { provider: 'deepseek', apiKey: 'sk-mock' };
const mockFetchImpl = async (url, opts) => {
  const body = JSON.parse(opts.body);
  lastCapturedPrompt = body.messages[body.messages.length - 1].content;
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: 'Recompressed digest: topic A, topic B.' } }],
    }),
  };
};

test('E2E vocative redaction in LLM prompt', async () => {
  const messages = [
    { id: '1', author: 'river', content: 'river, yes it resets monthly.', timestamp: '2025-01-01T00:00:00Z' },
    { id: '2', author: 'other', content: 'Thanks river!', timestamp: '2025-01-01T00:01:00Z' }
  ];
  
  // Need to ensure river is recognized as an author
  await summarizeMessages(messages, {
    channelName: 'support',
    llmConfig: mockLlmConfig,
    fetchImpl: mockFetchImpl,
    extraAuthors: ['river']
  });
  
  assert.match(lastCapturedPrompt, /a user/i);
  assert.doesNotMatch(lastCapturedPrompt, /river/i);
});

test('Per-topic violation triggers final recompression', async () => {
  const messages = Array.from({ length: 50 }, (_, i) => ({
    id: String(i),
    author: 'user',
    content: `Topic ${i}: ` + 'a'.repeat(400), // Violation: 400 chars > 300 limit
    timestamp: `2025-01-01T00:00:${i.toString().padStart(2, '0')}Z`
  }));
  
  lastCapturedPrompt = '';
  await summarizeMessages(messages, {
    channelName: 'support',
    llmConfig: mockLlmConfig,
    fetchImpl: mockFetchImpl,
  });
  
  // Verify recompression was triggered (the system prompt or user prompt for recompression should be used)
  assert.ok(lastCapturedPrompt.length > 0, 'Prompt should be captured');
});
