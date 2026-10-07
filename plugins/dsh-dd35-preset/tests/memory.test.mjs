/**
 * Turn-capture tests: which messages count as the player's own words.
 *
 * `memory.js` imports `@deepseek-ai/dsh-tools`, which does not resolve from the
 * bundle folder, so this file builds a throwaway copy of the modules next to a
 * one-export stub of that package and imports the copies — the same rig shape
 * `roll.test.mjs` uses.
 *
 * The regression this guards: a plugin that injects model-facing content as a
 * `user`-role message used to be recorded as the player's turn, because capture
 * keyed on `role === 'user' && source.kind === 'user'`. `dsh-context-pressure`
 * did exactly that, and its notice landed between the player's message and the
 * reply, so `captureFrom` walked back and found the notice first.
 *
 * Run from the bundle folder with `node --test`.
 */
import { strict as assert } from 'node:assert'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'

const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODULES = ['state-store.js', 'memory-store.js', 'memory.js']

let rig
let memory
const workspaces = []

before(() => {
  rig = mkdtempSync(join(tmpdir(), 'dd35-memory-rig-'))
  writeFileSync(join(rig, 'package.json'), JSON.stringify({ type: 'module' }))
  for (const file of MODULES) cpSync(join(BUNDLE, file), join(rig, file))
  const stub = join(rig, 'node_modules', '@deepseek-ai', 'dsh-tools')
  mkdirSync(stub, { recursive: true })
  writeFileSync(join(stub, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-tools', version: '0.0.0', type: 'module', main: 'index.js', exports: './index.js',
  }))
  // `defineTool` is identity here; the recall tools need nothing else from it.
  writeFileSync(join(stub, 'index.js'), 'export const defineTool = (tool) => tool\n')
})

after(() => {
  rmSync(rig, { recursive: true, force: true })
  for (const root of workspaces) rmSync(root, { recursive: true, force: true })
})

/** Import the rig copy once, after the rig exists. */
async function load() {
  memory ??= await import(pathToFileURL(join(rig, 'memory.js')).href)
  return memory
}

/** One campaign workspace with an active campaign, so capture resolves. */
function campaignWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'dd35-memory-ws-'))
  workspaces.push(root)
  mkdirSync(join(root, 'campaign', 'c1'), { recursive: true })
  writeFileSync(join(root, 'campaign', 'campaign_registry.md'),
    '# Campaign Registry\n\n## Active Campaign\n- **Identifier:** `c1`\n')
  return root
}

/** Give the campaign a scene, so the commit has state to fold into the header. */
function sceneState(root) {
  writeFileSync(join(root, 'campaign', 'c1', 'state.json'), JSON.stringify({
    campaign: 'c1',
    clock: { date: 'Day 4', time: 'Dusk' },
    scene: {
      title: "The Boar's Rest",
      location: "Hurstwood - The Boar's Rest",
      entities: ['thiago', 'maude'],
      // A newline in the middle, which the header must collapse: it is parsed line by line.
      micro_state: 'Maude is pouring cider.\nThiago is at the counter.',
      pending_action: 'Maude asks what he wants.',
    },
  }))
}

/** Where capture would write the first turn, whether or not it did. */
const transcriptPath = root => join(root, 'campaign', 'c1', 'events', 'transcripts', '0001_turn.md')

/** Drive one completed turn through the capture hooks. */
async function driveTurn(root, messages) {
  const mod = await load()
  const handlers = new Map()
  const ctx = {
    on: (event, handler) => { handlers.set(event, handler) },
    effect: (body) => { const dispose = body(); return typeof dispose === 'function' ? dispose : () => {} },
    logger: { debug() {}, warn() {} },
    tools: { register() {} },
  }
  mod.apply(ctx, {})
  const session = { id: 'session-test', header: { cwd: root }, deriveMessages: () => messages }
  handlers.get('agent/turn-stopping')({ agent: { session }, turn: 1 })
  handlers.get('session/event')(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
}

/** Drive one completed turn and return the transcript it should have written. */
async function captureTurn(root, messages) {
  await driveTurn(root, messages)
  return readFileSync(transcriptPath(root), 'utf8')
}

const text = (value) => [{ type: 'text', text: value }]

// ---- the predicate -------------------------------------------------------

test('a Web prompt carrying an rpcId is player input', async () => {
  const { isPlayerMessage } = await load()
  assert.equal(isPlayerMessage({
    role: 'user',
    source: { kind: 'user', rpcId: 'rpc-1', clientTimeZone: 'America/Sao_Paulo' },
  }), true)
})

test('a user-role notice with no rpcId is not player input', async () => {
  const { isPlayerMessage } = await load()
  // The shape dsh-context-pressure steered before it declared its own kind.
  assert.equal(isPlayerMessage({ role: 'user', source: { kind: 'user' } }), false)
})

test('a producer with its own kind is never player input, rpcId or not', async () => {
  const { isPlayerMessage } = await load()
  for (const kind of ['context-pressure', 'runtime-context', 'skill-catalog', 'compaction', 'goal', 'model-selection']) {
    assert.equal(isPlayerMessage({ role: 'user', source: { kind, rpcId: 'rpc-1' } }), false, kind)
  }
})

test('non-user roles and malformed messages are not player input', async () => {
  const { isPlayerMessage } = await load()
  assert.equal(isPlayerMessage({ role: 'assistant', source: { kind: 'user', rpcId: 'rpc-1' } }), false)
  assert.equal(isPlayerMessage({ role: 'tool', source: { kind: 'tool' } }), false)
  assert.equal(isPlayerMessage({ role: 'user' }), false)
  assert.equal(isPlayerMessage({ role: 'user', source: { kind: 'user', rpcId: '' } }), false)
  assert.equal(isPlayerMessage(undefined), false)
})

test('an rpcId-less ACP prompt is not player input — the documented trade-off', async () => {
  const { isPlayerMessage } = await load()
  // acp/session.ts delivers a real prompt as `{ kind: 'user' }` with no rpcId.
  // Rejecting it is deliberate; see the JSDoc on isPlayerMessage.
  assert.equal(isPlayerMessage({ role: 'user', source: { kind: 'user' } }), false)
})

// ---- the capture path ----------------------------------------------------

test('a steered notice between prompt and reply is not recorded as the player', async () => {
  const root = campaignWorkspace()
  const transcript = await captureTurn(root, [
    { id: 'm1', role: 'user', source: { kind: 'user', rpcId: 'rpc-1' }, content: text('I draw my sword.') },
    { id: 'n1', role: 'user', source: { kind: 'context-pressure' }, content: text('Context is at 82% of this model\'s window.') },
    { id: 'a1', role: 'assistant', content: text('The blade rings free of the scabbard.') },
  ])
  assert.match(transcript, /## Player\nI draw my sword\./)
  assert.doesNotMatch(transcript, /Context is at 82%/)
})

test('a mis-tagged user-role notice is rejected by the rpcId guard', async () => {
  const root = campaignWorkspace()
  const transcript = await captureTurn(root, [
    { id: 'm1', role: 'user', source: { kind: 'user', rpcId: 'rpc-1' }, content: text('I draw my sword.') },
    // No rpcId: the pre-fix notice shape, which the kind test alone would accept.
    { id: 'n1', role: 'user', source: { kind: 'user' }, content: text('Context is at 82% of this model\'s window.') },
    { id: 'a1', role: 'assistant', content: text('The blade rings free of the scabbard.') },
  ])
  assert.match(transcript, /## Player\nI draw my sword\./)
  assert.doesNotMatch(transcript, /Context is at 82%/)
})

test('an ordinary turn still records the player verbatim', async () => {
  const root = campaignWorkspace()
  const transcript = await captureTurn(root, [
    { id: 'm1', role: 'user', source: { kind: 'user', rpcId: 'rpc-1' }, content: text('Kenna, wait.') },
    { id: 'a1', role: 'assistant', content: text('She stops, half-turned.') },
  ])
  assert.match(transcript, /## Player\nKenna, wait\./)
  assert.match(transcript, /## DM\nShe stops, half-turned\./)
})

test('a reply is not replaced by the work a pressure notice asks for', async () => {
  // Turn 137 of seventh_moon: the model answered the player, then the
  // pre-compaction notice arrived, and the model closed the turn with an OOC
  // report about the file it had written. That report became the recorded reply
  // and the answer was discarded.
  const root = campaignWorkspace()
  const transcript = await captureTurn(root, [
    { id: 'm1', role: 'user', source: { kind: 'user', rpcId: 'rpc-1' }, content: text('I go straight for it.') },
    { id: 'a1', role: 'assistant', content: text('She gasps and pulls you closer.') },
    {
      id: 'n1',
      role: 'user',
      source: { kind: 'context-pressure' },
      content: text('Context is at 109% of this model\'s window. Write anything you would need to resume to a file.'),
    },
    { id: 'a2', role: 'assistant', content: [{ type: 'tool-call', id: 't1', name: 'write', arguments: '{}' }] },
    { id: 'a3', role: 'assistant', content: text('*(OOC: State successfully saved to compaction_save.md!)*') },
  ])
  assert.match(transcript, /## DM\nShe gasps and pulls you closer\./)
  assert.doesNotMatch(transcript, /compaction_save/)
  assert.doesNotMatch(transcript, /State successfully saved/)
  assert.match(transcript, /## Player\nI go straight for it\./)
})

test('a notice that lands before the reply does not discard the turn', async () => {
  // The other ordering in the corpus: the notice is steered during tool work,
  // before the model has said anything, so there is no earlier text to protect
  // and the model's next message is the reply.
  const root = campaignWorkspace()
  const transcript = await captureTurn(root, [
    { id: 'm1', role: 'user', source: { kind: 'user', rpcId: 'rpc-1' }, content: text('Sync the campaign files.') },
    { id: 'a0', role: 'assistant', content: [{ type: 'tool-call', id: 't0', name: 'read', arguments: '{}' }] },
    {
      id: 'n1',
      role: 'user',
      source: { kind: 'context-pressure' },
      content: text('Context is at 91% of this model\'s window. Write anything you would need to resume to a file.'),
    },
    { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', id: 't1', name: 'write', arguments: '{}' }] },
    { id: 'a2', role: 'assistant', content: text('Yes, the files are now fully synced and ready.') },
  ])
  assert.match(transcript, /## DM\nYes, the files are now fully synced and ready\./)
})

test('a mid-turn notice that reports rather than asks keeps the last text as the reply', async () => {
  // runtime-context and skill-catalog updates are normal preamble or refresh.
  // The model carries on, so its final message is still the answer.
  const root = campaignWorkspace()
  const transcript = await captureTurn(root, [
    { id: 'm1', role: 'user', source: { kind: 'user', rpcId: 'rpc-1' }, content: text('What do I see?') },
    { id: 'a1', role: 'assistant', content: text('Let me look.') },
    { id: 'n1', role: 'user', source: { kind: 'skill-catalog' }, content: text('The available skill catalog changed.') },
    { id: 'a2', role: 'assistant', content: text('A cold room, one barred window.') },
  ])
  assert.match(transcript, /## DM\nA cold room, one barred window\./)
})

test('the transcript header carries the scene the turn closed in', async () => {
  // The transcript is the only turn record, so the state snapshot that used to go
  // into a separate campaign log has to live here — and survive the round trip,
  // because state.json keeps only the current values.
  const root = campaignWorkspace()
  sceneState(root)
  const transcript = await captureTurn(root, [
    { id: 'm1', role: 'user', source: { kind: 'user', rpcId: 'rpc-1' }, content: text('I sit.') },
    { id: 'a1', role: 'assistant', content: text('The stool creaks.') },
  ])
  assert.match(transcript, /^- Date: Day 4 Dusk$/m)
  assert.match(transcript, /^- Location: Hurstwood - The Boar's Rest$/m)
  assert.match(transcript, /^- Entities: thiago, maude$/m)
  // Collapsed to one line, or the fields below it would be swallowed by the parser.
  assert.match(transcript, /^- Micro-State: Maude is pouring cider\. Thiago is at the counter\.$/m)
  assert.match(transcript, /^- Pending Action: Maude asks what he wants\.$/m)

  const store = await import(pathToFileURL(join(rig, 'memory-store.js')).href)
  const { configure } = await import(pathToFileURL(join(rig, 'state-store.js')).href)
  configure({ workspace: root })
  const { turns, messages } = store.loadTranscripts('c1')
  assert.deepEqual(turns[0].entities, ['thiago', 'maude'])
  assert.equal(turns[0].microState, 'Maude is pouring cider. Thiago is at the counter.')
  assert.equal(turns[0].pendingAction, 'Maude asks what he wants.')
  // Recall sees it too, so a fetched memory reports the scene it belonged to.
  assert.equal(messages[0].microState, 'Maude is pouring cider. Thiago is at the counter.')
  assert.equal(messages[0].location, "Hurstwood - The Boar's Rest")
})

test('a listing offers the same ids a search returns', async () => {
  // `list_memories` over a range hands out ids for `fetch_memories`; `grep_memories`
  // returns ids of its own. Both must come from one definition, or a fresh session
  // synthesises the shape by hand and gets the padding wrong.
  const root = campaignWorkspace()
  sceneState(root)
  await captureTurn(root, [
    { id: 'm1', role: 'user', source: { kind: 'user', rpcId: 'rpc-1' }, content: text('I sit.') },
    { id: 'a1', role: 'assistant', content: text('The stool creaks.') },
  ])
  const store = await import(pathToFileURL(join(rig, 'memory-store.js')).href)
  const { configure } = await import(pathToFileURL(join(rig, 'state-store.js')).href)
  configure({ workspace: root })
  const { turns, messages } = store.loadTranscripts('c1')
  assert.deepEqual(store.messagesOf(turns[0]).map((message) => message.id), ['0001:player', '0001:dm'])
  assert.deepEqual(store.messagesOf(turns[0]).map((message) => message.id),
    messages.map((message) => message.id))
})

// ---- connector notices ---------------------------------------------------

test('the notice prefix is recognised at the start of the turn or of a later block', async () => {
  const { isConnectorNotice } = await load()
  assert.equal(isConnectorNotice('[Meridian Antigravity] The batch of 1 tool result for this turn was'
    + ' consumed by a generation the backend blocked and never completed.'), true)
  assert.equal(isConnectorNotice('\n\n[Meridian Antigravity] leading whitespace'), true)
  // A reply the backend cut short keeps the model's text and appends the notice as
  // its own block, which `textOf` joins with a newline. Neither half may be
  // recorded as narration.
  assert.equal(isConnectorNotice('I can summarise the log but cannot rewrite it.\n'
    + '[Meridian Antigravity] The batch of 1 tool result for this turn was consumed and the backend\'s'
    + ' content filter stopped the reply after it had already begun.'), true)
  assert.equal(isConnectorNotice('Sophie: the blade rings free of the scabbard.'), false)
  // Prose that merely mentions the connector is narration, not a notice.
  assert.equal(isConnectorNotice('I am [Meridian Antigravity] aware, Master.'), false)
  assert.equal(isConnectorNotice('The log mentions [Meridian Antigravity] once, mid-sentence.'), false)
  assert.equal(isConnectorNotice(''), false)
  assert.equal(isConnectorNotice(undefined), false)
})

test('a connector notice is not recorded as a turn at all', async () => {
  // The repair turn completes, so the completed-turn rule alone would capture it
  // and put a system disclaimer in the campaign log as the DM's narration.
  const root = campaignWorkspace()
  await driveTurn(root, [
    { id: 'm1', role: 'user', source: { kind: 'user', rpcId: 'rpc-1' }, content: text('I draw my sword.') },
    { id: 'a1', role: 'assistant', content: text('[Meridian Antigravity] The batch of 1 tool result for'
      + ' this turn was consumed by a generation the backend blocked and never completed, so no reply'
      + ' exists for it.') },
  ])
  assert.equal(existsSync(transcriptPath(root)), false, 'a notice-only turn must not write a transcript')
})

test('a salvaged reply carrying an appended notice is not recorded either', async () => {
  // The connector now keeps a reply the content filter cut short and appends the
  // notice in a second block. The turn therefore carries real model text as well,
  // and recording it would still put the disclaimer in the campaign log.
  const root = campaignWorkspace()
  await driveTurn(root, [
    { id: 'm1', role: 'user', source: { kind: 'user', rpcId: 'rpc-1' }, content: text('Update the log.') },
    {
      id: 'a1',
      role: 'assistant',
      content: [
        { type: 'text', text: 'I cannot rewrite those passages.' },
        { type: 'text', text: '[Meridian Antigravity] The batch of 1 tool result for this turn was consumed'
          + ' and the backend\'s content filter stopped the reply after it had already begun.' },
      ],
    },
  ])
  assert.equal(existsSync(transcriptPath(root)), false, 'a salvaged turn must not enter the campaign record')
})
