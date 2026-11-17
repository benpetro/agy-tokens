import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CONVERSATION_ID_RE = /^[0-9a-f-]{8,}$/i;

export function resolveAppDataDir() {
  return process.env.ANTIGRAVITY_APP_DATA_DIR || join(homedir(), '.gemini', 'antigravity');
}

function toInt(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function cleanPromptText(raw) {
  if (typeof raw !== 'string') return '';
  let text = raw
    .replace(/<ADDITIONAL_METADATA>[\s\S]*$/i, '')
    .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi, '')
    .replace(/The following is a <SYSTEM_MESSAGE>[\s\S]*$/i, '')
    .replace(/<\/?USER_REQUEST>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > 64 ? `${text.slice(0, 61)}…` : text;
}

function extractTitleFromEntry(entry) {
  if (entry?.type === 'USER_INPUT') {
    return cleanPromptText(entry.content) || null;
  }
  return null;
}

function extractFallbackTitle(entry) {
  if (entry?.type === 'SYSTEM_MESSAGE' && typeof entry?.content === 'string') {
    const match = /content=([^\n]+)/.exec(entry.content);
    if (match?.[1]) {
      const cleaned = cleanPromptText(match[1]);
      if (cleaned) return cleaned;
    }
    const cleaned = cleanPromptText(entry.content);
    if (cleaned) return cleaned;
  }
  return null;
}

export function inferWorkspaceFromTranscript(jsonlText) {
  const counts = new Map();
  const codeRe = /\/Users\/[^/\s"'\\]+\/Code\/([^/\s"'\\]+)\/([^/\s"',;\\)]+)/g;
  for (const match of String(jsonlText || '').matchAll(codeRe)) {
    const label = `${match[1]}/${match[2]}`;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  if (counts.size === 0) return null;
  let best = null;
  let bestCount = 0;
  for (const [label, count] of counts.entries()) {
    if (count > bestCount) {
      best = label;
      bestCount = count;
    }
  }
  return best;
}

export function parseTranscriptTokens(jsonlText) {
  const turns = [];
  const promptTurns = [];
  let currentPrompt = null;
  let title = null;
  let fallbackTitle = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;

  for (const rawLine of String(jsonlText || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      // Ignore partial or malformed trailing lines while transcript is actively written.
      continue;
    }

    if (!title) {
      title = extractTitleFromEntry(entry);
    }
    if (!title && !fallbackTitle) {
      fallbackTitle = extractFallbackTitle(entry);
    }

    if (entry.type === 'USER_INPUT') {
      const promptText = cleanPromptText(entry.content) || '(attachment / empty prompt)';
      currentPrompt = {
        prompt: promptText,
        createdAt: typeof entry.created_at === 'string' ? entry.created_at : null,
        uncachedInputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        toolCallCount: 0,
        stepCount: 0,
      };
      promptTurns.push(currentPrompt);
      continue;
    }

    const hasTokenFields =
      typeof entry.input_tokens === 'number' ||
      typeof entry.output_tokens === 'number' ||
      typeof entry.cache_read_tokens === 'number';
    if (!hasTokenFields) continue;

    const stepUncached = toInt(entry.input_tokens);
    const stepOutput = toInt(entry.output_tokens);
    const stepCache = toInt(entry.cache_read_tokens);
    const stepInputTotal = stepUncached + stepCache;
    const stepTools = Array.isArray(entry.tool_calls) ? entry.tool_calls.length : 0;

    inputTokens += stepUncached;
    outputTokens += stepOutput;
    cacheReadTokens += stepCache;

    turns.push({
      stepIndex: typeof entry.step_index === 'number' ? entry.step_index : turns.length,
      createdAt: typeof entry.created_at === 'string' ? entry.created_at : null,
      type: typeof entry.type === 'string' ? entry.type : 'PLANNER_RESPONSE',
      status: typeof entry.status === 'string' ? entry.status : '',
      inputTokens: stepInputTotal,
      outputTokens: stepOutput,
      cacheReadTokens: stepCache,
      uncachedInputTokens: stepUncached,
      toolCallCount: stepTools,
    });

    if (!currentPrompt) {
      currentPrompt = {
        prompt: fallbackTitle || 'Background / System',
        createdAt: typeof entry.created_at === 'string' ? entry.created_at : null,
        uncachedInputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        toolCallCount: 0,
        stepCount: 0,
      };
      promptTurns.push(currentPrompt);
    }

    currentPrompt.uncachedInputTokens += stepUncached;
    currentPrompt.cacheReadTokens += stepCache;
    currentPrompt.outputTokens += stepOutput;
    currentPrompt.toolCallCount += stepTools;
    currentPrompt.stepCount += 1;
    if (typeof entry.created_at === 'string') {
      currentPrompt.createdAt = entry.created_at;
    }
  }

  const uncachedInputTokens = inputTokens;
  const totalInputTokens = uncachedInputTokens + cacheReadTokens;
  const totalTokens = totalInputTokens + outputTokens;
  const cacheHitRate = totalInputTokens > 0 ? cacheReadTokens / totalInputTokens : 0;
  const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;

  return {
    title: title || fallbackTitle,
    totals: {
      inputTokens: totalInputTokens,
      outputTokens,
      cacheReadTokens,
      uncachedInputTokens,
      totalTokens,
      cacheHitRate,
      stepCount: turns.length,
      latestContextTokens: latestTurn ? latestTurn.inputTokens : 0,
    },
    turns,
    promptTurns: promptTurns.filter((p) => p.stepCount > 0),
  };
}

export function getTranscriptPath(appDataDir, conversationId) {
  if (!conversationId || !CONVERSATION_ID_RE.test(String(conversationId))) {
    return null;
  }
  return join(appDataDir, 'brain', String(conversationId), '.system_generated', 'logs', 'transcript.jsonl');
}

export function getConversationUsage(appDataDir, conversationId) {
  const id = typeof conversationId === 'string' ? conversationId.trim() : '';
  const transcriptPath = getTranscriptPath(appDataDir, id);

  if (!transcriptPath || !existsSync(transcriptPath)) {
    return {
      conversationId: id || null,
      found: false,
      updatedAt: null,
      ...parseTranscriptTokens(''),
    };
  }

  const stat = statSync(transcriptPath);
  const raw = readFileSync(transcriptPath, 'utf8');
  return {
    conversationId: id,
    found: true,
    updatedAt: stat.mtime.toISOString(),
    ...parseTranscriptTokens(raw),
  };
}

export function listRecentConversations(appDataDir, limit = 12) {
  const brainDir = join(appDataDir, 'brain');
  if (!existsSync(brainDir)) return [];

  const entries = [];
  for (const dirent of readdirSync(brainDir, { withFileTypes: true })) {
    if (!dirent.isDirectory() || !CONVERSATION_ID_RE.test(dirent.name)) continue;
    const transcriptPath = join(brainDir, dirent.name, '.system_generated', 'logs', 'transcript.jsonl');
    if (!existsSync(transcriptPath)) continue;
    try {
      const stat = statSync(transcriptPath);
      entries.push({
        conversationId: dirent.name,
        mtimeMs: stat.mtimeMs,
        updatedAt: stat.mtime.toISOString(),
      });
    } catch {
      // Skip unreadable entries.
    }
  }

  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries.slice(0, limit).map(({ conversationId, updatedAt }) => ({
    conversationId,
    updatedAt,
  }));
}

export function getDashboardSummary(appDataDir, { limit = 30, days = 7, nowMs = Date.now() } = {}) {
  const brainDir = join(appDataDir, 'brain');
  if (!existsSync(brainDir)) {
    return {
      days,
      aggregate: { totalTokens: 0, uncachedInputTokens: 0, cacheReadTokens: 0, outputTokens: 0, conversationCount: 0 },
      conversations: [],
    };
  }

  const cutoffMs = nowMs - days * 24 * 60 * 60 * 1000;
  const candidates = [];

  for (const dirent of readdirSync(brainDir, { withFileTypes: true })) {
    if (!dirent.isDirectory() || !CONVERSATION_ID_RE.test(dirent.name)) continue;
    const transcriptPath = join(brainDir, dirent.name, '.system_generated', 'logs', 'transcript.jsonl');
    if (!existsSync(transcriptPath)) continue;
    try {
      const stat = statSync(transcriptPath);
      if (stat.mtimeMs < cutoffMs) continue;
      candidates.push({
        conversationId: dirent.name,
        transcriptPath,
        mtimeMs: stat.mtimeMs,
        updatedAt: stat.mtime.toISOString(),
      });
    } catch {
      // Skip unreadable entries.
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const parsed = [];
  let totalTokens = 0;
  let uncachedInputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;

  for (const item of candidates.slice(0, limit)) {
    try {
      const raw = readFileSync(item.transcriptPath, 'utf8');
      const { title, totals } = parseTranscriptTokens(raw);
      if (totals.stepCount === 0) continue;

      totalTokens += totals.totalTokens;
      uncachedInputTokens += totals.uncachedInputTokens;
      cacheReadTokens += totals.cacheReadTokens;
      outputTokens += totals.outputTokens;

      parsed.push({
        conversationId: item.conversationId,
        title: title || `Subagent / Background (${item.conversationId.slice(0, 8)})`,
        inferredWorkspace: inferWorkspaceFromTranscript(raw),
        updatedAt: item.updatedAt,
        totals,
      });
    } catch {
      // Skip unreadable transcripts.
    }
  }

  const conversations = parsed.map((conv) => ({
    ...conv,
    shareOfTotal: totalTokens > 0 ? conv.totals.totalTokens / totalTokens : 0,
  }));

  return {
    days,
    aggregate: {
      totalTokens,
      uncachedInputTokens,
      cacheReadTokens,
      outputTokens,
      conversationCount: conversations.length,
    },
    conversations,
  };
}
