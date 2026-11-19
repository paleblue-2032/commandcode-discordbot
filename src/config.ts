import path from 'node:path';
import { resolveAllowedRoot, resolveDirectory } from './paths.js';

export interface Config {
  discordToken: string;
  allowedUserIds: Set<string>;
  allowedChannelIds: Set<string>;
  allowedRoots: string[];
  cmdBin: string;
  maxConcurrency: number;
  sessionsFile: string;
  progressIntervalMs: number;
  defaultCwd: string;
  defaultModel: string | null;
  defaultEffort: string | null;
  forumCwd: 'auto' | 'shared';
  uploadTtlMs: number;
  uploadSweepIntervalMs: number;
  storageTargetRatio: number;
  storageDegradedRatio: number;
  storageSweepIntervalMs: number;
  smartFile: string;
  workdirMeta: 'thread' | 'always' | 'off';
  cwdConflict: 'deny' | 'warn';
  requireTrigger: boolean;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} が設定されていません。.env.example を参照してください。`);
  }
  return value;
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} は 1 以上の整数で指定してください: ${value}`);
  }
  return parsed;
}

function parseNonNegativeNumber(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} は 0 以上の数値で指定してください: ${value}`);
  }
  return parsed;
}

function parseForumCwd(value: string | undefined): 'auto' | 'shared' {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return 'auto';
  if (normalized === 'auto' || normalized === 'shared') return normalized;
  throw new Error(`FORUM_CWD は auto か shared を指定してください: ${value}`);
}

function parseWorkdirMeta(value: string | undefined): 'thread' | 'always' | 'off' {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return 'thread';
  if (normalized === 'thread' || normalized === 'always' || normalized === 'off') {
    return normalized;
  }
  throw new Error(`WORKDIR_META は thread / always / off を指定してください: ${value}`);
}

function parseCwdConflict(value: string | undefined): 'deny' | 'warn' {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return 'deny';
  if (normalized === 'deny' || normalized === 'warn') return normalized;
  throw new Error(`CWD_CONFLICT は deny か warn を指定してください: ${value}`);
}

function parseTriggerMode(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'prefix') return true;
  if (normalized === 'all') return false;
  throw new Error(`TRIGGER_MODE は prefix か all を指定してください: ${value}`);
}

function parsePercent(value: string | undefined, fallback: number, name: string): number {
  const parsed = parseNonNegativeNumber(value, fallback, name);
  if (parsed > 100) {
    throw new Error(`${name} は 0〜100 の範囲で指定してください: ${value}`);
  }
  return parsed / 100;
}

export function isUserAllowed(
  allowedUserIds: ReadonlySet<string>,
  userId: string,
): boolean {
  return allowedUserIds.size === 0 || allowedUserIds.has(userId);
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const discordToken = required(env, 'DISCORD_TOKEN');

  const allowedUserIds = new Set(parseList(env.ALLOWED_USER_IDS));

  const allowedChannelIds = new Set(parseList(env.ALLOWED_CHANNEL_IDS));

  const rootInputs = parseList(env.ALLOWED_ROOTS);
  if (rootInputs.length === 0) {
    throw new Error('ALLOWED_ROOTS が空です。');
  }
  const allowedRoots = await Promise.all(rootInputs.map((root) => resolveAllowedRoot(root)));

  const defaultCwdInput = env.DEFAULT_CWD?.trim();
  const defaultCwd = defaultCwdInput
    ? await resolveDirectory(defaultCwdInput, allowedRoots, process.cwd())
    : allowedRoots[0]!;

  const progressIntervalMs = parsePositiveInt(
    env.PROGRESS_INTERVAL_MS,
    1750,
    'PROGRESS_INTERVAL_MS',
  );

  const forumCwd = parseForumCwd(env.FORUM_CWD);

  const uploadTtlHours = parseNonNegativeNumber(env.UPLOAD_TTL_HOURS, 0, 'UPLOAD_TTL_HOURS');

  const uploadSweepIntervalMinutes = parsePositiveInt(
    env.UPLOAD_SWEEP_INTERVAL_MINUTES,
    60,
    'UPLOAD_SWEEP_INTERVAL_MINUTES',
  );

  const storageTargetRatio = parsePercent(env.STORAGE_TARGET_PERCENT, 75, 'STORAGE_TARGET_PERCENT');
  const storageDegradedRatio = parsePercent(
    env.STORAGE_DEGRADED_PERCENT,
    60,
    'STORAGE_DEGRADED_PERCENT',
  );
  if (storageTargetRatio > 0 && storageDegradedRatio >= storageTargetRatio) {
    throw new Error(
      `STORAGE_DEGRADED_PERCENT は STORAGE_TARGET_PERCENT より小さくしてください: ${storageDegradedRatio * 100} >= ${storageTargetRatio * 100}`,
    );
  }

  const storageSweepIntervalMinutes = parsePositiveInt(
    env.STORAGE_SWEEP_INTERVAL_MINUTES,
    60,
    'STORAGE_SWEEP_INTERVAL_MINUTES',
  );

  return {
    discordToken,
    allowedUserIds,
    allowedChannelIds,
    allowedRoots,
    cmdBin: env.CMD_BIN?.trim() || 'cmd',
    maxConcurrency: parsePositiveInt(env.MAX_CONCURRENCY, 3, 'MAX_CONCURRENCY'),
    sessionsFile: path.resolve(env.SESSIONS_FILE?.trim() || 'sessions.json'),
    progressIntervalMs: Math.max(1000, progressIntervalMs),
    defaultCwd,
    defaultModel: env.CMD_MODEL?.trim() || null,
    defaultEffort: env.CMD_EFFORT?.trim() || null,
    forumCwd,
    uploadTtlMs: Math.round(uploadTtlHours * 60 * 60 * 1000),
    uploadSweepIntervalMs: Math.max(5, uploadSweepIntervalMinutes) * 60 * 1000,
    storageTargetRatio,
    storageDegradedRatio,
    storageSweepIntervalMs: Math.max(10, storageSweepIntervalMinutes) * 60 * 1000,
    smartFile: path.resolve(
      env.SMART_FILE?.trim() || '/var/lib/commandcode-discordbot/smart.json',
    ),
    workdirMeta: parseWorkdirMeta(env.WORKDIR_META),
    cwdConflict: parseCwdConflict(env.CWD_CONFLICT),
    requireTrigger: parseTriggerMode(env.TRIGGER_MODE),
  };
}
