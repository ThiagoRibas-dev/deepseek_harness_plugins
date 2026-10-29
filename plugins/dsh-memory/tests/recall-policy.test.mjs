/**
 * Passive-recall policy tests.
 *
 * The policy decides whether an agent sees recalled memory on every turn, so the
 * cases that matter are the quiet ones: absent, malformed, and unknown-preset must
 * all resolve to **off**, because a missing or broken file is not consent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { readRecallPolicy, writeRecallPolicy, recallEnabledFor, createRecallPolicyReader, defaultRecallPolicyPath } from '../recall-policy.js';
import { recallEnabledForPreset } from '../plugin.js';

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mem-recall-'));
  return { dir, file: join(dir, 'memory-recall.json'), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a missing policy file is off, and is not reported as a problem', () => {
  const { file, done } = scratch();
  try {
    const policy = readRecallPolicy(file);
    assert.equal(policy.default, false);
    assert.deepEqual(policy.presets, {});
    assert.equal(policy.problem, null, 'a first run is not an error');
  } finally {
    done();
  }
});

test('a malformed policy file is off and says why', () => {
  const { file, done } = scratch();
  try {
    writeFileSync(file, '{ not json');
    const policy = readRecallPolicy(file);
    assert.equal(policy.default, false, 'a broken file must not enable anything');
    assert.match(policy.problem, /unreadable JSON/);
  } finally {
    done();
  }
});

test('non-boolean preset entries are dropped rather than coerced', () => {
  const { file, done } = scratch();
  try {
    writeFileSync(file, JSON.stringify({ default: false, presets: { good: true, bad: 'yes', also: 1, nil: null } }));
    const policy = readRecallPolicy(file);
    assert.deepEqual(policy.presets, { good: true });
  } finally {
    done();
  }
});

test('an unknown preset follows the default, and the default is off', () => {
  const policy = { default: false, presets: { standard: true } };
  assert.equal(recallEnabledFor(policy, 'standard'), true);
  assert.equal(recallEnabledFor(policy, 'dd35'), false);
  assert.equal(recallEnabledFor(policy, undefined), false);
  assert.equal(recallEnabledFor({ default: true, presets: {} }, 'anything'), true);
});

test('a preset entry beats the document default', () => {
  const policy = { default: true, presets: { quiet: false } };
  assert.equal(recallEnabledFor(policy, 'quiet'), false, 'an explicit off must win');
  assert.equal(recallEnabledFor(policy, 'other'), true);
});

test('the plugin resolver agrees with the policy resolver', () => {
  const policy = { default: false, presets: { standard: true } };
  for (const preset of ['standard', 'dd35', undefined]) {
    assert.equal(recallEnabledForPreset(policy, preset, false), recallEnabledFor(policy, preset));
  }
});

test('the config is a fallback, never an override', () => {
  // Nothing configured and nothing in the file: off.
  assert.equal(recallEnabledForPreset({ default: false, presets: {} }, 'standard', false), false);
  // A config that turns it on applies only where the policy is silent.
  assert.equal(recallEnabledForPreset({ default: false, presets: {} }, 'standard', true), true);
  // The policy wins when it speaks.
  assert.equal(recallEnabledForPreset({ default: false, presets: { standard: false } }, 'standard', true), false);
});

test('a null policy falls back to the config', () => {
  assert.equal(recallEnabledForPreset(null, 'standard', true), true);
  assert.equal(recallEnabledForPreset(undefined, 'standard', false), false);
});

test('the writer round-trips and normalises', () => {
  const { file, done } = scratch();
  try {
    writeRecallPolicy(file, { default: true, presets: { standard: true, junk: 'no' } });
    const policy = readRecallPolicy(file);
    assert.equal(policy.default, true);
    assert.deepEqual(policy.presets, { standard: true });
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).default, true, 'the file is plain JSON a person can edit');
  } finally {
    done();
  }
});

test('the writer replaces rather than merges, so a stale entry can be removed', () => {
  const { file, done } = scratch();
  try {
    writeRecallPolicy(file, { default: false, presets: { standard: true, old: true } });
    writeRecallPolicy(file, { default: false, presets: { standard: true } });
    assert.deepEqual(Object.keys(readRecallPolicy(file).presets), ['standard']);
  } finally {
    done();
  }
});

test('the cached reader notices an edit and nothing else', () => {
  const { file, done } = scratch();
  try {
    const read = createRecallPolicyReader(file);
    assert.equal(read().default, false, 'absent file');
    writeRecallPolicy(file, { default: true, presets: {} });
    // mtime granularity can be coarse; the writer changes the file between reads,
    // so the second read must see the new document.
    assert.equal(read().default, true, 'an edit must land without a restart');
  } finally {
    done();
  }
});

test('the default path sits under the profile home', () => {
  const previous = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = '/tmp/some-home';
    assert.equal(defaultRecallPolicyPath(), join('/tmp/some-home', 'memory-recall.json'));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
  }
});
