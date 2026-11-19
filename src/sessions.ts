import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { errorMessage, logger } from './logger.js';

export type CwdSource = 'default' | 'thread' | 'user' | 'unknown';

export interface SessionRecord {
  cwd: string;
  cwdSource: CwdSource;
  createdAt: string | null;
  sessionId: string | null;
  model: string | null;
  effort: string | null;
  updatedAt: string;
}

type SessionData = Record<string, SessionRecord>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeCwdSource(value: unknown): CwdSource {
  if (value === 'default' || value === 'thread' || value === 'user') return value;
  return 'unknown';
}

function normalizeRecord(value: unknown): SessionRecord | null {
  if (!isObject(value) || typeof value.cwd !== 'string') return null;
  const sessionId = typeof value.sessionId === 'string' && value.sessionId !== '' ? value.sessionId : null;
  const model = typeof value.model === 'string' && value.model !== '' ? value.model : null;
  const effort = typeof value.effort === 'string' && value.effort !== '' ? value.effort : null;
  const updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString();
  const createdAt =
    typeof value.createdAt === 'string' && value.createdAt !== '' ? value.createdAt : null;
  return {
    cwd: value.cwd,
    cwdSource: normalizeCwdSource(value.cwdSource),
    createdAt,
    sessionId,
    model,
    effort,
    updatedAt,
  };
}

export class SessionStore {
  private data: SessionData = {};
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(private readonly file: string) {}

  static async load(file: string): Promise<SessionStore> {
    const store = new SessionStore(file);
    try {
      const raw = await readFile(file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (isObject(parsed)) {
        for (const [channelId, value] of Object.entries(parsed)) {
          const record = normalizeRecord(value);
          if (record) store.data[channelId] = record;
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.warn(`${file} を読み込めませんでした。空の状態で開始します: ${errorMessage(error)}`);
      }
    }
    return store;
  }

  get(channelId: string, defaultCwd: string): SessionRecord {
    const existing = this.data[channelId];
    if (existing) return existing;
    const now = new Date().toISOString();
    const created: SessionRecord = {
      cwd: defaultCwd,
      cwdSource: 'default',
      createdAt: now,
      sessionId: null,
      model: null,
      effort: null,
      updatedAt: now,
    };
    this.data[channelId] = created;
    return created;
  }

  entries(): Array<[string, SessionRecord]> {
    return Object.entries(this.data);
  }

  async remove(channelId: string): Promise<void> {
    if (!(channelId in this.data)) return;
    delete this.data[channelId];
    await this.persist();
  }

  async setCwd(
    channelId: string,
    cwd: string,
    source: Exclude<CwdSource, 'unknown'> = 'user',
  ): Promise<void> {
    const existing = this.data[channelId];
    this.data[channelId] = {
      cwd,
      cwdSource: source,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      sessionId: null,
      model: existing?.model ?? null,
      effort: existing?.effort ?? null,
      updatedAt: new Date().toISOString(),
    };
    await this.persist();
  }

  cwdTaken(cwd: string, exceptKey: string): boolean {
    for (const [key, record] of Object.entries(this.data)) {
      if (key === exceptKey) continue;
      if (record.cwd === cwd) return true;
    }
    return false;
  }

  async setModel(channelId: string, model: string | null): Promise<void> {
    const record = this.data[channelId];
    if (!record || record.model === model) return;
    record.model = model;
    record.updatedAt = new Date().toISOString();
    await this.persist();
  }

  async setEffort(channelId: string, effort: string | null): Promise<void> {
    const record = this.data[channelId];
    if (!record || record.effort === effort) return;
    record.effort = effort;
    record.updatedAt = new Date().toISOString();
    await this.persist();
  }

  async setSessionId(channelId: string, sessionId: string): Promise<void> {
    const record = this.data[channelId];
    if (!record || record.sessionId === sessionId) return;
    record.sessionId = sessionId;
    record.updatedAt = new Date().toISOString();
    await this.persist();
  }

  async clearSession(channelId: string): Promise<void> {
    const record = this.data[channelId];
    if (!record || record.sessionId === null) return;
    record.sessionId = null;
    record.updatedAt = new Date().toISOString();
    await this.persist();
  }

  private persist(): Promise<void> {
    const snapshot = `${JSON.stringify(this.data, null, 2)}\n`;
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, this.file);
    });
    this.writeChain = this.writeChain.catch((error: unknown) => {
      logger.error(`セッションを保存できませんでした: ${errorMessage(error)}`);
    });
    return this.writeChain;
  }
}
