import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  getConversationUsage,
  getDashboardSummary,
  resolveAppDataDir,
} from './token-service.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_URI = 'ui://agy-tokens/app.html';
const appDataDir = resolveAppDataDir();
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

async function buildUsagePayload(conversationId) {
  const convId = typeof conversationId === 'string' ? conversationId.trim() : '';
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
}

async function buildDashboardPayload(days = 7) {
  const safeDays = Number(days) > 0 ? Math.min(30, Number(days)) : 7;
  const [summary, statusAndModels, metaMap] = await Promise.all([
    Promise.resolve(getDashboardSummary(appDataDir, { days: safeDays, limit: 40 })),
    fetchUserStatusAndModels(),
    fetchCascadeMetadata(),
  ]);
  const { quota } = statusAndModels;

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
}

function resolveHtmlPath() {
  const candidates = [
    join(__dirname, 'app.html'),
    join(__dirname, '..', 'dist', 'app.html'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(`Token Tracker UI bundle not found. Checked: ${candidates.join(', ')}`);
}

const server = new McpServer({
  name: 'agy-tokens',
  version: '2.0.0',
});

registerAppResource(
  server,
  'Token Tracker UI',
  APP_URI,
  {
    description: 'Interactive Gemini token tracker and 7-day conversation dashboard.',
    mimeType: RESOURCE_MIME_TYPE,
  },
  async () => {
    const html = readFileSync(resolveHtmlPath(), 'utf8');
    return {
      contents: [
        {
          uri: APP_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: html,
          _meta: {
            ui: {
              prefersBorder: false,
            },
          },
        },
      ],
    };
  }
);

registerAppTool(
  server,
  'open_token_tracker',
  {
    title: 'Token Tracker',
    description: 'Open the Token Tracker dashboard and conversation token breakdown.',
    inputSchema: {
      conversationId: z.string().optional(),
      days: z.number().int().min(1).max(30).optional(),
    },
    _meta: {
      ui: {
        resourceUri: APP_URI,
      },
      'com.google.antigravity/ui': {
        entrypoints: [
          { type: 'aux_pane', title: 'Token Tracker' },
          { type: 'global', title: 'Token Tracker' },
        ],
      },
    },
  },
  async (args = {}) => {
    const days = args.days ?? 7;
    const convId = typeof args.conversationId === 'string' ? args.conversationId.trim() : '';
    const dashboard = await buildDashboardPayload(days);
    const targetConvId = convId || dashboard.conversations[0]?.conversationId || '';
    const usage = targetConvId ? await buildUsagePayload(targetConvId) : null;

    const totalBurn = dashboard.aggregate.totalTokens.toLocaleString();
    const quotaText = dashboard.quota
      ? `${(dashboard.quota.remainingFraction * 100).toFixed(1)}% 5hr quota left`
      : 'quota unavailable';

    return {
      content: [
        {
          type: 'text',
          text: `Token Tracker (${days}d): ${totalBurn} tokens across ${dashboard.aggregate.conversationCount} conversations (${quotaText}).`,
        },
      ],
      structuredContent: {
        initialTab: convId ? 'conv' : 'dash',
        dashboard,
        usage,
      },
    };
  }
);

registerAppTool(
  server,
  'app_get_dashboard',
  {
    title: 'Get Token Dashboard',
    description: 'App-only tool to refresh the 7-day multi-conversation token dashboard.',
    inputSchema: {
      days: z.number().int().min(1).max(30).optional(),
    },
    _meta: {
      ui: {
        visibility: ['app'],
      },
    },
  },
  async (args = {}) => {
    const dashboard = await buildDashboardPayload(args.days ?? 7);
    return {
      content: [{ type: 'text', text: 'Dashboard refreshed.' }],
      structuredContent: { dashboard },
    };
  }
);

registerAppTool(
  server,
  'app_get_usage',
  {
    title: 'Get Conversation Token Usage',
    description: 'App-only tool to inspect token usage for a specific conversation.',
    inputSchema: {
      conversationId: z.string().min(8),
    },
    _meta: {
      ui: {
        visibility: ['app'],
      },
    },
  },
  async (args) => {
    const usage = await buildUsagePayload(args.conversationId);
    return {
      content: [{ type: 'text', text: 'Conversation usage loaded.' }],
      structuredContent: { usage },
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
