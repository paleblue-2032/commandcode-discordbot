import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALL_EFFORTS,
  effortsFor,
  isEffortSupported,
} from '../src/model-caps.js';

test('efforts are reported for models with a known list', () => {
  assert.deepEqual(effortsFor('deepseek/deepseek-v4.1-flash'), {
    known: true,
    efforts: ['off', 'low', 'high', 'max'],
  });
  assert.deepEqual(effortsFor('Qwen/Qwen3.8-Flash'), {
    known: true,
    efforts: ['low', 'medium', 'xhigh'],
  });
  assert.deepEqual(effortsFor('claude-sonnet-5-5'), {
    known: true,
    efforts: ALL_EFFORTS,
  });
});

test('models without effort support report an empty list', () => {
  assert.deepEqual(effortsFor('Qwen/Qwen3.7-Flash'), { known: true, efforts: [] });
  assert.deepEqual(effortsFor('claude-haiku-4-5-20251001'), { known: true, efforts: [] });
});

test('unknown and unset models are not validated', () => {
  assert.deepEqual(effortsFor(null), { known: false });
  assert.deepEqual(effortsFor(''), { known: false });
  assert.deepEqual(effortsFor('some/byok-model'), { known: false });
  assert.equal(isEffortSupported('some/byok-model', 'max'), true);
});

test('isEffortSupported respects each model list', () => {
  assert.equal(isEffortSupported('Qwen/Qwen3.8-Flash', 'xhigh'), true);
  assert.equal(isEffortSupported('Qwen/Qwen3.8-Flash', 'max'), false);
  assert.equal(isEffortSupported('deepseek/deepseek-v4.1-flash', 'off'), true);
  assert.equal(isEffortSupported('deepseek/deepseek-v4.1-flash', 'medium'), false);
  assert.equal(isEffortSupported('Qwen/Qwen3.7-Flash', 'low'), false);
});

test('the default model supports vision and a cheap cache read', () => {
  const support = effortsFor('deepseek/deepseek-v4.1-flash');
  assert.equal(support.known, true);
  if (support.known) {
    assert.ok(support.efforts.includes('high'));
  }
});
