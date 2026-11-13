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
  guildId: string | null;
  maxTurns: number | null;
  defaultModel: string | null;
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

function parseOptionalPositiveInt(value: string | undefined, name: string): number | null {
  if (!value?.trim()) return null;
  return parsePositiveInt(value, 1, name);
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const discordToken = required(env, 'DISCORD_TOKEN');

  const allowedUserIds = new Set(parseList(env.ALLOWED_USER_IDS));
  if (allowedUserIds.size === 0) {
    throw new Error('ALLOWED_USER_IDS が空です。誰でも操作できる状態は許可されません。');
  }

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

  return {
    discordToken,
    allowedUserIds,
    allowedChannelIds,
    allowedRoots,
    cmdBin: env.CMD_BIN?.trim() || 'cmd',
    maxConcurrency: parsePositiveInt(env.MAX_CONCURRENCY, 1, 'MAX_CONCURRENCY'),
    sessionsFile: path.resolve(env.SESSIONS_FILE?.trim() || 'sessions.json'),
    progressIntervalMs: Math.max(1000, progressIntervalMs),
    defaultCwd,
    guildId: env.DISCORD_GUILD_ID?.trim() || null,
    maxTurns: parseOptionalPositiveInt(env.CMD_MAX_TURNS, 'CMD_MAX_TURNS'),
    defaultModel: env.CMD_MODEL?.trim() || null,
  };
}
