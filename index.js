/**
 * Host side of the compaction router: reroute compaction summary calls to the
 * model each session (or workspace) chose, with a fallback chain.
 *
 * The seam is `llm/stream`, the waterfall every model call passes through.
 * A compaction summary is one hand-built call carrying `purpose: 'compaction'`
 * and the session id, so one listener covers every trigger: step pressure,
 * context overflow, the model-switch check, and the manual `/compact` command,
 * no matter which compaction backend owns them.
 */
import z from '@deepseek-ai/schemastery'
import {
  coolingDown,
  configFingerprint,
  fitRoute,
  normalizeConfig,
  normalizeRoute,
  normalizeSessionOverride,
  routeLabel,
  scopeName,
  selectChain,
  withRequestedRoute,
  workspaceFor,
} from './logic.js'

/** Marks a request this plugin already routed, so the replacement call cannot re-enter. */
const ROUTED = Symbol.for('dsh-compaction-router.routed')

/** Plugin-record type carrying the per-session selection, safe to replay on resume. */
const RECORD = 'plugin:dsh-compaction-router/selected'

/** Prefix every diagnostic this plugin writes shares. */
const SCOPE = 'compaction router'

/** Conclusion of one attempt. */
const OK = 'ok'
const FAILED = 'failed'
const ABORTED = 'aborted'

/** Fields of a hand-built model call this plugin forwards unchanged. */
const FORWARDED = [
  'messages', 'tools', 'toolHistory', 'system', 'temperature', 'stop', 'sessionId', 'purpose',
]

const routeSchema = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  reasoningEffort: z.string(),
  maxTokens: z.number().step(1).min(1),
})

/** All fields are volatile so edits apply without restarting a running agent. */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  /** Auxiliary call purposes this plugin may reroute; the summarizer's is `compaction`. */
  purposes: z.array(z.string()).default(['compaction']).volatile(),
  /** Ignore calls that carry no session id, which cannot be scoped. */
  requireSession: z.boolean().default(true).volatile(),
  /** Chain used by the model-switch check. */
  switchRoutes: z.array(routeSchema).default([]).volatile(),
  /** Try the session's own route before the switch chain. */
  switchSessionFirst: z.boolean().default(true).volatile(),
  /** Chain used by automatic pressure, context overflow and manual compaction. */
  pressureRoutes: z.array(routeSchema).default([]).volatile(),
  /** Post one notice line into the session when a summary is rerouted. */
  announceReroute: z.boolean().default(false).volatile(),
  workspaces: z.array(z.object({
    path: z.string().required(),
    enabled: z.boolean(),
    switchRoutes: z.union([z.const(null), z.array(routeSchema)]),
    pressureRoutes: z.union([z.const(null), z.array(routeSchema)]),
    sessionFirst: z.boolean(),
  })).default([]).volatile(),
  safetyMarginTokens: z.number().step(1).min(0).default(8192).volatile(),
  attemptTimeoutMs: z.number().step(1).min(1000).default(120000).volatile(),
  failureBackoffMs: z.number().step(1).min(0).default(60000).volatile(),
})

export const inject = ['llm', 'sessions', 'agents']

/** Test seam: replaces the lazily resolved user-message factory. */
let announceFactory

/** Replace the message factory (tests only). */
export function setAnnounceFactory(factory) {
  announceFactory = factory
}

/** Build the one-line user notice the plugin posts after a reroute. */
async function userMessageOf(text) {
  if (announceFactory !== undefined) return announceFactory(text)
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
  // Same shape DSH's own model-switch notice uses: an attributed user message
  // with the `notice` form, so the harness renders it as one context line
  // instead of a chat bubble. Any source kind string is legal at runtime; the
  // TypeScript-side `MessageSourceMap` entry is a compile-time concern only.
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'compaction-router', form: 'notice', summary: text },
  })
}

/** Post the notice into the session, best effort. */
async function announceRoute(ctx, sessionId, text) {
  const agent = ctx.agents?.get?.(sessionId)
  if (agent === undefined) return
  try {
    agent.inject(await userMessageOf(text))
  } catch (error) {
    ctx.logger.warn(`${SCOPE}: could not post the reroute notice (${errorMessage(error)})`)
  }
}

/** Estimate the prompt the summary will replay, in the meter's own units. */
function estimatePrompt(ctx, messages, tools, system) {
  const meter = ctx.get('tokenMeter')
  if (meter === undefined || typeof meter.estimateMessage !== 'function') return undefined
  let total = 0
  for (const message of messages ?? []) total += meter.estimateMessage(message)
  // Tool schemas and one-shot system text ride the same request. The meter prices
  // a schema by its JSON density, so the window check uses the same rule instead
  // of a per-tool constant that a large MCP schema would blow through.
  if (Array.isArray(tools) && tools.length > 0) {
    try { total += Math.ceil(JSON.stringify(tools).length / 4) + 4 } catch { total += tools.length * 200 }
  }
  if (typeof system === 'string' && system.length > 0) total += Math.ceil(system.length / 4) + 4
  return total
}

/** The session working directory, which is what a workspace override matches. */
function cwdOf(session) {
  for (const candidate of [session?.header?.cwd, session?.cwd, session?.workingDirectory]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/** Read the per-session selection from the session log's plugin records. */
function readSessionOverride(session) {
  if (typeof session?.snapshotEvents !== 'function') return undefined
  let events
  try {
    events = session.snapshotEvents()
  } catch {
    return undefined
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== RECORD) continue
    return normalizeSessionOverride(event.data)
  }
  return undefined
}

/**
 * Read the committed and pending routes of a session.
 *
 * The durable `modelSelection` projection is exact: a recorded selection stays
 * pending until a request header matching it retires it. When that projection is
 * not registered, the same fact is reconstructed from the two event types.
 */
function routesOf(ctx, session) {
  const header = session?.requestHeader?.()?.config
  const committed = header === undefined
    ? undefined
    : { provider: header.provider, model: header.model }
  let pending
  const projections = ctx.get('sessionProjections')
  if (projections !== undefined && typeof projections.snapshot === 'function') {
    try {
      // The wire view exposes `next` (pending, else last used) and never the
      // internal pending field; `next` is only a pending route when it actually
      // differs from the committed one.
      const view = projections.snapshot(session, ['modelSelection'])?.values?.modelSelection
      const next = view?.next ?? undefined
      if (next !== undefined && committed !== undefined
        && (next.provider !== committed.provider || next.model !== committed.model)) {
        pending = next
      }
    } catch { /* an unavailable projection falls back to the log scan below */ }
  }
  if (pending === undefined && typeof session?.snapshotEvents === 'function') {
    let selection
    let lastHeader
    try {
      for (const event of session.snapshotEvents()) {
        if (event.type === 'model/selection') selection = event
        else if (event.type === 'request/header') lastHeader = event
      }
    } catch { /* no readable log, no pending route */ }
    if (selection !== undefined && (lastHeader === undefined || selection.seq > lastHeader.seq)) {
      pending = selection.data
    }
  }
  return { committed, pending: pending ?? undefined }
}

/**
 * Record the per-session selection in the log.
 *
 * `appendPluginRecord` marks the event ignorable, which is what keeps a log
 * containing an unknown type replayable; it is imported lazily so the host half
 * still loads in a profile that resolves the session package differently.
 */
async function appendRecord(ctx, session, data) {
  try {
    const { appendPluginRecord } = await import('@deepseek-ai/dsh-session')
    appendPluginRecord(session, RECORD, data)
    return true
  } catch (error) {
    ctx.logger.warn(`${SCOPE}: could not record the session route (${errorMessage(error)})`)
    return false
  }
}

/** Run one route's summary attempt, buffering chunks so a retry cannot duplicate output. */
async function runAttempt(ctx, options, route, timeoutMs) {
  const controller = new AbortController()
  const outer = options.signal
  const relay = () => controller.abort(outer.reason)
  if (outer !== undefined) {
    if (outer.aborted) return { outcome: ABORTED, chunks: [] }
    outer.addEventListener('abort', relay, { once: true })
  }
  const forwarded = {}
  for (const field of FORWARDED) {
    if (options[field] !== undefined) forwarded[field] = options[field]
  }
  const request = {
    ...forwarded,
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined
      ? (route.carryEffort === true && options.reasoningEffort !== undefined
        ? { reasoningEffort: options.reasoningEffort }
        : {})
      : { reasoningEffort: route.reasoningEffort }),
    ...(route.maxTokens === undefined
      ? (options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens })
      : { maxTokens: route.maxTokens }),
    signal: controller.signal,
    [ROUTED]: true,
  }
  const chunks = []
  let usage
  let idleTimer
  let fireIdle
  const idle = new Promise(resolve => { fireIdle = resolve })
  /** Restart the idle window: one timer, one promise, reset after every chunk. */
  const armIdle = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      controller.abort(new Error(`no output within ${timeoutMs}ms`))
      fireIdle({ idle: true })
    }, timeoutMs)
  }
  try {
    armIdle()
    // Dispatch can throw before it returns an iterable at all — a missing
    // adapter, a credential failure, or a middleware throwing. That is one more
    // failed route, not the end of the chain, and the idle timer must not leak.
    const iterator = ctx.llm.stream(request)[Symbol.asyncIterator]()
    while (true) {
      const raced = await Promise.race([iterator.next(), idle])
      if (raced !== undefined && raced !== null && raced.idle === true) {
        // The timer aborted the attempt. Closing the iterator is best effort and
        // must not delay failover: a generator parked on its own timer would
        // otherwise hold this call until it resumes.
        try {
          const drained = iterator.return?.()
          if (drained !== undefined && typeof drained.then === 'function') drained.catch(() => {})
        } catch { /* the failure is the outcome */ }
        return { outcome: FAILED, chunks, usage, reason: `no output within ${timeoutMs}ms` }
      }
      if (raced.done === true) {
        return { outcome: FAILED, chunks, usage, reason: 'the stream ended without a finish chunk' }
      }
      armIdle()
      const chunk = raced.value
      chunks.push(chunk)
      if (chunk.type === 'usage') usage = chunk.usage
      if (chunk.type !== 'finish') continue
      const kind = chunk.reason?.kind
      if (kind === 'error' || kind === 'aborted') {
        if (kind === 'aborted' && (outer?.aborted ?? false)) return { outcome: ABORTED, chunks, usage }
        return { outcome: FAILED, chunks, usage, reason: describeFailure(chunk) }
      }
      if (kind === 'max-tokens') {
        return { outcome: FAILED, chunks, usage, reason: 'the summary hit the route output cap and was truncated' }
      }
      return { outcome: OK, chunks, usage }
    }
  } catch (error) {
    if (outer !== undefined && outer.aborted) return { outcome: ABORTED, chunks, usage }
    return { outcome: FAILED, chunks, usage, reason: errorMessage(error) }
  } finally {
    clearTimeout(idleTimer)
    if (outer !== undefined) outer.removeEventListener('abort', relay)
  }
}

/** The human-readable cause of a failed terminal chunk. */
function describeFailure(chunk) {
  const failure = chunk.reason?.failure
  if (failure === undefined) return 'the model call failed'
  const code = typeof failure.code === 'string' ? failure.code : 'UNKNOWN'
  const message = typeof failure.message === 'string' ? failure.message : ''
  return message.length > 0 ? `${code}: ${message}` : code
}

/** The message of an unknown thrown value. */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Render provider-reported usage without assuming its field names. */
function describeUsage(usage) {
  const parts = Object.entries(usage ?? {})
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
    .map(([key, value]) => `${key}=${value}`)
  return parts.length === 0 ? 'reported' : parts.join(' ')
}

/**
 * Serve one summary call through the configured chain.
 * @returns the chunks of the first route that produced a summary.
 */
async function* routeCompaction(ctx, config, plan, options, state) {
  // Cancellation is not a summary failure: let it reach the caller as one.
  const cancelIfAborted = () => {
    if (options.signal?.aborted) options.signal.throwIfAborted?.()
  }
  cancelIfAborted()
  // The chain itself is part of the identity: changing a route through the
  // command must re-arm a cooled-down session immediately.
  const fingerprint = `${configFingerprint(config)}|${plan.trigger}|${JSON.stringify(
    plan.chain.map(route => [route.provider, route.model, route.reasoningEffort ?? '', route.maxTokens ?? '']),
  )}`
  const now = Date.now()
  if (coolingDown(state.failure, fingerprint, now, config.failureBackoffMs)) {
    throw new Error(
      `${SCOPE}: every summary route failed recently (${state.failure.reason}); `
      + 'change the summary route and retry',
    )
  }
  const promptTokens = estimatePrompt(ctx, options.messages, options.tools, options.system)
  const skipped = []
  for (const route of plan.chain) {
    cancelIfAborted()
    let info
    if (typeof ctx.llm.resolveModelInfo === 'function') {
      try {
        info = await ctx.llm.resolveModelInfo(route.provider, route.model, options.signal)
      } catch (error) {
        skipped.push(`${routeLabel(route)}: route unavailable (${errorMessage(error)})`)
        continue
      }
    }
    const decision = fitRoute(route, {
      contextWindow: info?.context?.contextWindow,
      promptTokens,
      maxTokens: options.maxTokens,
      marginTokens: config.safetyMarginTokens,
    })
    if (!decision.fits) {
      skipped.push(
        `${routeLabel(route)}: needs ${decision.required} tokens (prefix ${promptTokens ?? 'unknown'}, `
        + `margin ${config.safetyMarginTokens}) but its window is ${decision.contextWindow}`,
      )
      continue
    }
    const started = Date.now()
    const attempt = await runAttempt(ctx, options, route, config.attemptTimeoutMs)
    if (attempt.outcome === ABORTED) {
      // Cancellation is not a summary failure: let it reach the caller as one.
      options.signal?.throwIfAborted?.()
      return
    }
    if (attempt.outcome === FAILED) {
      skipped.push(`${routeLabel(route)}: ${attempt.reason}`)
      // A failed attempt still bills whatever it produced; surface that so the
      // chain's real cost is auditable instead of silently absorbed.
      ctx.logger.warn(
        `${SCOPE}: ${plan.trigger} summary via ${routeLabel(route)} failed (${attempt.reason})`
        + `${attempt.usage === undefined ? '' : `; usage ${describeUsage(attempt.usage)}`}`,
      )
      continue
    }
    // The call succeeded on `route`: record it on the caller's own request so
    // the durable compaction/summary event names the model that wrote it. Its
    // `maxTokens` field is owned by the backend config, so a per-route cap is
    // reported here instead of rewritten onto a request the caller still reads.
    try {
      options.provider = route.provider
      options.model = route.model
      if (route.reasoningEffort !== undefined) options.reasoningEffort = route.reasoningEffort
    } catch { /* a frozen caller-owned request keeps its own route */ }
    state.failure = undefined
    if (config.announceReroute && options.sessionId !== undefined) {
      // Posted once the compaction transaction closes, so the notice lands after
      // the checkpoint instead of in the middle of the summarization.
      state.pendingAnnounce = {
        sessionId: options.sessionId,
        at: Date.now(),
        text: `${SCOPE}: summary written by ${routeLabel(route)} (${plan.trigger})`,
      }
    }
    ctx.logger.info(
      `${SCOPE}: ${plan.trigger} summary via ${routeLabel(route)} (${scopeName(plan.source)}), `
      + `cap ${route.maxTokens ?? options.maxTokens ?? 'model default'}, ${Date.now() - started}ms`,
    )
    for (const chunk of attempt.chunks) yield chunk
    return
  }
  cancelIfAborted()
  state.failure = { fingerprint, at: Date.now(), reason: skipped.join('; ') }
  throw new Error(
    `${SCOPE}: no summary route could serve this ${plan.trigger} compaction. ${skipped.join('; ')}. `
    + 'Change the compaction route in the plugin settings and retry',
  )
}

/** One-line answer for `/compact-model status`: what the router would do here. */
function statusText(config, evidence) {
  const plan = selectChain(config, evidence)
  const context = {
    cwd: evidence.cwd,
    header: evidence.committed,
    pending: evidence.pending,
    override: evidence.override,
  }
  const lines = [`enabled: ${config.enabled}`]
  lines.push(`workspace: ${workspaceFor(config, evidence.cwd)?.path ?? 'none'}`)
  for (const trigger of ['switch', 'pressure']) {
    const chain = selectChain(config, context, trigger)
    lines.push(`${trigger}: ${chain === undefined
      ? '(not rerouted)'
      : `${chain.chain.map(routeLabel).join(' → ')} (${scopeName(chain.source)})`}`)
  }
  lines.push(`active: ${plan === undefined
    ? '(not rerouted)'
    : `${plan.trigger} (${scopeName(plan.source)})`}`)
  lines.push(`session route: ${evidence.committed === undefined
    ? 'none'
    : `${evidence.committed.provider}/${evidence.committed.model}`}`)
  lines.push(`pending route: ${evidence.pending === undefined
    ? 'none'
    : `${evidence.pending.provider}/${evidence.pending.model}`}`)
  return lines.join('\n')
}

export function apply(ctx, rawConfig) {
  /** Per-session breaker and override bookkeeping, keyed by the session object itself. */
  const states = new WeakMap()
  const unscoped = {}

  // One line at load so a host log can tell "the row is mounted" from "nothing
  // needed routing". It intentionally carries no per-session detail.
  try {
    const initial = normalizeConfig(rawConfig)
    ctx.logger.info(
      `${SCOPE}: ready — switch ${initial.global.switchRoutes.length} route(s), `
      + `pressure ${initial.global.pressureRoutes.length}, ${initial.workspaces.length} workspace override(s)`,
    )
  } catch (error) {
    ctx.logger.warn(`${SCOPE}: configuration is unusable (${errorMessage(error)})`)
  }

  const stateFor = session => {
    if (session === undefined) return unscoped
    let state = states.get(session)
    if (state === undefined) {
      state = {}
      states.set(session, state)
    }
    return state
  }

  const evidenceFor = (session, state) => ({
    committed: session?.requestHeader?.()?.config,
    pending: routesOf(ctx, session).pending,
    override: overrideOf(session, state),
    cwd: cwdOf(session),
  })

  /** Read the session override once from the log; a later command updates it in memory. */
  const overrideOf = (session, state) => {
    if (state.override === undefined && state.overrideLoaded !== true) {
      state.override = readSessionOverride(session)
      state.overrideLoaded = true
    }
    return state.override
  }

  const planFor = (session, state) => {
    const evidence = evidenceFor(session, state)
    const plan = selectChain(normalizeConfig(rawConfig), {
      cwd: evidence.cwd,
      header: evidence.committed,
      pending: evidence.pending,
      override: evidence.override,
    }, state.manualCompaction === true ? 'pressure' : undefined)
    return { evidence, plan }
  }

  /** The command must report a broken config, not throw out of the handler. */
  const safePlan = (session, state) => {
    try {
      return { ...planFor(session, state), problem: undefined }
    } catch (error) {
      return { evidence: evidenceFor(session, state), plan: undefined, problem: errorMessage(error) }
    }
  }

  // A manual `/compact` runs outside the request path, so the session log is the
  // only evidence that this summary is not the model-switch one. `compaction/start`
  // carries the initiating command id for exactly that transaction.
  ctx.on('session/event', (session, event) => {
    if (session === undefined) return
    if (event?.type === 'compaction/start') {
      stateFor(session).manualCompaction = event.data?.sourceCommandId !== undefined
    } else if (event?.type === 'compaction/end') {
      const state = stateFor(session)
      state.manualCompaction = false
      const pending = state.pendingAnnounce
      state.pendingAnnounce = undefined
      // A failed transaction keeps the notice out of the transcript, and an old
      // pending notice must not attach itself to some later compaction.
      if (pending !== undefined && event.data?.error === undefined && Date.now() - pending.at < 300000) {
        void announceRoute(ctx, pending.sessionId, pending.text)
      }
    }
  })

  ctx.on('llm/stream', (options, next) => {
    if (options[ROUTED] === true) return next()
    // Ordinary conversation requests carry no purpose; returning early keeps
    // every loop-built call out of this plugin's configuration work.
    if (options.purpose === undefined) return next()
    let config
    try {
      config = normalizeConfig(rawConfig)
    } catch (error) {
      ctx.logger.warn(`${SCOPE}: configuration is unusable (${errorMessage(error)}); not rerouting`)
      return next()
    }
    if (!config.enabled) return next()
    if (config.requireSession && options.sessionId === undefined) return next()
    if (!config.purposes.includes(options.purpose)) return next()
    const session = options.sessionId === undefined ? undefined : ctx.sessions.get(options.sessionId)
    // An unregistered session cannot be classified (no committed route, no
    // pending selection) and cannot carry an override. With `requireSession`
    // off it is still routed, but only through the global pressure chain.
    if (session === undefined && config.requireSession) return next()
    const state = stateFor(session)
    const committed = session?.requestHeader?.()?.config
    const plan = selectChain(config, {
      cwd: cwdOf(session),
      header: committed,
      pending: session === undefined ? undefined : routesOf(ctx, session).pending,
      override: session === undefined ? undefined : overrideOf(session, state),
    }, state.manualCompaction === true ? 'pressure' : undefined)
    if (plan === undefined) return next()
    // Another layer (the surcharge guard's per-rule model, a preset override)
    // may have chosen the summary route already. Same provider: keep its choice
    // first and let our chain back it up. Different provider: our chain stays in
    // charge, because that guarantee is what this plugin exists for.
    const requested = {
      provider: options.provider,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
    }
    const chain = withRequestedRoute(plan.chain, requested, committed)
    if (chain !== plan.chain) {
      ctx.logger.info(
        `${SCOPE}: keeping the caller's summary model ${routeLabel(requested)} as the first attempt `
        + '— same provider as the configured chain',
      )
      return routeCompaction(ctx, config, { ...plan, chain }, options, state)
    }
    return routeCompaction(ctx, config, plan, options, state)
  }, { global: true, prepend: true })

  /**
   * Per-session override command: `/compact-model` reports the effective routes,
   * `/compact-model off` clears the override, and `/compact-model provider/model`
   * (optionally with a reasoning effort) points both chains at one route.
   */  ctx.inject(['commands'], scope => {    scope.effect(() => scope.commands.register({
      name: 'compact-model',
      description: 'Choose the model that writes this session\'s compaction summaries',
      input: { hint: '<provider>/<model> [effort] | off' },
      handler: async ({ agent, rawInput, signal }) => {
        if (signal?.aborted) return { kind: 'error', text: 'Compaction route change cancelled.' }
        const session = agent?.session
        if (session === undefined) return { kind: 'error', text: 'This command needs a session.' }
        const state = stateFor(session)
        const { evidence, problem } = safePlan(session, state)
        if (problem !== undefined) {
          return { kind: 'error', text: `The compaction router configuration is unusable: ${problem}` }
        }
        const argument = String(rawInput ?? '').trim()
        if (argument.length === 0 || argument === 'status') {
          return { kind: 'success', text: statusText(normalizeConfig(rawConfig), evidence) }
        }
        if (argument === 'off') {
          state.override = undefined
          state.overrideLoaded = true
          const persisted = await appendRecord(ctx, session, { cleared: true })
          return {
            kind: 'success',
            text: 'This session uses the configured compaction chain again.'
              + `${persisted ? '' : ' (not persisted: the session log could not be written)'}`,
          }
        }
        const [head, ...rest] = argument.split(/\s+/)
        const slash = head.indexOf('/')
        if (slash <= 0 || slash === head.length - 1) {
          return { kind: 'error', text: 'Use /compact-model <provider>/<model> [effort], off, or no argument.' }
        }
        const route = normalizeRoute({
          provider: head.slice(0, slash),
          model: head.slice(slash + 1),
          reasoningEffort: rest[0],
        })
        if (route === undefined) {
          return { kind: 'error', text: 'Both a provider and a model are required.' }
        }
        // Fail a typo here instead of spending a compaction attempt later.
        if (typeof ctx.llm.resolveModelInfo === 'function') {
          try {
            await ctx.llm.resolveModelInfo(route.provider, route.model)
          } catch (error) {
            return { kind: 'error', text: `That route is not usable: ${errorMessage(error)}` }
          }
        }
        const selection = { switchRoutes: [route], pressureRoutes: [route], sessionFirst: false }
        state.override = normalizeSessionOverride(selection)
        state.overrideLoaded = true
        const persisted = await appendRecord(ctx, session, selection)
        return {
          kind: 'success',
          text: `Compaction summaries for this session now use ${routeLabel(route)}.`
            + `${persisted ? '' : ' (not persisted: the session log could not be written)'}`,
        }
      },
    }))
  })
}
