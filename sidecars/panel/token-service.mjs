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

const SUBAGENT_RE = /Created the following subagent:\s*\{\s*"conversationId":\s*"([0-9a-f-]{8,})"/gi;

export function computeEfficiencyRating({
  cacheHitRate = 0,
  uncachedInputTokens = 0,
  outputTokens = 0,
  toolCallCount = 0,
  stepCount = 0,
  errorCount = 0,
  latestContextTokens = 0,
}) {
  if (stepCount === 0) return null;
  const cacheScore = Math.min(35, (cacheHitRate / 0.92) * 35);
  const errorRate = errorCount / stepCount;
  const cleanScore = Math.max(0, 25 * (1 - errorRate * 4));
  const workUnits = outputTokens + toolCallCount * 1500;
  const workRatio = uncachedInputTokens > 0 ? workUnits / uncachedInputTokens : 1;
  const workScore = Math.min(40, (workRatio / 0.3) * 40);

  let bloatPenalty = 0;
  if (uncachedInputTokens > 5_000_000) bloatPenalty += Math.min(10, Math.floor((uncachedInputTokens - 5_000_000) / 2_000_000) * 2 + 2);
  if (latestContextTokens > 250_000) bloatPenalty += 5;

  const score = Math.max(0, Math.min(100, Math.round(cacheScore + cleanScore + workScore - bloatPenalty)));

  let grade = 'D';
  if (score >= 84) grade = 'A';
  else if (score >= 68) grade = 'B';
  else if (score >= 50) grade = 'C';

  let advice = 'Lean prompt & strong cache reuse.';
  if (errorRate > 0.05) {
    advice = 'High step error rate — give exact file paths or constraints upfront.';
  } else if (cacheHitRate < 0.8) {
    advice = 'Low cache hit — keep related follow-ups in one thread to reuse cache.';
  } else if (latestContextTokens > 250_000 || uncachedInputTokens > 5_000_000) {
    advice = 'Context is heavy — start a fresh conversation or run /compact.';
  } else if (workRatio < 0.15) {
    advice = 'High uncached reads per output — point directly to target files.';
  }

  return {
    grade,
    score,
    errorRate,
    workRatio,
    advice,
  };
}

export function parseTranscriptTokens(jsonlText) {
  const turns = [];
  const promptTurns = [];
  const subagentIds = new Set();
  let currentPrompt = null;
  let title = null;
  let fallbackTitle = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let totalToolCalls = 0;
  let errorCount = 0;

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

    if (entry.type === 'GENERIC' && typeof entry.content === 'string') {
      for (const m of entry.content.matchAll(SUBAGENT_RE)) {
        subagentIds.add(m[1]);
      }
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
    totalToolCalls += stepTools;
    if (entry.status === 'ERROR') errorCount += 1;

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
    subagentIds: [...subagentIds],
    totals: {
      inputTokens: totalInputTokens,
      outputTokens,
      cacheReadTokens,
      uncachedInputTokens,
      totalTokens,
      cacheHitRate,
      stepCount: turns.length,
      toolCallCount: totalToolCalls,
      errorCount,
      latestContextTokens: latestTurn ? latestTurn.inputTokens : 0,
      rating: computeEfficiencyRating({
        cacheHitRate,
        uncachedInputTokens,
        outputTokens,
        toolCallCount: totalToolCalls,
        stepCount: turns.length,
        errorCount,
        latestContextTokens: latestTurn ? latestTurn.inputTokens : 0,
      }),
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

function collectSubagentRollup(appDataDir, childIds, visited) {
  let subagentCount = 0;
  let uncachedInputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;

  for (const childId of childIds) {
    if (visited.has(childId)) continue;
    visited.add(childId);
    const childPath = getTranscriptPath(appDataDir, childId);
    if (!childPath || !existsSync(childPath)) continue;
    try {
      const childRaw = readFileSync(childPath, 'utf8');
      const childParsed = parseTranscriptTokens(childRaw);
      subagentCount += 1;
      uncachedInputTokens += childParsed.totals.uncachedInputTokens;
      cacheReadTokens += childParsed.totals.cacheReadTokens;
      outputTokens += childParsed.totals.outputTokens;

      const nested = collectSubagentRollup(appDataDir, childParsed.subagentIds, visited);
      subagentCount += nested.subagentCount;
      uncachedInputTokens += nested.uncachedInputTokens;
      cacheReadTokens += nested.cacheReadTokens;
      outputTokens += nested.outputTokens;
    } catch {
      // Skip unreadable child transcripts.
    }
  }

  return { subagentCount, uncachedInputTokens, cacheReadTokens, outputTokens };
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
  const parsed = parseTranscriptTokens(raw);
  const visited = new Set([id]);
  const sub = collectSubagentRollup(appDataDir, parsed.subagentIds, visited);

  const uncachedInputTokens = parsed.totals.uncachedInputTokens + sub.uncachedInputTokens;
  const cacheReadTokens = parsed.totals.cacheReadTokens + sub.cacheReadTokens;
  const inputTokens = uncachedInputTokens + cacheReadTokens;
  const outputTokens = parsed.totals.outputTokens + sub.outputTokens;
  const totalTokens = inputTokens + outputTokens;
  const cacheHitRate = inputTokens > 0 ? cacheReadTokens / inputTokens : 0;
  const subagentTokens = sub.uncachedInputTokens + sub.cacheReadTokens + sub.outputTokens;
  const rating = computeEfficiencyRating({
    cacheHitRate,
    uncachedInputTokens,
    outputTokens,
    toolCallCount: parsed.totals.toolCallCount,
    stepCount: parsed.totals.stepCount,
    errorCount: parsed.totals.errorCount,
    latestContextTokens: parsed.totals.latestContextTokens,
  });

  return {
    conversationId: id,
    found: true,
    updatedAt: stat.mtime.toISOString(),
    ...parsed,
    totals: {
      ...parsed.totals,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      uncachedInputTokens,
      totalTokens,
      cacheHitRate,
      rating,
      subagentCount: sub.subagentCount,
      subagentTokens,
    },
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

  const parsedById = new Map();
  const childToParent = new Map();

  for (const item of candidates.slice(0, limit * 2)) {
    try {
      const raw = readFileSync(item.transcriptPath, 'utf8');
      const { title, subagentIds, totals } = parseTranscriptTokens(raw);
      if (totals.stepCount === 0) continue;

      for (const childId of subagentIds) {
        if (childId !== item.conversationId && !childToParent.has(childId)) {
          childToParent.set(childId, item.conversationId);
        }
      }

      parsedById.set(item.conversationId, {
        conversationId: item.conversationId,
        title: title || `Subagent / Background (${item.conversationId.slice(0, 8)})`,
        inferredWorkspace: inferWorkspaceFromTranscript(raw),
        updatedAt: item.updatedAt,
        totals: { ...totals, subagentCount: 0, subagentTokens: 0 },
      });
    } catch {
      // Skip unreadable transcripts.
    }
  }

  const findRoot = (id) => {
    const seen = new Set([id]);
    let cur = id;
    while (childToParent.has(cur)) {
      const parent = childToParent.get(cur);
      if (seen.has(parent)) break;
      seen.add(parent);
      cur = parent;
    }
    return cur;
  };

  // Roll child subagent tokens into their root parent conversation.
  for (const [id, conv] of parsedById.entries()) {
    const rootId = findRoot(id);
    if (rootId === id) continue;
    const root = parsedById.get(rootId);
    if (root) {
      root.totals.uncachedInputTokens += conv.totals.uncachedInputTokens;
      root.totals.cacheReadTokens += conv.totals.cacheReadTokens;
      root.totals.inputTokens += conv.totals.inputTokens;
      root.totals.outputTokens += conv.totals.outputTokens;
      root.totals.totalTokens += conv.totals.totalTokens;
      root.totals.stepCount += conv.totals.stepCount;
      root.totals.toolCallCount += conv.totals.toolCallCount;
      root.totals.errorCount += conv.totals.errorCount;
      root.totals.cacheHitRate =
        root.totals.inputTokens > 0 ? root.totals.cacheReadTokens / root.totals.inputTokens : 0;
      root.totals.rating = computeEfficiencyRating({
        cacheHitRate: root.totals.cacheHitRate,
        uncachedInputTokens: root.totals.uncachedInputTokens,
        outputTokens: root.totals.outputTokens,
        toolCallCount: root.totals.toolCallCount,
        stepCount: root.totals.stepCount,
        errorCount: root.totals.errorCount,
        latestContextTokens: root.totals.latestContextTokens,
      });
      root.totals.subagentCount += 1 + conv.totals.subagentCount;
      root.totals.subagentTokens += conv.totals.totalTokens + conv.totals.subagentTokens;
      if (conv.updatedAt > root.updatedAt) {
        root.updatedAt = conv.updatedAt;
      }
    }
  }

  const topLevel = [];
  let totalTokens = 0;
  let uncachedInputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;

  for (const [id, conv] of parsedById.entries()) {
    if (childToParent.has(id)) continue;
    topLevel.push(conv);
    if (topLevel.length >= limit) break;
  }

  for (const conv of topLevel) {
    totalTokens += conv.totals.totalTokens;
    uncachedInputTokens += conv.totals.uncachedInputTokens;
    cacheReadTokens += conv.totals.cacheReadTokens;
    outputTokens += conv.totals.outputTokens;
  }

  const conversations = topLevel.map((conv) => ({
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
