import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';

import {
  getConversationUsage,
  getDashboardSummary,
  listRecentConversations,
  resolveAppDataDir,
} from './token-service.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appDataDir = resolveAppDataDir();
const app = new SidecarApp();

function jsonError(err, status = 400) {
  const message = err instanceof Error ? err.message : String(err || 'Unknown error');
  return new Response(JSON.stringify({ error: message }), {
    status,
    contentType: 'application/json',
  });
}

const noCacheHeaders = { 'Cache-Control': 'no-store' };

app.page(
  '/',
  () => new Response(readFileSync(join(here, 'index.html'), 'utf8'), { contentType: 'text/html', headers: noCacheHeaders })
);
app.page(
  '/app.js',
  () => new Response(readFileSync(join(here, 'app.js'), 'utf8'), { contentType: 'application/javascript', headers: noCacheHeaders })
);
app.page(
  '/tips.js',
  () => new Response(readFileSync(join(here, 'tips.js'), 'utf8'), { contentType: 'application/javascript', headers: noCacheHeaders })
);
app.api(
  '/styles.css',
  () =>
    new Response(readFileSync(join(here, 'styles.css'), 'utf8'), {
      contentType: 'text/css',
      headers: noCacheHeaders,
    }),
  'GET'
);

async function fetchUserStatusAndModels() {
  const addr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!addr || !csrf) return { quota: null, modelLabels: new Map() };

  try {
    const res = await fetch(`http://${addr}/exa.language_server_pb.LanguageServerService/GetUserStatus`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-codeium-csrf-token': csrf,
      },
      body: '{}',
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return { quota: null, modelLabels: new Map() };
    const payload = await res.json();
    const configs = payload?.userStatus?.cascadeModelConfigData?.clientModelConfigs;
    if (!Array.isArray(configs)) return { quota: null, modelLabels: new Map() };

    const modelLabels = new Map();
    for (const c of configs) {
      const id = c?.modelOrAlias?.model;
      if (typeof id === 'string' && typeof c?.label === 'string') {
        modelLabels.set(id, c.label);
      }
    }

    const geminiWithQuota = configs.find(
      (c) => typeof c?.label === 'string' && c.label.includes('Gemini') && typeof c?.quotaInfo?.remainingFraction === 'number'
    );
    const anyWithQuota = geminiWithQuota || configs.find((c) => typeof c?.quotaInfo?.remainingFraction === 'number');
    if (!anyWithQuota) return { quota: null, modelLabels };

    const remainingFraction = Math.min(1, Math.max(0, anyWithQuota.quotaInfo.remainingFraction));
    return {
      quota: {
        remainingFraction,
        usedFraction: 1 - remainingFraction,
        resetTime: anyWithQuota.quotaInfo.resetTime || null,
        planName: payload?.userStatus?.planStatus?.planInfo?.planName || null,
      },
      modelLabels,
    };
  } catch {
    return { quota: null, modelLabels: new Map() };
  }
}

async function fetchQuotaStatus() {
  const { quota } = await fetchUserStatusAndModels();
  return quota;
}

async function fetchStepModels(convId, modelLabels) {
  const addr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!addr || !csrf || !convId) return new Map();

  try {
    const res = await fetch(`http://${addr}/exa.language_server_pb.LanguageServerService/GetCascadeTrajectorySteps`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-codeium-csrf-token': csrf,
      },
      body: JSON.stringify({ cascadeId: convId }),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return new Map();
    const payload = await res.json();
    const steps = Array.isArray(payload?.steps) ? payload.steps : [];
    const map = new Map();
    for (let i = 0; i < steps.length; i += 1) {
      const modelId = steps[i]?.metadata?.generatorModel;
      if (typeof modelId === 'string' && modelId.length > 0) {
        map.set(i, modelLabels.get(modelId) || modelId);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

const META_CACHE_PATH = join(appDataDir, 'sidecar_data', 'agy-tokens', 'meta-cache.json');

function loadMetaCache() {
  try {
    if (!existsSync(META_CACHE_PATH)) return new Map();
    const raw = JSON.parse(readFileSync(META_CACHE_PATH, 'utf8'));
    return new Map(Object.entries(raw || {}));
  } catch {
    return new Map();
  }
}

function saveMetaCache(map) {
  try {
    mkdirSync(dirname(META_CACHE_PATH), { recursive: true });
    writeFileSync(META_CACHE_PATH, JSON.stringify(Object.fromEntries(map), null, 2));
  } catch {
    // Non-fatal cache write error.
  }
}

async function fetchCascadeMetadata() {
  const map = loadMetaCache();
  const addr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!addr || !csrf) return map;

  try {
    const res = await fetch(`http://${addr}/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-codeium-csrf-token': csrf,
      },
      body: '{}',
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return map;
    const payload = await res.json();
    const summaries = payload?.trajectorySummaries;
    if (!summaries || typeof summaries !== 'object') return map;

    let changed = false;
    for (const [id, val] of Object.entries(summaries)) {
      const uris = Array.isArray(val?.workspaces)
        ? val.workspaces.map((w) => w?.workspaceFolderAbsoluteUri).filter((u) => typeof u === 'string' && u.length > 0)
        : [];
      const names = uris.map((u) => {
        try {
          const clean = decodeURIComponent(u.replace(/^file:\/\//, '').replace(/\/+$/, ''));
          return clean.split('/').filter(Boolean).pop() || clean;
        } catch {
          return u;
        }
      });
      const workspaceName =
        names.length === 0
          ? null
          : names.length === 1
            ? names[0]
            : `${names[0]} +${names.length - 1}`;
      map.set(id, {
        summary: typeof val?.summary === 'string' && val.summary.trim() ? val.summary.trim() : null,
        workspaceName,
      });
      changed = true;
    }
    if (changed) saveMetaCache(map);
    return map;
  } catch {
    return map;
  }
}

async function handleUsage(data = {}) {
  try {
    const convId =
      (typeof data.conversationId === 'string' && data.conversationId.trim()) ||
      app.config.conversationId ||
      '';
    const [usage, statusAndModels, metaMap] = await Promise.all([
      Promise.resolve(getConversationUsage(appDataDir, convId)),
      fetchUserStatusAndModels(),
      fetchCascadeMetadata(),
    ]);
    const { quota, modelLabels } = statusAndModels;
    const stepModels = usage.found ? await fetchStepModels(convId, modelLabels) : new Map();

    const promptTurns = (usage.promptTurns || []).map((turn) => {
      const models = new Set();
      for (const idx of turn.stepIndices || []) {
        const m = stepModels.get(idx);
        if (m) models.add(m);
      }
      return {
        ...turn,
        model: models.size > 0 ? [...models].join(', ') : null,
      };
    });

    let estQuotaShare = null;

    if (quota && usage.found && usage.totals.totalTokens > 0) {
      const summary = getDashboardSummary(appDataDir, { days: 7, limit: 50 });
      if (summary.aggregate.totalTokens > 0) {
        estQuotaShare = (usage.totals.totalTokens / summary.aggregate.totalTokens) * quota.usedFraction;
      }
    }

    const meta = metaMap.get(convId);
    const title = meta?.summary || usage.title || 'Untitled conversation';
    return { ...usage, promptTurns, title, quota, estQuotaShare };
  } catch (err) {
    return jsonError(err, 400);
  }
}

app.api('/api/usage', handleUsage, 'GET');
app.api('/api/usage', handleUsage, 'POST');

app.api(
  '/api/dashboard',
  async (data = {}) => {
    try {
      const days = Number(data.days) > 0 ? Math.min(30, Number(data.days)) : 7;
      const [summary, quota, metaMap] = await Promise.all([
        Promise.resolve(getDashboardSummary(appDataDir, { days, limit: 40 })),
        fetchQuotaStatus(),
        fetchCascadeMetadata(),
      ]);

      const conversations = summary.conversations.map((conv) => {
        const meta = metaMap.get(conv.conversationId);
        return {
          ...conv,
          title: meta?.summary || conv.title,
          workspaceName: meta?.workspaceName || conv.inferredWorkspace || 'No workspace',
          estQuotaShare: quota ? conv.shareOfTotal * quota.usedFraction : null,
        };
      });

      return { ...summary, quota, conversations };
    } catch (err) {
      return jsonError(err, 400);
    }
  },
  'GET'
);

app.api(
  '/api/conversations',
  () => {
    try {
      return { conversations: listRecentConversations(appDataDir, 15) };
    } catch (err) {
      return jsonError(err, 400);
    }
  },
  'GET'
);

app.run();
