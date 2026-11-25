import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import * as router from '../index.js'

const install = process.env.DSH_INSTALL_DIR
const useInstalled = Boolean(install) && (process.versions.electron !== undefined || !install.includes('.asar'))

/**
 * One real `agent/request` waterfall over the installed packages.
 *
 * The shipped Basic backend owns the model-switch compaction, and the router
 * only ever sees the auxiliary summary call it makes. This drives the real
 * switch path — header comparison, threshold pricing, summary transaction — so
 * a 429 on the first route proves the fallback chain really takes over instead
 * of the switch failing with `MODEL_SWITCH_COMPACTION_FAILED`.
 */
async function run({ summaryFailure = 'rate-limit', summaryThrows = false } = {}) {
  const require = createRequire(`${install}/package.json`)
  const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)))
  const { Context, Service } = await load('cordis')
  const { Session, SessionId } = await load('dsh-session')
  const { agentEvents } = await load('dsh-agent')
  const { createUserMessage } = await load('dsh-llm')
  const { BasicCompactionEngine } = await load('dsh-compaction-basic')
  const { TokenMeter } = await load('dsh-token-meter')

  const ctx = new Context()
  const session = Session.create(SessionId(`compaction-router-${Math.random().toString(16).slice(2, 8)}`))
  const committed = { provider: 'flaky', model: 'old' }
  const target = { provider: 'sane', model: 'new' }
  const fallback = { provider: 'sane', model: 'fallback' }
  const agent = { id: session.id, ctx, session, options: committed }
  const signal = new AbortController().signal
  const streams = []
  const summaries = []

  /** A real service: the framework wraps every read in a traceable proxy. */
  class OfflineLlm extends Service {
    constructor(owner) { super(owner, 'llm') }
    imageRequestPricing() {}
    async resolveModelInfo(provider, model) {
      return { context: { contextWindow: 200000 }, defaultMaxTokens: 65536, provider, id: model, name: model }
    }
    async resolveCallConfig(config) { return config }
    /** Dispatch exactly like the shipped runtime, so `llm/stream` listeners run. */
    stream(options) {
      return this.ctx.waterfall(this, 'llm/stream', options, () => this.reply(options))
    }
    reply(options) {
      if (options.provider === committed.provider && summaryThrows) {
        // The shape a middleware or credential failure can take: the call never
        // returns an iterable at all.
        throw Object.assign(new Error('429 rate limit reached'), { code: 'RATE_LIMIT' })
      }
      streams.push({ provider: options.provider, model: options.model, purpose: options.purpose })
      if (options.provider === committed.provider) {
        const failure = summaryFailure === 'server-error'
          ? { code: 'UNKNOWN', message: '500 upstream error' }
          : { code: 'RATE_LIMIT', message: '429 rate limit reached' }
        return (async function* () {
          yield { type: 'finish', reason: { kind: 'error', failure } }
        })()
      }
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: 'checkpoint written elsewhere' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    }
  }

  new OfflineLlm(ctx)
  ctx.provide('sessions', { get: id => (id === session.id ? session : undefined), flush: async () => {} })
  ctx.provide('agents', { get: id => (id === session.id ? agent : undefined) })
  new TokenMeter(ctx)
  const engine = new BasicCompactionEngine(ctx.isolate('compaction'), { auto: true, maxTokens: 65536 })
  ctx.provide('agentPresets', { serviceFor: () => engine })

  const user = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
  session.append('turn/start', { turn: 1 })
  // Enough foldable history that a 200k window puts the session over its
  // threshold while a verbatim tail can still be chosen mid-list.
  for (let index = 0; index < 20; index += 1) {
    session.append('user/message', user(`history ${index} `.repeat(1500)), { surfaceOp: 'append' })
  }
  session.append('user/message', user('keep recent '.repeat(200)), { surfaceOp: 'append' })
  session.append('request/header', {
    header: { config: { ...committed, maxTokens: 65536 } },
    reason: 'change',
  })
  // The switch is pending: recorded selection differs from the committed route.
  session.append('model/selection', { ...target })

  const switchRequest = () => agentEvents(ctx, agent).waterfall(
    'agent/request',
    { turn: 1, step: 2, signal },
    async () => ({ ...target, maxTokens: 65536 }),
  )
  return { ctx, session, agent, committed, target, fallback, streams, summaries, engine, switchRequest }
}

/** Mount the router with a switch chain that starts at the fallback route. */
async function mount(target, config = {}) {
  const fiber = target.ctx.plugin({ apply: router.apply, Config: router.Config, inject: router.inject }, {
    switchSessionFirst: false,
    switchRoutes: [{ provider: 'sane', model: 'fallback' }],
    pressureRoutes: [],
    ...config,
  })
  await fiber
  return fiber
}

test('installed DSH: a 429 on the switch summary falls through to the chain', { skip: !useInstalled }, async () => {
  const fx = await run({ summaryFailure: 'rate-limit' })
  const fiber = await mount(fx, { switchSessionFirst: true })
  try {
    const config = await fx.switchRequest()
    assert.equal(config.provider, fx.target.provider, 'the switch is allowed once a summary exists')
    const summary = fx.session.snapshotEvents().find(event => event.type === 'compaction/summary')
    assert.ok(summary, 'the compaction transaction committed')
    assert.deepEqual([summary.data.provider, summary.data.model], [fx.fallback.provider, fx.fallback.model])
    // The session's own route failed with 429, then the configured fallback.
    assert.deepEqual(fx.streams.map(entry => entry.provider), [fx.committed.provider, fx.fallback.provider])
  } finally {
    await fiber.dispose()
  }
})

test('installed DSH: a 500 on the switch summary also falls through', { skip: !useInstalled }, async () => {
  const fx = await run({ summaryFailure: 'server-error' })
  const fiber = await mount(fx, { switchSessionFirst: true })
  try {
    const config = await fx.switchRequest()
    assert.equal(config.provider, fx.target.provider)
    assert.deepEqual(fx.streams.map(entry => entry.provider), [fx.committed.provider, fx.fallback.provider])
  } finally {
    await fiber.dispose()
  }
})

test('installed DSH: a summary call that throws instead of streaming still falls through', { skip: !useInstalled }, async () => {
  const fx = await run({ summaryThrows: true })
  const fiber = await mount(fx, { switchSessionFirst: true })
  try {
    const config = await fx.switchRequest()
    assert.equal(config.provider, fx.target.provider, 'a synchronous 429 must not abort the chain')
    const summary = fx.session.snapshotEvents().find(event => event.type === 'compaction/summary')
    assert.deepEqual([summary.data.provider, summary.data.model], [fx.fallback.provider, fx.fallback.model])
  } finally {
    await fiber.dispose()
  }
})

test('installed DSH: skipping the session route costs no failing attempt', { skip: !useInstalled }, async () => {
  const fx = await run({ summaryFailure: 'rate-limit' })
  const fiber = await mount(fx, { switchSessionFirst: false })
  try {
    const config = await fx.switchRequest()
    assert.equal(config.provider, fx.target.provider)
    assert.deepEqual(fx.streams.map(entry => entry.provider), [fx.fallback.provider])
  } finally {
    await fiber.dispose()
  }
})

test('installed DSH: without the router the same 429 blocks the switch', { skip: !useInstalled }, async () => {
  const fx = await run({ summaryFailure: 'rate-limit' })
  await assert.rejects(fx.switchRequest(), error => /MODEL_SWITCH_COMPACTION_FAILED/.test(error?.code ?? '')
    || /Cannot switch to/.test(error?.message ?? ''))
})
