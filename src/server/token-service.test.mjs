import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  getConversationUsage,
  getDashboardSummary,
  getTranscriptPath,
  listRecentConversations,
  parseTranscriptTokens,
} from './token-service.mjs';

test('parseTranscriptTokens sums input, output, cache_read, and skips non-token or malformed lines', () => {
  const jsonl = [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'hi' }),
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-17T03:00:00Z',
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_tokens: 800,
      tool_calls: [{ name: 'read_file' }],
    }),
    JSON.stringify({
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-17T03:00:10Z',
      input_tokens: 1500,
      output_tokens: 300,
      cache_read_tokens: 1200,
      tool_calls: [],
    }),
    '{"partial_trailing_line": ',
  ].join('\n');

  const result = parseTranscriptTokens(jsonl);
  assert.equal(result.totals.uncachedInputTokens, 2500);
  assert.equal(result.totals.cacheReadTokens, 2000);
  assert.equal(result.totals.inputTokens, 4500);
  assert.equal(result.totals.outputTokens, 500);
  assert.equal(result.totals.totalTokens, 5000);
  assert.equal(result.totals.cacheHitRate, 2000 / 4500);
  assert.equal(result.totals.stepCount, 2);
  assert.equal(result.totals.latestContextTokens, 2700);
  assert.equal(result.turns.length, 2);
  assert.equal(result.turns[0].toolCallCount, 1);
  assert.equal(result.promptTurns.length, 1);
  assert.equal(result.promptTurns[0].prompt, 'hi');
  assert.equal(result.promptTurns[0].uncachedInputTokens, 2500);
  assert.equal(result.promptTurns[0].outputTokens, 500);
});

test('parseTranscriptTokens strips USER_REQUEST tags and metadata from title', () => {
  const jsonl = [
    JSON.stringify({
      step_index: 0,
      type: 'USER_INPUT',
      content: '<USER_REQUEST>\n  Fix the bug  \n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nfoo\n</ADDITIONAL_METADATA>',
    }),
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      input_tokens: 100,
      output_tokens: 10,
      cache_read_tokens: 0,
    }),
  ].join('\n');

  const result = parseTranscriptTokens(jsonl);
  assert.equal(result.title, 'Fix the bug');
});

test('getTranscriptPath rejects path traversal and invalid IDs', () => {
  assert.equal(getTranscriptPath('/tmp/app', '../etc/passwd'), null);
  assert.equal(getTranscriptPath('/tmp/app', 'short'), null);
  assert.ok(getTranscriptPath('/tmp/app', 'b75b7130-7db2-4986-9629-167bf8987288'));
});

test('getConversationUsage and listRecentConversations read transcript.jsonl from brain dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-tracker-test-'));
  try {
    const convId = 'b75b7130-7db2-4986-9629-167bf8987288';
    const logsDir = join(dir, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      join(logsDir, 'transcript.jsonl'),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        input_tokens: 500,
        output_tokens: 50,
        cache_read_tokens: 250,
      }) + '\n'
    );

    const usage = getConversationUsage(dir, convId);
    assert.equal(usage.found, true);
    assert.equal(usage.totals.totalTokens, 800);
    assert.equal(usage.totals.cacheHitRate, 250 / 750);

    const missing = getConversationUsage(dir, '00000000-0000-0000-0000-000000000000');
    assert.equal(missing.found, false);

    const recent = listRecentConversations(dir);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].conversationId, convId);

    const dash = getDashboardSummary(dir, { days: 7 });
    assert.equal(dash.aggregate.conversationCount, 1);
    assert.equal(dash.aggregate.totalTokens, 800);
    assert.equal(dash.conversations[0].shareOfTotal, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('subagent transcripts roll up into parent conversation and are hidden from dashboard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-tracker-subagent-'));
  try {
    const parentId = 'aaaaaaaa-1111-2222-3333-444444444444';
    const childId = 'bbbbbbbb-1111-2222-3333-444444444444';

    const parentLogs = join(dir, 'brain', parentId, '.system_generated', 'logs');
    const childLogs = join(dir, 'brain', childId, '.system_generated', 'logs');
    mkdirSync(parentLogs, { recursive: true });
    mkdirSync(childLogs, { recursive: true });

    writeFileSync(
      join(parentLogs, 'transcript.jsonl'),
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'Main task' }),
        JSON.stringify({
          step_index: 1,
          type: 'GENERIC',
          content: `Created the following subagent:\n{\n  "conversationId": "${childId}"\n}`,
        }),
        JSON.stringify({
          step_index: 2,
          type: 'PLANNER_RESPONSE',
          input_tokens: 400,
          output_tokens: 100,
          cache_read_tokens: 0,
        }),
      ].join('\n') + '\n'
    );

    writeFileSync(
      join(childLogs, 'transcript.jsonl'),
      JSON.stringify({
        step_index: 0,
        type: 'PLANNER_RESPONSE',
        input_tokens: 200,
        output_tokens: 50,
        cache_read_tokens: 50,
      }) + '\n'
    );

    const usage = getConversationUsage(dir, parentId);
    assert.equal(usage.totals.totalTokens, 800);
    assert.equal(usage.totals.subagentCount, 1);
    assert.equal(usage.totals.subagentTokens, 300);

    const dash = getDashboardSummary(dir, { days: 7 });
    assert.equal(dash.aggregate.conversationCount, 1);
    assert.equal(dash.conversations[0].conversationId, parentId);
    assert.equal(dash.conversations[0].totals.totalTokens, 800);
    assert.equal(dash.conversations[0].totals.subagentCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
