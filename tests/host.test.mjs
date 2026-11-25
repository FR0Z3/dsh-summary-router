import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, setAnnounceFactory } from '../index.js'

/** Build a stub host exposing exactly the seams `apply` registers on. */
function harness(config, services = {}) {
  const sessions = new Map()
  const logs = []
  const warnings = []
  const hooks = new Map()
  const commands = []
  const calls = []
  const injected = []
  const meter = { estimateMessage: message => message.tokens ?? 0 }
  const llm = {
    stream(options) {
      calls.push(options)
      if (services.streamAsync !== undefined) return services.streamAsync(options)
      const script = services.stream?.(options, calls) ?? [{ type: 'finish', reason: { kind: 'stop' } }]
      return {
        async * [Symbol.asyncIterator]() {
          for (const chunk of script) {
            if (chunk instanceof Error) throw chunk
            yield chunk
          }
        },
      }
    },
    async resolveModelInfo(provider, model) {
      return services.modelInfo?.(provider, model) ?? { context: { contextWindow: 1_000_000 } }
    },
  }
  const ctx = {
    llm,
    sessions: { get: id => sessions.get(id) },
    agents: { get: () => ({ inject: message => injected.push(message) }) },
    get: key => (key === 'tokenMeter' ? meter : undefined),
    on(name, handler) {
      const list = hooks.get(name) ?? []
      list.push(handler)
      hooks.set(name, list)
    },
    inject(_deps, callback) {
      callback({
        commands: { register: definition => { commands.push(definition); return () => {} } },
        effect: run => run(),
        logger: ctx.logger,
      })
    },
    logger: { info: line => logs.push(line), warn: line => warnings.push(line) },
  }
  apply(ctx, config)
  const emit = (name, ...args) => {
    for (const handler of hooks.get(name) ?? []) handler(...args)
  }
  return { ctx, sessions, logs, warnings, commands, calls, injected, emit, hooks }
}

/** Consume one routed stream into a list of chunks. */
async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const finish = kind => ({ type: 'finish', reason: { kind } })
const delta = text => ({ type: 'text-delta', text })
const rateLimit = () => ({
  type: 'finish',
  reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: '429 rate limit reached' } },
})

/** A session whose committed route and pending selection the test controls. */
function sessionOf({ id = 's1', cwd = 'E:\\Misc\\Proj', header = ['a', 'old'], pending } = {}) {
  const events = [{
    type: 'request/header',
    seq: 10,
    data: { header: { config: { provider: header[0], model: header[1] } } },
  }]
  if (pending !== undefined) events.push({ type: 'model/selection', seq: 11, data: pending })
  return {
    id,
    header: { cwd },
    snapshotEvents: () => events,
    requestHeader: () => ({ config: { provider: header[0], model: header[1] } }),
  }
}

/** Drive one summary call through the registered waterfall. */
async function summarize(fx, options = {}) {
  const hook = (fx.hooks.get('llm/stream') ?? [])[0]
  assert.ok(hook, 'the stream listener is registered')
  const defaultCalled = { value: false }
  const next = () => {
    defaultCalled.value = true
    return (async function* () { yield finish('stop') })()
  }
  const stream = hook({
    purpose: 'compaction',
    sessionId: 's1',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], tokens: 1000 }],
    maxTokens: 65536,
    ...options,
  }, next)
  const chunks = await collect(stream)
  return { chunks, defaultCalled }
}

test('a pressure compaction is served by the cheap chain and names the real route', async () => {
  const fx = harness({ pressureRoutes: [{ provider: 'cheap', model: 'small' }] })
  fx.sessions.set('s1', sessionOf())
  const result = await summarize(fx)
  assert.equal(result.defaultCalled.value, false)
  assert.equal(fx.calls.length, 1)
  assert.equal(fx.calls[0].provider, 'cheap')
  assert.equal(fx.calls[0].model, 'small')
  assert.equal(fx.calls[0].purpose, 'compaction')
  assert.equal(fx.calls[0].sessionId, 's1')
  assert.deepEqual(result.chunks.map(chunk => chunk.type), ['finish'])
})

test('a switch attempts the session route first and falls back on failure', async () => {
  const fx = harness(
    { switchRoutes: [{ provider: 'safe', model: 'big' }], switchSessionFirst: true },
    {
      stream: options => (options.provider === 'a'
        ? [delta('partial'), rateLimit()]
        : [delta('sum'), finish('stop')]),
    },
  )
  fx.sessions.set('s1', sessionOf({ pending: { provider: 'b', model: 'new' } }))
  const result = await summarize(fx)
  assert.deepEqual(fx.calls.map(call => `${call.provider}/${call.model}`), ['a/old', 'safe/big'])
  // The partial output of the failed attempt is never forwarded.
  assert.deepEqual(result.chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['sum'])
  assert.equal(fx.warnings.length, 1)
})

test('a route whose window cannot hold the prefix is skipped, not attempted', async () => {
  const fx = harness(
    {
      pressureRoutes: [
        { provider: 'cheap', model: 'small' },
        { provider: 'roomy', model: 'big' },
      ],
    },
    {
      modelInfo: (_provider, model) => ({
        context: { contextWindow: model === 'small' ? 20000 : 1000000 },
      }),
    },
  )
  fx.sessions.set('s1', sessionOf())
  const result = await summarize(fx, {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }], tokens: 140000 }],
  })
  assert.deepEqual(fx.calls.map(call => call.model), ['big'])
  assert.equal(result.chunks.at(-1).type, 'finish')
})

test('an exhausted chain fails the call and cools down until the rules change', async () => {
  const fx = harness(
    { pressureRoutes: [{ provider: 'cheap', model: 'small' }], failureBackoffMs: 120000 },
    { stream: () => [rateLimit()] },
  )
  fx.sessions.set('s1', sessionOf())
  await assert.rejects(summarize(fx), /no summary route could serve this pressure compaction/)
  assert.equal(fx.calls.length, 1)
  // The same rules fail fast without spending another model call.
  await assert.rejects(summarize(fx), /every summary route failed recently/)
  assert.equal(fx.calls.length, 1)
})

test('pinning a new route through the command re-arms the cool-down immediately', async () => {
  const fx = harness(
    { pressureRoutes: [{ provider: 'cheap', model: 'small' }], failureBackoffMs: 120000 },
    {
      stream: options => (options.provider === 'pinned'
        ? [delta('sum'), finish('stop')]
        : [rateLimit()]),
    },
  )
  const session = sessionOf()
  fx.sessions.set('s1', session)
  await assert.rejects(summarize(fx), /no summary route could serve/)
  const command = fx.commands.find(definition => definition.name === 'compact-model')
  assert.ok(command)
  const pinned = await command.handler({ agent: { session }, rawInput: 'pinned/model', signal: undefined })
  assert.equal(pinned.kind, 'success')
  const result = await summarize(fx)
  assert.equal(fx.calls.at(-1).provider, 'pinned')
  assert.deepEqual(result.chunks.at(-1), finish('stop'))
})

test('an unknown session is left to the native path', async () => {
  const fx = harness({ pressureRoutes: [{ provider: 'cheap', model: 'small' }] })
  const result = await summarize(fx)
  assert.equal(result.defaultCalled.value, true)
  assert.equal(fx.calls.length, 0)
})

test('other auxiliary purposes and unscoped calls are left alone', async () => {
  const fx = harness(
    { purposes: ['compaction'], requireSession: true, pressureRoutes: [{ provider: 'cheap', model: 'small' }] },
    { stream: () => [delta('sum'), finish('stop')] },
  )
  fx.sessions.set('s1', sessionOf())
  const title = await summarize(fx, { purpose: 'session-title' })
  assert.equal(title.defaultCalled.value, true)
  const unscoped = await summarize(fx, { sessionId: undefined })
  assert.equal(unscoped.defaultCalled.value, true)
  assert.equal(fx.calls.length, 0)
})

test('a route that throws before returning a stream still falls through', async () => {
  const fx = harness(
    { pressureRoutes: [{ provider: 'x', model: 'one' }, { provider: 'y', model: 'two' }] },
    {
      stream: options => {
        if (options.provider === 'x') throw Object.assign(new Error('429 rate limit reached'), { code: 'RATE_LIMIT' })
        return [delta('sum'), finish('stop')]
      },
    },
  )
  fx.sessions.set('s1', sessionOf())
  const result = await summarize(fx)
  assert.deepEqual(fx.calls.map(call => call.provider), ['x', 'y'])
  assert.deepEqual(result.chunks.at(-1), finish('stop'))
})

test('a cancelled summary rejects as cancelled instead of as an empty summary', async () => {
  const fx = harness(
    { pressureRoutes: [{ provider: 'cheap', model: 'small' }] },
    { stream: () => [{ type: 'finish', reason: { kind: 'aborted' } }] },
  )
  fx.sessions.set('s1', sessionOf())
  const controller = new AbortController()
  controller.abort(new Error('user cancelled'))
  await assert.rejects(
    summarize(fx, { signal: controller.signal }),
    error => /cancel/.test(String(error?.message ?? error)),
  )
})

test('a silent route is abandoned after its idle timeout', async () => {
  const fx = harness(
    { pressureRoutes: [{ provider: 'slow', model: 'one' }, { provider: 'fast', model: 'two' }], attemptTimeoutMs: 300 },
    {
      streamAsync: options => (options.provider === 'slow'
        ? (async function* () { yield delta('x'); await new Promise(resolve => setTimeout(resolve, 800)); yield finish('stop') })()
        : (async function* () { yield finish('stop') })()),
    },
  )
  fx.sessions.set('s1', sessionOf())
  const started = Date.now()
  const result = await summarize(fx)
  assert.deepEqual(fx.calls.map(call => call.provider), ['slow', 'fast'])
  assert.equal(result.chunks.at(-1).type, 'finish')
  assert.ok(Date.now() - started < 800, 'the slow route is abandoned before it would have answered')
})

test('a frozen caller-owned request is routed without mutation errors', async () => {
  const fx = harness({ pressureRoutes: [{ provider: 'cheap', model: 'small' }] })
  fx.sessions.set('s1', sessionOf())
  const hook = (fx.hooks.get('llm/stream') ?? [])[0]
  const frozen = Object.freeze({
    purpose: 'compaction',
    sessionId: 's1',
    messages: Object.freeze([{ role: 'user', content: [] }]),
    maxTokens: 65536,
  })
  const chunks = await collect(hook(frozen, () => (async function* () {})()))
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(fx.calls[0].provider, 'cheap')
})

test('a manual compaction keeps the pressure chain even when a switch is pending', async () => {
  const fx = harness({
    switchRoutes: [{ provider: 'safe', model: 'big' }],
    pressureRoutes: [{ provider: 'cheap', model: 'small' }],
  })
  const session = sessionOf({ pending: { provider: 'b', model: 'new' } })
  fx.sessions.set('s1', session)
  fx.emit('session/event', session, { type: 'compaction/start', data: { compactionId: 'c1', sourceCommandId: 'cmd1' } })
  await summarize(fx)
  assert.equal(fx.calls[0].provider, 'cheap', 'the manual transaction belongs to the pressure chain')

  fx.emit('session/event', session, { type: 'compaction/end', data: { compactionId: 'c1' } })
  await summarize(fx)
  assert.equal(fx.calls.at(-1).provider, 'a', 'the switch chain is back once the manual transaction ends')
})

test('a large tool schema counts against the route window', async () => {
  const fx = harness(
    {
      pressureRoutes: [{ provider: 'cheap', model: 'small', maxTokens: 8192 }],
    },
    { modelInfo: () => ({ context: { contextWindow: 25000 } }) },
  )
  fx.sessions.set('s1', sessionOf())
  await assert.rejects(
    summarize(fx, {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }], tokens: 5000 }],
      tools: [{ name: 'huge', description: 'x'.repeat(40000), parameters: { type: 'object' } }],
    }),
    /no summary route could serve/,
  )
  assert.equal(fx.calls.length, 0, 'the route is skipped before a provider call')
})

test('unscoped calls are routed only when requireSession is off', async () => {
  const fx = harness({ requireSession: false, pressureRoutes: [{ provider: 'cheap', model: 'small' }] })
  await summarize(fx, { sessionId: undefined })
  assert.equal(fx.calls.length, 1)
  assert.equal(fx.calls[0].provider, 'cheap')

  const strict = harness({ requireSession: true, pressureRoutes: [{ provider: 'cheap', model: 'small' }] })
  const skipped = await summarize(strict, { sessionId: undefined })
  assert.equal(skipped.defaultCalled.value, true)
  assert.equal(strict.calls.length, 0)
})

test('the session command refuses a route that cannot be resolved', async () => {
  const fx = harness(
    { pressureRoutes: [] },
    {
      modelInfo: (provider) => {
        if (provider === 'nope') throw new Error('NO_ADAPTER: provider "nope" is not registered')
        return { context: { contextWindow: 1000000 } }
      },
    },
  )
  const session = sessionOf()
  fx.sessions.set('s1', session)
  const command = fx.commands.find(definition => definition.name === 'compact-model')
  const result = await command.handler({ agent: { session }, rawInput: 'nope/model' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /not usable/)
})

test('the reroute notice is posted only after a successful compaction closes', async () => {
  setAnnounceFactory(text => ({
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'compaction-router', form: 'notice', summary: text },
  }))
  const fx = harness({ announceReroute: true, pressureRoutes: [{ provider: 'cheap', model: 'small' }] })
  const session = sessionOf()
  fx.sessions.set('s1', session)
  await summarize(fx)
  assert.equal(fx.injected.length, 0, 'nothing is posted while the transaction is still open')

  fx.emit('session/event', session, { type: 'compaction/end', data: {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fx.injected.length, 1)
  assert.match(fx.injected[0].content[0].text, /cheap\/small/)
  assert.equal(fx.injected[0].source.form, 'notice')

  // The pending notice is consumed once, not replayed by the next transaction.
  fx.emit('session/event', session, { type: 'compaction/end', data: {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fx.injected.length, 1)
})

test('a failed compaction posts no notice, and the switch is silent by default', async () => {
  setAnnounceFactory(text => ({ role: 'user', content: [{ type: 'text', text }] }))
  const failed = harness(
    { announceReroute: true, pressureRoutes: [{ provider: 'cheap', model: 'small' }], failureBackoffMs: 0 },
    { stream: () => [rateLimit()] },
  )
  const failedSession = sessionOf()
  failed.sessions.set('s1', failedSession)
  await assert.rejects(summarize(failed))
  failed.emit('session/event', failedSession, { type: 'compaction/end', data: { error: 'boom' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(failed.injected.length, 0)

  const quiet = harness({ pressureRoutes: [{ provider: 'cheap', model: 'small' }] })
  const quietSession = sessionOf()
  quiet.sessions.set('s1', quietSession)
  await summarize(quiet)
  quiet.emit('session/event', quietSession, { type: 'compaction/end', data: {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(quiet.injected.length, 0, 'announceReroute defaults off')
})

test('the session command pins a route and clears it again', async () => {
  const fx = harness({ pressureRoutes: [{ provider: 'cheap', model: 'small' }] })
  const session = sessionOf()
  fx.sessions.set('s1', session)
  const command = fx.commands.find(definition => definition.name === 'compact-model')
  assert.ok(command)
  const pinned = await command.handler({ agent: { session }, rawInput: 'pinned/model low', signal: undefined })
  assert.equal(pinned.kind, 'success')
  assert.match(pinned.text, /pinned\/model/)
  await summarize(fx)
  assert.equal(fx.calls.at(-1).provider, 'pinned')
  assert.equal(fx.calls.at(-1).reasoningEffort, 'low')

  const cleared = await command.handler({ agent: { session }, rawInput: 'off' })
  assert.equal(cleared.kind, 'success')
  const status = await command.handler({ agent: { session }, rawInput: '' })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /pressure/)
})
