import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SessionStore } from '../src/sessions.js';

test('session ids and cwd survive a reload', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cmdbot-sessions-'));
  try {
    const file = path.join(directory, 'sessions.json');
    const store = await SessionStore.load(file);
    const record = store.get('channel-1', '/srv/work');
    assert.equal(record.cwd, '/srv/work');
    assert.equal(record.sessionId, null);

    await store.setCwd('channel-1', '/srv/work/repo');
    await store.setSessionId('channel-1', 'session-1');

    const reloaded = await SessionStore.load(file);
    const loaded = reloaded.get('channel-1', '/fallback');
    assert.equal(loaded.cwd, '/srv/work/repo');
    assert.equal(loaded.sessionId, 'session-1');

    await reloaded.clearSession('channel-1');
    const cleared = await SessionStore.load(file);
    assert.equal(cleared.get('channel-1', '/fallback').sessionId, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a corrupt sessions file starts empty', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cmdbot-sessions-'));
  try {
    const file = path.join(directory, 'sessions.json');
    await writeFile(file, 'not json');
    const store = await SessionStore.load(file);
    const record = store.get('channel-1', '/srv/work');
    assert.equal(record.cwd, '/srv/work');
    assert.equal(record.sessionId, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
