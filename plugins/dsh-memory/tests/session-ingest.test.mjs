/**
 * Session-level ingestion tests: the `ingest_reference` tool and transcript capture.
 *
 * Both paths are driven through the plugin's own registration, so the suite
 * checks the wiring the harness uses rather than calling the engine directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { apply, MAX_REFERENCE_INPUT_CHARS, MAX_TRANSCRIPT_CHARS } from '../plugin.js';
import { MemoryService } from '../service.js';

/** Apply the plugin against a stub context and hand back what it registered. */
function mount(config = {}) {
  const tools = new Map();
  const hooks = new Map();
  const warnings = [];
  const ctx = {
    logger: { info: () => {}, warn: (m) => warnings.push(String(m)), error: (m) => warnings.push(String(m)) },
    provide: () => {},
    inject: () => {},
    get: () => undefined,
    effect: (fn) => { fn(); return () => {}; },
    systemPrompt: { section: () => {} },
    tools: { register: (tool) => { if (tool?.name) tools.set(tool.name, tool); } },
    on: (event, handler) => hooks.set(event, handler),
  };
  const result = apply(ctx, { inMemory: true, standalone: false, ...config });
  return { tools, hooks, warnings, result, service: result.service };
}

/** Wait until `check` passes or the budget runs out. */
async function until(check, { timeoutMs = 2000, stepMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return check();
}

const TEXT = (text) => [{ type: 'text', text }];

// ---------------------------------------------------------------- the tool

test('ingest_reference is registered with the other memory tools', async () => {
  const { tools, service } = mount();
  await until(() => tools.has('ingest_reference'));
  assert.ok(tools.has('search_memories'));
  assert.ok(tools.has('store_memory'));
  assert.ok(tools.has('search_reference'));
  assert.ok(tools.has('manage_core_memory'));
  assert.ok(tools.has('ingest_reference'));
  service.close();
});

test('ingest_reference stores a document the session supplies', async () => {
  const { tools, service } = mount();
  await until(() => tools.has('ingest_reference'));
  const tool = tools.get('ingest_reference');
  const result = await tool.execute(
    { content: '# Handout\n\nGrappling rules: a pinned creature cannot move.', title: 'Grappling', collection: 'rules' },
    { agent: { session: { id: 'session-1' } } },
  );
  assert.equal(result.success, true);
  assert.equal(result.status, 'ingested');
  assert.equal(result.collection, 'rules');
  assert.ok(result.chunkCount >= 1);

  const source = service.getCorpusSource('rules', result.sourcePath);
  assert.equal(source.origin, 'session');
  assert.equal(source.namespace, 'session:session-1');
  assert.equal(source.title, 'Grappling');

  const found = await service.searchReference('grappling', { collection: 'rules' });
  assert.ok(found.results.length >= 1, 'the ingested document must be searchable');
  service.close();
});

test('ingest_reference re-ingesting identical content is a no-op', async () => {
  const { tools, service } = mount();
  await until(() => tools.has('ingest_reference'));
  const tool = tools.get('ingest_reference');
  const args = { content: '# Note\n\nSame words every time.', sourcePath: 'note' };
  const first = await tool.execute(args, { agent: { session: { id: 's' } } });
  const second = await tool.execute(args, { agent: { session: { id: 's' } } });
  assert.equal(first.status, 'ingested');
  assert.equal(second.status, 'skipped');
  assert.equal(second.reason, 'content unchanged');
  service.close();
});

test('ingest_reference replaces a labelled document when its content changes', async () => {
  const { tools, service } = mount();
  await until(() => tools.has('ingest_reference'));
  const tool = tools.get('ingest_reference');
  const exec = { agent: { session: { id: 's' } } };
  await tool.execute({ content: '# v1\n\nFirst body.', sourcePath: 'doc', collection: 'c' }, exec);
  const updated = await tool.execute({ content: '# v2\n\nSecond body.', sourcePath: 'doc', collection: 'c' }, exec);
  assert.equal(updated.status, 'ingested');
  const chunks = service.listCorpusChunks({ collection: 'c' });
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].content, /Second body/);
  service.close();
});

test('ingest_reference refuses empty and oversized input without writing', async () => {
  const { tools, service } = mount();
  await until(() => tools.has('ingest_reference'));
  const tool = tools.get('ingest_reference');
  const empty = await tool.execute({ content: '   ' }, { agent: { session: { id: 's' } } });
  assert.equal(empty.success, false);
  assert.match(empty.error, /non-empty string/);
  const huge = await tool.execute({ content: 'x'.repeat(MAX_REFERENCE_INPUT_CHARS + 1) }, { agent: { session: { id: 's' } } });
  assert.equal(huge.success, false);
  assert.match(huge.error, /the limit is/);
  assert.equal(service.listCorpusChunks({}).length, 0);
  service.close();
});

test('ingest_reference defaults to the session collection and a hashed label', async () => {
  const { tools, service } = mount();
  await until(() => tools.has('ingest_reference'));
  const result = await tools.get('ingest_reference').execute(
    { content: '# Anonymous\n\nNo label given.' },
    { agent: { session: { id: 'abc' } } },
  );
  assert.equal(result.collection, 'session');
  assert.match(result.sourcePath, /^session:abc\/[0-9a-f]{12}$/);
  service.close();
});

test('ingest_reference survives a missing session by using a placeholder id', async () => {
  const { tools, service } = mount();
  await until(() => tools.has('ingest_reference'));
  const result = await tools.get('ingest_reference').execute({ content: '# No session\n\nBody.' }, {});
  assert.equal(result.success, true);
  assert.match(result.sourcePath, /^session:unknown\//);
  service.close();
});

// ---------------------------------------------------------------- transcripts

test('a completed turn is indexed as a transcript', async () => {
  const { hooks, service } = mount();
  const handler = hooks.get('agent/turn-stopping');
  assert.equal(typeof handler, 'function');
  const agent = {
    turn: 3,
    session: { id: 'sess-9' },
    deriveMessages: () => [
      { role: 'user', source: { kind: 'user' }, content: TEXT('We head to the eastern gate to meet Vance.') },
      { role: 'assistant', source: { kind: 'assistant' }, content: TEXT('Vance is waiting by the gate, holding two horses.') },
    ],
  };
  await handler({ agent, turn: 3, signal: { aborted: false } });
  const ok = await until(() => service.listCorpusSources({ collection: 'transcripts' }).length > 0);
  assert.ok(ok, 'expected a transcript source');
  const source = service.listCorpusSources({ collection: 'transcripts' })[0];
  assert.equal(source.source_path, 'session:sess-9/turn-3');
  assert.equal(source.origin, 'transcript');
  assert.equal(source.namespace, 'session:sess-9');
  const chunks = service.listCorpusChunks({ collection: 'transcripts' });
  assert.match(chunks[0].content, /eastern gate/);
  assert.match(chunks[0].content, /holding two horses/);
  service.close();
});

test('injected context is not captured as the player turn', async () => {
  const { hooks, service } = mount();
  const handler = hooks.get('agent/turn-stopping');
  const agent = {
    turn: 1,
    session: { id: 'sess-i' },
    deriveMessages: () => [
      { role: 'user', source: { kind: 'user' }, content: TEXT('A real question.') },
      { role: 'user', source: { kind: 'system', plugin: 'memory', form: 'passive-recall' }, content: TEXT('Injected recall block that must not be indexed as the user.') },
      { role: 'assistant', source: { kind: 'assistant' }, content: TEXT('A real answer to the real question.') },
    ],
  };
  await handler({ agent, turn: 1, signal: { aborted: false } });
  await until(() => service.listCorpusChunks({ collection: 'transcripts' }).length > 0);
  const body = service.listCorpusChunks({ collection: 'transcripts' })[0].content;
  assert.match(body, /A real question/);
  assert.ok(!body.includes('must not be indexed'), 'injected recall must not appear in the transcript');
  service.close();
});

test('a repeated turn is skipped rather than duplicated', async () => {
  const { hooks, service } = mount();
  const handler = hooks.get('agent/turn-stopping');
  const agent = {
    turn: 2,
    session: { id: 'sess-r' },
    deriveMessages: () => [
      { role: 'user', source: { kind: 'user' }, content: TEXT('Question.') },
      { role: 'assistant', source: { kind: 'assistant' }, content: TEXT('An answer worth indexing twice over.') },
    ],
  };
  await handler({ agent, turn: 2, signal: { aborted: false } });
  await until(() => service.listCorpusSources({ collection: 'transcripts' }).length === 1);
  await handler({ agent, turn: 2, signal: { aborted: false } });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(service.listCorpusSources({ collection: 'transcripts' }).length, 1);
  assert.equal(service.listCorpusChunks({ collection: 'transcripts' }).length, 1);
  service.close();
});

test('transcript capture can be switched off', async () => {
  const { hooks, service } = mount({ captureTranscripts: false });
  const handler = hooks.get('agent/turn-stopping');
  const agent = {
    turn: 1,
    session: { id: 'sess-off' },
    deriveMessages: () => [
      { role: 'user', source: { kind: 'user' }, content: TEXT('Question.') },
      { role: 'assistant', source: { kind: 'assistant' }, content: TEXT('An answer that would be indexed if capture were on.') },
    ],
  };
  await handler({ agent, turn: 1, signal: { aborted: false } });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(service.listCorpusSources({ collection: 'transcripts' }).length, 0);
  service.close();
});

test('an aborted turn is not indexed', async () => {
  const { hooks, service } = mount();
  const handler = hooks.get('agent/turn-stopping');
  const agent = {
    turn: 4,
    session: { id: 'sess-abort' },
    deriveMessages: () => [
      { role: 'user', source: { kind: 'user' }, content: TEXT('Question.') },
      { role: 'assistant', source: { kind: 'assistant' }, content: TEXT('Answer on an aborted turn, long enough to index.') },
    ],
  };
  await handler({ agent, turn: 4, signal: { aborted: true } });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(service.listCorpusSources({ collection: 'transcripts' }).length, 0);
  service.close();
});

test('a very long turn is truncated to the transcript ceiling', async () => {
  const { hooks, service } = mount();
  const handler = hooks.get('agent/turn-stopping');
  const long = 'Sentence about the campaign. '.repeat(2000);
  const agent = {
    turn: 5,
    session: { id: 'sess-long' },
    deriveMessages: () => [
      { role: 'user', source: { kind: 'user' }, content: TEXT('Tell me everything.') },
      { role: 'assistant', source: { kind: 'assistant' }, content: TEXT(long) },
    ],
  };
  await handler({ agent, turn: 5, signal: { aborted: false } });
  await until(() => service.listCorpusChunks({ collection: 'transcripts' }).length > 0);
  const chunks = service.listCorpusChunks({ collection: 'transcripts' });
  // The ceiling bounds the document, not the sum of its chunks: consecutive
  // chunks repeat an overlap tail by design, so their lengths add up to more
  // than the source ever held.
  const source = service.getCorpusSource('transcripts', 'session:sess-long/turn-5');
  assert.ok(source.bytes <= MAX_TRANSCRIPT_CHARS + 100, `expected the document under the ceiling, saw ${source.bytes}`);
  assert.ok(source.bytes < long.length, 'the turn really was truncated');
  assert.ok(chunks.every((c) => c.content.length <= 1800), 'every chunk stays within the chunk budget');
  assert.ok(chunks.some((c) => c.content.includes('[truncated at')), 'truncation must be stated');
  service.close();
});

test('a short assistant reply is not worth a transcript', async () => {
  const { hooks, service } = mount();
  const handler = hooks.get('agent/turn-stopping');
  const agent = {
    turn: 6,
    session: { id: 'sess-short' },
    deriveMessages: () => [
      { role: 'user', source: { kind: 'user' }, content: TEXT('Hi') },
      { role: 'assistant', source: { kind: 'assistant' }, content: TEXT('Ok') },
    ],
  };
  await handler({ agent, turn: 6, signal: { aborted: false } });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(service.listCorpusSources({ collection: 'transcripts' }).length, 0);
  service.close();
});

test('transcripts remain searchable through the reference engine', async () => {
  const { hooks, service } = mount();
  const handler = hooks.get('agent/turn-stopping');
  const agent = {
    turn: 7,
    session: { id: 'sess-search' },
    deriveMessages: () => [
      { role: 'user', source: { kind: 'user' }, content: TEXT('Remind me about the horses.') },
      { role: 'assistant', source: { kind: 'assistant' }, content: TEXT('Vance agreed to hold the horses until nightfall and is owed twelve silver.') },
    ],
  };
  await handler({ agent, turn: 7, signal: { aborted: false } });
  await until(() => service.listCorpusChunks({ collection: 'transcripts' }).length > 0);
  const found = await service.searchReference('horses silver', { collection: 'transcripts' });
  assert.ok(found.results.length >= 1);
  assert.match(found.results[0].source_path, /turn-7$/);
  service.close();
});

test('a transcript is filed under its own session namespace', async () => {
  const { hooks, service } = mount();
  const handler = hooks.get('agent/turn-stopping');
  for (const id of ['sess-a', 'sess-b']) {
    await handler({
      agent: {
        turn: 1,
        session: { id },
        deriveMessages: () => [
          { role: 'user', source: { kind: 'user' }, content: TEXT(`Question from ${id}.`) },
          { role: 'assistant', source: { kind: 'assistant' }, content: TEXT(`Answer for ${id}, long enough to index.`) },
        ],
      },
      turn: 1,
      signal: { aborted: false },
    });
  }
  await until(() => service.listCorpusSources({ collection: 'transcripts' }).length === 2);
  const namespaces = service.listCorpusSources({ collection: 'transcripts' }).map((s) => s.namespace).sort();
  assert.deepEqual(namespaces, ['session:sess-a', 'session:sess-b']);
  service.close();
});

test('a subagent turn is neither harvested nor transcribed', async () => {
  const { hooks, service } = mount();
  const handler = hooks.get('agent/turn-stopping');
  const agent = {
    turn: 8,
    session: { id: 'child-1', header: { origin: 'subagent' } },
    deriveMessages: () => [
      { role: 'user', source: { kind: 'user' }, content: TEXT('Subtask instruction.') },
      { role: 'assistant', source: { kind: 'assistant' }, content: TEXT('Subagent output long enough that it would otherwise be indexed.') },
    ],
  };
  await handler({ agent, turn: 8, signal: { aborted: false } });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(service.listCorpusSources({ collection: 'transcripts' }).length, 0, 'no transcript');
  assert.equal(service.listMemories({ namespace: 'global' }).length, 0, 'no episodic harvest');
  service.close();
});

test('a main session turn is still captured when the header names another origin', async () => {
  const { hooks, service } = mount();
  const handler = hooks.get('agent/turn-stopping');
  const agent = {
    turn: 9,
    session: { id: 'root-1', header: { origin: 'user' } },
    deriveMessages: () => [
      { role: 'user', source: { kind: 'user' }, content: TEXT('Main session question.') },
      { role: 'assistant', source: { kind: 'assistant' }, content: TEXT('Main session answer, long enough to index.') },
    ],
  };
  await handler({ agent, turn: 9, signal: { aborted: false } });
  await until(() => service.listCorpusSources({ collection: 'transcripts' }).length === 1);
  assert.equal(service.listCorpusSources({ collection: 'transcripts' })[0].source_path, 'session:root-1/turn-9');
  service.close();
});

test('a transcript header carries the turn, session, clock, tools, and player message', async () => {
  const { hooks, service } = mount();
  const handler = hooks.get('agent/turn-stopping');
  const agent = {
    turn: 12,
    session: { id: 'sess-meta' },
    deriveMessages: () => [
      { role: 'user', id: 'm-1', source: { kind: 'user', rpcId: 'rpc-9' }, content: TEXT('# The eastern gate\n\nWe head to the gate.') },
      {
        role: 'assistant',
        source: { kind: 'assistant' },
        content: [
          { type: 'tool-call', name: 'read_file' },
          { type: 'tool-call', name: 'edit' },
          { type: 'tool-call', name: 'read_file' },
          { type: 'text', text: 'Vance is waiting by the gate, holding two horses.' },
        ],
      },
    ],
  };
  await handler({ agent, turn: 12, signal: { aborted: false } });
  await until(() => service.listCorpusChunks({ collection: 'transcripts' }).length > 0);
  const body = service.listCorpusChunks({ collection: 'transcripts' })[0].content;
  assert.match(body, /^# Turn 0012 — The eastern gate$/m, 'turn number is padded and titled from the player message');
  assert.match(body, /^- Session: sess-meta$/m);
  assert.match(body, /^- Captured: \d{4}-\d{2}-\d{2}T[\d:.]+Z$/m, 'the header carries a clock reading');
  assert.match(body, /^- Tools: read_file, edit$/m, 'tools are listed once each, in call order');
  assert.match(body, /^- Player-Message: rpc-9$/m, 'the player message is named for provenance');
  assert.match(body, /^## User$/m);
  assert.match(body, /^## Assistant$/m);
  service.close();
});

test('a transcript header omits metadata it does not have', async () => {
  const { hooks, service } = mount();
  const handler = hooks.get('agent/turn-stopping');
  const agent = {
    turn: 13,
    session: { id: 'sess-bare' },
    deriveMessages: () => [
      { role: 'user', source: { kind: 'user' }, content: TEXT('A question with no heading and no rpc id.') },
      { role: 'assistant', source: { kind: 'assistant' }, content: TEXT('An answer with no tool calls at all.') },
    ],
  };
  await handler({ agent, turn: 13, signal: { aborted: false } });
  await until(() => service.listCorpusChunks({ collection: 'transcripts' }).length > 0);
  const body = service.listCorpusChunks({ collection: 'transcripts' })[0].content;
  assert.match(body, /^# Turn 0013 — A question with no heading and no rpc id\.$/m, 'title falls back to the first line');
  assert.ok(!body.includes('- Tools:'), 'no tools line when nothing was called');
  assert.ok(!body.includes('- Player-Message:'), 'no provenance line without an id');
  assert.ok(!body.includes('undefined'), 'a missing field must not render as undefined');
  service.close();
});

test('recall runs on the first step of a turn only', async () => {
  // Recall is off unless a policy or the config turns it on, so this asks for it.
  const { hooks, service } = mount({ recallEnabled: true });
  const handler = hooks.get('agent/pre-step');
  await service.storeMemory({ content: 'Vance holds the horses until nightfall.', namespace: 'global', status: 'canon' });
  const agent = { turn: 1, session: { id: 's-recall' } };
  const decision = { kind: 'continue', messages: [{ source: { kind: 'user' }, content: TEXT('What about Vance?') }] };
  const next = async () => decision;

  const first = await handler({ agent, turn: 1, step: 1, signal: { aborted: false } }, next);
  assert.ok(first.messages.some((m) => m.source?.form === 'passive-recall'), 'the first step carries recall');

  const later = await handler({ agent, turn: 1, step: 2, signal: { aborted: false } }, next);
  assert.equal(later, decision, 'a later step is left untouched — no second search per model call');
  service.close();
});

test('a turn arriving while its own session is still capturing is skipped', async () => {
  const { hooks, service } = mount();
  const handler = hooks.get('agent/turn-stopping');
  const messages = [
    { role: 'user', source: { kind: 'user' }, content: TEXT('Question.') },
    { role: 'assistant', source: { kind: 'assistant' }, content: TEXT('An answer long enough to be worth indexing.') },
  ];
  const agent = { turn: 1, session: { id: 's-busy' }, deriveMessages: () => messages };
  // Two turns back to back: the guard admits the first and drops the second,
  // because both would index the same session at the same moment.
  await handler({ agent, turn: 1, signal: { aborted: false } });
  await handler({ agent, turn: 2, signal: { aborted: false } });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(service.listCorpusSources({ collection: 'transcripts' }).length, 1, 'one capture at a time per session');
  service.close();
});

test('recall does nothing at all until it is switched on', async () => {
  const { hooks, service } = mount();
  await service.storeMemory({ content: 'Vance holds the horses until nightfall.', namespace: 'global', status: 'canon' });
  const agent = { turn: 1, session: { id: 's-off', header: { agentPreset: 'standard' } } };
  const decision = { kind: 'continue', messages: [{ source: { kind: 'user' }, content: TEXT('What about Vance?') }] };
  const result = await hooks.get('agent/pre-step')({ agent, turn: 1, step: 1, signal: { aborted: false } }, async () => decision);
  assert.equal(result, decision, 'a disabled layer must hand the decision back untouched');
  assert.equal(result.messages.length, 1, 'and must not append anything');
  service.close();
});

test('a harvested turn is canon and records the exchange, not just the reply', async () => {
  const { hooks, service } = mount();
  const handler = hooks.get('agent/turn-stopping');
  const agent = {
    turn: 4,
    session: { id: 's-canon', header: { origin: 'user' } },
    deriveMessages: () => [
      { role: 'user', source: { kind: 'user' }, content: TEXT('We head to the eastern gate.') },
      { role: 'assistant', source: { kind: 'assistant' }, content: TEXT('Vance will hold the horses until nightfall.') },
    ],
  };
  await handler({ agent, turn: 4, signal: { aborted: false } });
  await until(() => service.listMemories({ namespace: 'global' }).length > 0);
  const memory = service.listMemories({ namespace: 'global' })[0];
  assert.equal(memory.status, 'canon', 'what happened in the conversation is a memory, not a proposal');
  assert.match(memory.content, /Player: We head to the eastern gate/);
  assert.match(memory.content, /Assistant: Vance will hold the horses/);
  assert.equal(memory.turn_ref, '4');
  assert.match(memory.tags, /turn:4/);
  service.close();
});

test('the recall block is chronological and carries each item\'s turn and date', async () => {
  const { hooks, service } = mount({ recallEnabled: true });
  const stop = hooks.get('agent/turn-stopping');
  for (const [turn, user, reply] of [
    [1, 'We head to the gate.', 'The gate is open.'],
    [2, 'Anything change?', 'The gate is barred until dawn.'],
  ]) {
    await stop({
      agent: {
        turn, session: { id: 's-order', header: { origin: 'user' } },
        deriveMessages: () => [
          { role: 'user', source: { kind: 'user' }, content: TEXT(user) },
          { role: 'assistant', source: { kind: 'assistant' }, content: TEXT(reply) },
        ],
      },
      turn, signal: { aborted: false },
    });
    await until(() => service.listMemories({ namespace: 'global' }).length === turn);
  }
  const decision = await hooks.get('agent/pre-step')(
    { agent: { turn: 3, session: { id: 's-order' } }, turn: 3, step: 1, signal: { aborted: false } },
    async () => ({ kind: 'continue', messages: [{ source: { kind: 'user' }, content: TEXT('Tell me about the gate.') }] }),
  );
  const block = decision.messages.find((m) => m.source?.form === 'passive-recall').content[0].text;
  assert.match(block, /oldest first/);
  const first = block.indexOf('turn 1');
  const second = block.indexOf('turn 2');
  assert.ok(first !== -1 && second !== -1, 'both items carry their turn');
  assert.ok(first < second, 'the older turn is listed first');
  assert.match(block, /\d{4}-\d{2}-\d{2}/, 'each item carries a date');
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}/.test(block), false, 'no uuid leaks into the block');
  service.close();
});
