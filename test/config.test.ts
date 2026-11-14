import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isUserAllowed, loadConfig } from '../src/config.js';

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cmdbot-config-')));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('empty ALLOWED_USER_IDS allows every user', async () => {
  await withRoot(async (root) => {
    const config = await loadConfig({
      DISCORD_TOKEN: 'token',
      ALLOWED_ROOTS: root,
    });

    assert.equal(config.allowedUserIds.size, 0);
    assert.equal(isUserAllowed(config.allowedUserIds, 'any-user'), true);
  });
});

test('ALLOWED_USER_IDS works as an allowlist when set', async () => {
  await withRoot(async (root) => {
    const config = await loadConfig({
      DISCORD_TOKEN: 'token',
      ALLOWED_ROOTS: root,
      ALLOWED_USER_IDS: ' 111, 222 ,, ',
    });

    assert.deepEqual([...config.allowedUserIds].sort(), ['111', '222']);
    assert.equal(isUserAllowed(config.allowedUserIds, '111'), true);
    assert.equal(isUserAllowed(config.allowedUserIds, '333'), false);
  });
});
