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
app.api(
  '/styles.css',
  () =>
    new Response(readFileSync(join(here, 'styles.css'), 'utf8'), {
      contentType: 'text/css',
      headers: noCacheHeaders,
    }),
  'GET'
);

async function fetchQuotaStatus() {
  const addr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!addr || !csrf) return null;

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
    if (!res.ok) return null;
    const payload = await res.json();
    const configs = payload?.userStatus?.cascadeModelConfigData?.clientModelConfigs;
    if (!Array.isArray(configs)) return null;

    const geminiWithQuota = configs.find(
      (c) => typeof c?.label === 'string' && c.label.includes('Gemini') && typeof c?.quotaInfo?.remainingFraction === 'number'
    );
    const anyWithQuota = geminiWithQuota || configs.find((c) => typeof c?.quotaInfo?.remainingFraction === 'number');
    if (!anyWithQuota) return null;

    const remainingFraction = Math.min(1, Math.max(0, anyWithQuota.quotaInfo.remainingFraction));
    return {
      remainingFraction,
      usedFraction: 1 - remainingFraction,
      resetTime: anyWithQuota.quotaInfo.resetTime || null,
      planName: payload?.userStatus?.planStatus?.planInfo?.planName || null,
    };
  } catch {
    return null;
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
    const [usage, quota, metaMap] = await Promise.all([
      Promise.resolve(getConversationUsage(appDataDir, convId)),
      fetchQuotaStatus(),
      fetchCascadeMetadata(),
    ]);
    let estQuotaShare = null;

    if (quota && usage.found && usage.totals.totalTokens > 0) {
      const summary = getDashboardSummary(appDataDir, { days: 7, limit: 50 });
      if (summary.aggregate.totalTokens > 0) {
        estQuotaShare = (usage.totals.totalTokens / summary.aggregate.totalTokens) * quota.usedFraction;
      }
    }

    const meta = metaMap.get(convId);
    const title = meta?.summary || usage.title || 'Untitled conversation';
    return { ...usage, title, quota, estQuotaShare };
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
