/**
 * Pure configuration, scope resolution and attempt planning for compaction
 * routing. No Cordis, no I/O, no clock: every input is an argument so the rules
 * can be tested without a running Harness.
 *
 * @module dsh-summary-router/logic
 */

/** Values used when the row's config omits a field. */
export const DEFAULTS = Object.freeze({
  purposes: ['compaction'],
  requireSession: true,
  sessionFirst: true,
  safetyMarginTokens: 8192,
  attemptTimeoutMs: 120000,
  failureBackoffMs: 60000,
})

/** Trigger names a chain can be configured for. */
export const TRIGGERS = Object.freeze(['switch', 'pressure'])

/** Unwrap one live (volatile) config reference. */
function liveValue(field, fallback) {
  if (field === undefined) return fallback
  if (field !== null && typeof field === 'object' && typeof field.get === 'function') return field.get()
  return field
}

/** Read a non-negative integer, falling back when the value is unusable. */
function nonNegativeInteger(value, fallback) {
  const parsed = Math.trunc(Number(value))
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback
}

/** Read a positive integer, falling back when the value is unusable. */
function positiveInteger(value, fallback) {
  const parsed = Math.trunc(Number(value))
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

/** Read a boolean, falling back when the value is unusable. */
function booleanValue(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** Trim a string field, tolerating absent or non-string values. */
function text(value) {
  return typeof value === 'string' ? value.replace(/[\u200b-\u200d\ufeff]/g, '').trim() : ''
}

/**
 * Validate one configured route.
 * @param entry - candidate from configuration.
 * @returns a complete route, or `undefined` when it cannot be routed.
 */
export function normalizeRoute(entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  const provider = text(entry.provider)
  const model = text(entry.model)
  if (provider.length === 0 || model.length === 0) return undefined
  const effort = text(entry.reasoningEffort)
  const maxTokens = Number(entry.maxTokens)
  const route = { provider, model }
  if (effort.length > 0 && effort.length <= 64) route.reasoningEffort = effort
  if (Number.isSafeInteger(Math.trunc(maxTokens)) && maxTokens > 0) route.maxTokens = Math.trunc(maxTokens)
  return route
}

/**
 * Normalize a route list, dropping unusable and duplicate routes.
 * @param list - candidate routes from configuration.
 * @returns routes in configured order.
 */
export function normalizeRoutes(list) {
  const routes = []
  const seen = new Set()
  for (const candidate of Array.isArray(list) ? list : []) {
    const route = normalizeRoute(candidate)
    if (route === undefined) continue
    const key = `${route.provider}\u0000${route.model}\u0000${route.reasoningEffort ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    routes.push(route)
  }
  return routes
}

/** Normalize a path into the comparison key both sides are matched through. */
export function pathKey(path) {
  const raw = text(path)
  if (raw.length === 0) return ''
  const normalized = raw.replace(/[\\/]+/g, '\\').replace(/\\+$/g, '')
  return normalized.toLowerCase()
}

/** Whether `cwdKey` is the workspace root or a directory inside it. */
function within(cwdKey, workspaceKey) {
  if (cwdKey.length === 0 || workspaceKey.length === 0) return false
  return cwdKey === workspaceKey || cwdKey.startsWith(`${workspaceKey}\\`)
}

/**
 * Read one optional chain declaration.
 * @param list - configured routes, or absent.
 * @returns `null` when the scope inherits the chain, otherwise the route list.
 */
function chainOf(list) {
  const value = liveValue(list, undefined)
  return value === undefined || value === null ? null : normalizeRoutes(value)
}

/**
 * Normalize one workspace override.
 * @param entry - candidate workspace entry.
 * @returns the entry, or `undefined` when it carries no usable path.
 */
function normalizeWorkspace(entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  const key = pathKey(entry.path)
  if (key.length === 0) return undefined
  return {
    key,
    path: text(entry.path),
    enabled: entry.enabled !== false,
    switchRoutes: chainOf(entry.switchRoutes),
    pressureRoutes: chainOf(entry.pressureRoutes),
    sessionFirst: typeof entry.sessionFirst === 'boolean' ? entry.sessionFirst : null,
  }
}

/**
 * Normalize the raw config (or a saved document) into the shape this plugin runs on.
 * @param raw - the Loader row's config, or a JSON body from the settings page.
 * @returns complete configuration with unusable entries dropped.
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const rawPurposes = liveValue(source.purposes, DEFAULTS.purposes)
  const purposes = []
  for (const candidate of Array.isArray(rawPurposes) ? rawPurposes : []) {
    const purpose = text(candidate)
    if (purpose.length === 0 || purposes.includes(purpose)) continue
    purposes.push(purpose)
  }
  const rawSwitch = liveValue(source.switchRoutes, undefined)
  const rawPressure = liveValue(source.pressureRoutes, undefined)
  const workspaces = []
  const seen = new Set()
  for (const candidate of liveValue(source.workspaces, []) ?? []) {
    const workspace = normalizeWorkspace(candidate)
    if (workspace === undefined || seen.has(workspace.key)) continue
    seen.add(workspace.key)
    workspaces.push(workspace)
  }
  // Longer keys first: the most specific workspace wins a prefix match.
  workspaces.sort((left, right) => right.key.length - left.key.length)
  return {
    enabled: liveValue(source.enabled, true) !== false,
    purposes,
    requireSession: liveValue(source.requireSession, DEFAULTS.requireSession) !== false,
    announceReroute: booleanValue(liveValue(source.announceReroute, undefined), false),
    global: {
      switchRoutes: chainOf(rawSwitch) ?? [],
      pressureRoutes: chainOf(rawPressure) ?? [],
      sessionFirst: booleanValue(liveValue(source.switchSessionFirst, undefined), DEFAULTS.sessionFirst),
    },
    workspaces,
    safetyMarginTokens: nonNegativeInteger(
      liveValue(source.safetyMarginTokens, DEFAULTS.safetyMarginTokens),
      DEFAULTS.safetyMarginTokens,
    ),
    attemptTimeoutMs: positiveInteger(
      liveValue(source.attemptTimeoutMs, DEFAULTS.attemptTimeoutMs),
      DEFAULTS.attemptTimeoutMs,
    ),
    failureBackoffMs: nonNegativeInteger(
      liveValue(source.failureBackoffMs, DEFAULTS.failureBackoffMs),
      DEFAULTS.failureBackoffMs,
    ),
  }
}

/**
 * Find the workspace override a session working directory falls under.
 * @param config - normalized configuration.
 * @param cwd - the session's working directory.
 * @returns the most specific matching entry, or `undefined`.
 */
export function workspaceFor(config, cwd) {
  const key = pathKey(cwd)
  if (key.length === 0) return undefined
  for (const workspace of config.workspaces) {
    if (workspace.enabled && within(key, workspace.key)) return workspace
  }
  return undefined
}

/**
 * Resolve one chain setting across the three scopes.
 * @returns the value and the scope name that supplied it.
 */
function pick(sessionOverride, workspace, config, field) {
  const session = sessionOverride?.[field]
  if (session !== undefined && session !== null) return { value: session, source: 'session' }
  const scoped = workspace?.[field]
  if (scoped !== undefined && scoped !== null) return { value: scoped, source: 'workspace' }
  return { value: config.global[field], source: 'global' }
}

/**
 * Normalize a per-session selection document read from the session log.
 * @param raw - the recorded selection body.
 * @returns the usable fields only, or `undefined` when nothing is set.
 */
export function normalizeSessionOverride(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const override = {}
  if (raw.switchRoutes !== undefined && raw.switchRoutes !== null) {
    override.switchRoutes = normalizeRoutes(raw.switchRoutes)
  }
  if (raw.pressureRoutes !== undefined && raw.pressureRoutes !== null) {
    override.pressureRoutes = normalizeRoutes(raw.pressureRoutes)
  }
  if (typeof raw.sessionFirst === 'boolean') override.sessionFirst = raw.sessionFirst
  return Object.keys(override).length === 0 ? undefined : override
}

/**
 * Decide which trigger a summary request belongs to.
 *
 * The summarizer does not carry the trigger, but the session does: a routed
 * header plus a newer uncommitted model selection is exactly the state
 * compaction-basic prices as a model switch.
 * @param evidence - the committed request header and the pending selection.
 * @returns `switch` only when the pending route differs from the committed one.
 */
export function classifyTrigger(evidence) {
  const header = evidence?.header
  const pending = evidence?.pending
  if (header === undefined || pending === undefined) return 'pressure'
  if (header.provider !== pending.provider || header.model !== pending.model) return 'switch'
  return 'pressure'
}

/**
 * The route the session already uses, as the first item of a switch chain.
 * @param header - the committed request header config.
 * @returns a route flagged as session-owned, or `undefined`.
 */
export function ownRoute(header) {
  if (header === undefined) return undefined
  const provider = text(header.provider)
  const model = text(header.model)
  if (provider.length === 0 || model.length === 0) return undefined
  const route = { provider, model, own: true }
  const effort = text(header.reasoningEffort)
  if (effort.length > 0) route.reasoningEffort = effort
  return route
}

/**
 * Join the session's own route and the configured routes into one attempt list.
 * @param routes - configured routes for the trigger.
 * @param first - the session-owned route to try first, when enabled.
 * @returns de-duplicated routes in attempt order.
 */
export function withOwnRoute(routes, first) {
  const chain = []
  for (const route of [...(first === undefined ? [] : [first]), ...routes]) {
    const key = `${route.provider}\u0000${route.model}`
    if (chain.some(item => `${item.provider}\u0000${item.model}` === key)) continue
    chain.push(route)
  }
  return chain
}

/**
 * Build the attempt plan for one summary request.
 * @param config - normalized configuration.
 * @param context - session working directory, trigger evidence, session override.
 * @param forced - trigger decided by evidence the session log alone cannot show.
 * @returns the chain and its scope, or `undefined` when nothing should be rerouted.
 */
export function selectChain(config, context, forced) {
  if (!config.enabled) return undefined
  const trigger = forced ?? classifyTrigger(context)
  const workspace = workspaceFor(config, context.cwd)
  const session = context.override
  const field = trigger === 'switch' ? 'switchRoutes' : 'pressureRoutes'
  const picked = pick(session, workspace, config, field)
  if (picked.value === null || picked.value === undefined) return undefined
  const configured = normalizeRoutes(picked.value)
  const sessionFirst = trigger === 'switch'
    ? pick(session, workspace, config, 'sessionFirst').value !== false
    : false
  const chain = trigger === 'switch'
    ? withOwnRoute(configured, sessionFirst ? ownRoute(context.header) : undefined)
    : configured
  if (chain.length === 0) return undefined
  return { trigger, chain, source: picked.source }
}

/**
 * Keep an explicit summary choice another layer already made.
 *
 * A backend configured with its own summarization route — the surcharge guard's
 * per-rule summary model, a preset-level override — puts that route on the
 * request itself. When it names the same provider the chain would use first, the
 * choice is preserved as the first attempt with its own reasoning effort, and the
 * configured chain stays behind it as the fallback. A different provider keeps
 * the chain in charge: cross-provider agreement cannot be assumed, and this
 * plugin's job is the guarantee that a switch still compacts.
 *
 * @param chain - the resolved chain, first route first.
 * @param requested - the provider/model/effort the caller already put on the request.
 * @param committed - the session's committed request route, or absent.
 * @returns the attempts to run, in order.
 */
export function withRequestedRoute(chain, requested, committed) {
  if (chain.length === 0 || requested === undefined) return chain
  if (committed === undefined) return chain
  // No explicit choice: the request simply carries the session's own route.
  if (requested.provider === committed.provider && requested.model === committed.model) return chain
  if (requested.provider !== chain[0].provider) return chain
  const preserved = { provider: requested.provider, model: requested.model, carryEffort: true }
  const duplicates = route => route.provider === preserved.provider
    && route.model === preserved.model
    && (route.reasoningEffort ?? '') === (requested.reasoningEffort ?? '')
  return [preserved, ...chain.filter(route => !duplicates(route))]
}

/**
 * Whether one route can physically serve this summary request.
 * @param route - candidate route.
 * @param evidence - context window, prompt size, output cap and safety margin.
 * @returns the decision, with the token arithmetic that produced it.
 */
export function fitRoute(route, evidence) {
  const contextWindow = evidence.contextWindow
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    return { fits: true, unknownWindow: true }
  }
  const promptTokens = evidence.promptTokens
  if (!Number.isSafeInteger(promptTokens) || promptTokens < 0) {
    // Without an estimate there is nothing to compare: allow the attempt and
    // let the provider decide, rather than skipping every configured route.
    return { fits: true, unknownPrompt: true }
  }
  const maxTokens = route.maxTokens ?? evidence.maxTokens ?? 0
  const required = promptTokens + maxTokens + evidence.marginTokens
  if (required <= contextWindow) return { fits: true, required, contextWindow }
  return { fits: false, required, contextWindow }
}

/** Human-readable route label used in logs and settings summaries. */
export function routeLabel(route) {
  const base = `${route.provider}/${route.model}`
  if (route.reasoningEffort !== undefined) return `${base} (${route.reasoningEffort})`
  return base
}

/**
 * Stable identity of the routing rules in effect, used to re-arm a breaker.
 * @param config - normalized configuration.
 * @returns a fingerprint that changes whenever any rule changes.
 */
export function configFingerprint(config) {
  const routes = list => (list === null ? null : normalizeRoutes(list).map(route => (
    [route.provider, route.model, route.reasoningEffort ?? '', route.maxTokens ?? '']
  )))
  return JSON.stringify({
    enabled: config.enabled,
    purposes: config.purposes,
    requireSession: config.requireSession,
    switch: [routes(config.global.switchRoutes), config.global.sessionFirst],
    pressure: routes(config.global.pressureRoutes),
    workspaces: config.workspaces.map(workspace => [
      workspace.key,
      workspace.enabled,
      routes(workspace.switchRoutes),
      routes(workspace.pressureRoutes),
      workspace.sessionFirst,
    ]),
    safetyMarginTokens: config.safetyMarginTokens,
    attemptTimeoutMs: config.attemptTimeoutMs,
  })
}

/**
 * Whether a session is still inside the cool-down of an exhausted chain.
 * @param state - the last exhaustion record for that session.
 * @param fingerprint - the routing rules in effect now.
 * @param now - current timestamp.
 * @param backoffMs - configured cool-down length.
 * @returns true when this call must fail fast instead of retrying.
 */
export function coolingDown(state, fingerprint, now, backoffMs) {
  if (state === undefined) return false
  if (state.fingerprint !== fingerprint) return false
  return now - state.at < backoffMs
}

/** One-line description of a scope for logs. */
export function scopeName(source) {
  return source === 'session' ? 'session' : source === 'workspace' ? 'workspace' : 'global'
}
