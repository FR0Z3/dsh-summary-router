import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classifyTrigger,
  coolingDown,
  configFingerprint,
  DEFAULTS,
  fitRoute,
  normalizeConfig,
  normalizeRoute,
  normalizeRoutes,
  normalizeSessionOverride,
  ownRoute,
  pathKey,
  selectChain,
  withOwnRoute,
  withRequestedRoute,
  workspaceFor,
} from '../logic.js'

const route = (provider, model, extra = {}) => ({ provider, model, ...extra })

test('a route needs both id halves and keeps optional effort and cap', () => {
  assert.equal(normalizeRoute({ provider: '', model: 'x' }), undefined)
  assert.deepEqual(
    normalizeRoute({ provider: ' p ', model: ' m ', reasoningEffort: ' low ', maxTokens: 4096 }),
    { provider: 'p', model: 'm', reasoningEffort: 'low', maxTokens: 4096 },
  )
  // A half-written effort or cap is dropped rather than sent somewhere unintended.
  assert.deepEqual(normalizeRoute({ provider: 'p', model: 'm', reasoningEffort: '   ' }), { provider: 'p', model: 'm' })
  assert.deepEqual(normalizeRoute({ provider: 'p', model: 'm', maxTokens: -1 }), { provider: 'p', model: 'm' })
})

test('duplicate routes are dropped in configured order', () => {
  const routes = normalizeRoutes([
    route('a', 'x'),
    route('b', 'y', { reasoningEffort: 'high' }),
    route('a', 'x'),
    route('b', 'y'),
    null,
  ])
  assert.deepEqual(routes.map(item => `${item.provider}/${item.model}:${item.reasoningEffort ?? ''}`),
    ['a/x:', 'b/y:high', 'b/y:'])
})

test('config normalization reads live volatile references and fills defaults', () => {
  const config = normalizeConfig({
    enabled: { get: () => false },
    switchRoutes: [route('s', 'one')],
    switchSessionFirst: { get: () => false },
    pressureRoutes: { get: () => [route('c', 'cheap')] },
    workspaces: [
      { path: 'E:\\Misc\\Proj', switchRoutes: [route('w', 'own')], sessionFirst: true },
      { path: '   ' },
    ],
  })
  assert.equal(config.enabled, false)
  assert.equal(config.global.switchRoutes.length, 1)
  assert.equal(config.global.sessionFirst, false)
  assert.equal(config.global.pressureRoutes[0].model, 'cheap')
  assert.equal(config.workspaces.length, 1)
  assert.equal(config.purposes.join(','), 'compaction')
  assert.equal(config.safetyMarginTokens, DEFAULTS.safetyMarginTokens)
})

test('an absent chain inherits, while an explicit empty chain reroutes nothing', () => {
  assert.deepEqual(normalizeConfig({}).global.switchRoutes, [])
  const workspace = normalizeConfig({
    switchRoutes: [route('g', 'global')],
    workspaces: [{ path: 'E:\\Misc\\Proj', switchRoutes: [] }],
  }).workspaces[0]
  assert.deepEqual(workspace.switchRoutes, [], 'an explicit empty list overrides the global chain')
  const absent = normalizeConfig({ workspaces: [{ path: 'E:\\Misc\\Proj' }] }).workspaces[0]
  assert.equal(absent.switchRoutes, null, 'an absent list inherits')
})

test('the most specific workspace wins and matching is case and separator tolerant', () => {
  const config = normalizeConfig({
    workspaces: [
      { path: 'E:\\Misc' },
      { path: 'e:/misc/DSH-Plugin-Coding/' },
    ],
  })
  const match = workspaceFor(config, 'E:\\Misc\\DSH-Plugin-Coding\\dsh-summary-router')
  assert.equal(pathKey(match.path), pathKey('E:/misc/DSH-Plugin-Coding'))
  assert.equal(workspaceFor(config, 'E:\\Misc\\Other'), config.workspaces[1])
  assert.equal(workspaceFor(config, 'E:\\Miscreant'), undefined)
  assert.equal(workspaceFor(config, ''), undefined)
})

test('a switch is only a pending route that differs from the committed one', () => {
  const header = route('a', 'old')
  assert.equal(classifyTrigger({ header, pending: route('b', 'new') }), 'switch')
  assert.equal(classifyTrigger({ header, pending: header }), 'pressure')
  assert.equal(classifyTrigger({ header, pending: undefined }), 'pressure')
  assert.equal(classifyTrigger({ header: undefined, pending: header }), 'pressure')
})

test('the session route leads the switch chain and is never duplicated', () => {
  const own = ownRoute(route('a', 'old', { reasoningEffort: 'low' }))
  assert.equal(own.own, true)
  assert.equal(own.reasoningEffort, 'low')
  const chain = withOwnRoute([route('a', 'old'), route('b', 'fallback')], own)
  assert.deepEqual(chain.map(item => item.model), ['old', 'fallback'])
})

test('pressure uses the cheap chain, switch prepends the session route', () => {
  const config = normalizeConfig({
    switchRoutes: [route('safe', 'big')],
    switchSessionFirst: true,
    pressureRoutes: [route('cheap', 'small')],
  })
  const pressure = selectChain(config, { header: route('a', 'old'), pending: route('a', 'old') })
  assert.equal(pressure.trigger, 'pressure')
  assert.deepEqual(pressure.chain.map(item => item.model), ['small'])

  const switching = selectChain(config, { header: route('a', 'old'), pending: route('b', 'new') })
  assert.equal(switching.trigger, 'switch')
  assert.deepEqual(switching.chain.map(item => item.model), ['old', 'big'])

  const noOwn = selectChain(normalizeConfig({
    switchRoutes: [route('safe', 'big')],
    switchSessionFirst: false,
  }), { header: route('a', 'old'), pending: route('b', 'new') })
  assert.deepEqual(noOwn.chain.map(item => item.model), ['big'])
})

test('session overrides beat workspace overrides, which beat the global chain', () => {
  const config = normalizeConfig({
    switchRoutes: [route('g', 'global')],
    pressureRoutes: [route('g', 'global')],
    workspaces: [{ path: 'E:\\Misc\\Proj', pressureRoutes: [route('w', 'workspace')] }],
  })
  const cwd = 'E:\\Misc\\Proj\\work'
  const workspaceScope = selectChain(config, { cwd, header: undefined, pending: undefined })
  assert.equal(workspaceScope.source, 'workspace')
  assert.deepEqual(workspaceScope.chain.map(item => item.model), ['workspace'])

  const sessionScope = selectChain(config, {
    cwd,
    header: undefined,
    pending: undefined,
    override: normalizeSessionOverride({ pressureRoutes: [route('s', 'session')] }),
  })
  assert.equal(sessionScope.source, 'session')
  assert.deepEqual(sessionScope.chain.map(item => item.model), ['session'])

  const globalScope = selectChain(config, { cwd: 'E:\\Elsewhere', header: undefined, pending: undefined })
  assert.equal(globalScope.source, 'global')
  assert.deepEqual(globalScope.chain.map(item => item.model), ['global'])
})

test('an empty or disabled plan reroutes nothing', () => {
  assert.equal(selectChain(normalizeConfig({}), { header: undefined, pending: undefined }), undefined)
  const disabled = normalizeConfig({ enabled: false, pressureRoutes: [route('a', 'b')] })
  assert.equal(selectChain(disabled, { header: undefined, pending: undefined }), undefined)
})

test('a route that cannot hold the prefix is reported, not attempted', () => {
  const decision = fitRoute(route('a', 'b'), {
    contextWindow: 200000,
    promptTokens: 150000,
    maxTokens: 65536,
    marginTokens: 8192,
  })
  assert.equal(decision.fits, false)
  assert.equal(decision.required, 150000 + 65536 + 8192)
  assert.equal(decision.contextWindow, 200000)

  const roomy = fitRoute(route('a', 'b', { maxTokens: 4096 }), {
    contextWindow: 1000000,
    promptTokens: 260000,
    maxTokens: 65536,
    marginTokens: 8192,
  })
  assert.equal(roomy.fits, true)

  // An unknown window is not evidence of a fit, but blocking on it would make
  // every route unusable, so the attempt is allowed and the provider decides.
  assert.equal(fitRoute(route('a', 'b'), { contextWindow: undefined, promptTokens: 1 }).fits, true)
  // The same holds for an unavailable token estimate: skipping every route
  // because the arithmetic is unknown would silently disable the plugin.
  assert.equal(fitRoute(route('a', 'b'), { contextWindow: 200000, promptTokens: undefined }).fits, true)
  assert.equal(fitRoute(route('a', 'b'), { contextWindow: 200000, promptTokens: NaN }).fits, true)
})

test('an explicit same-provider summary choice stays first, backed by the chain', () => {
  const chain = [route('codex-plus', 'sol', { reasoningEffort: 'low' }), route('safe', 'luna')]
  const committed = route('tianxun-1', 'flash')
  const requested = route('codex-plus', 'luna', { reasoningEffort: 'high' })
  const planned = withRequestedRoute(chain, requested, committed)
  assert.deepEqual(planned.map(item => `${item.provider}/${item.model}:${item.reasoningEffort ?? ''}`),
    ['codex-plus/luna:', 'codex-plus/sol:low', 'safe/luna:'])
  assert.equal(planned[0].carryEffort, true, 'the first attempt keeps the caller effort')
})

test('a different provider leaves the configured chain in charge', () => {
  const chain = [route('router-cheap', 'r1')]
  const planned = withRequestedRoute(chain, route('guard-cheap', 'g1'), route('tianxun-1', 'flash'))
  assert.equal(planned, chain)
})

test('the session route is not an explicit choice', () => {
  const chain = [route('router-cheap', 'r1')]
  const committed = route('tianxun-1', 'flash')
  assert.equal(withRequestedRoute(chain, committed, committed), chain)
  assert.equal(withRequestedRoute(chain, committed, undefined), chain)
})

test('the same model with another effort remains a separate attempt', () => {
  const chain = [route('codex-plus', 'luna', { reasoningEffort: 'low' })]
  const planned = withRequestedRoute(chain, route('codex-plus', 'luna', { reasoningEffort: 'high' }), route('t', 'f'))
  assert.equal(planned.length, 2)
  assert.equal(planned[1].reasoningEffort, 'low')
})

test('the breaker re-arms only after the rules change', () => {
  const config = normalizeConfig({ switchRoutes: [route('a', 'b')] })
  const fingerprint = configFingerprint(config)
  assert.equal(coolingDown({ fingerprint, at: 1000 }, fingerprint, 2000, 60000), true)
  assert.equal(coolingDown({ fingerprint, at: 1000 }, fingerprint, 70000, 60000), false)
  const changed = normalizeConfig({ switchRoutes: [route('c', 'd')] })
  assert.equal(coolingDown({ fingerprint, at: 1000 }, configFingerprint(changed), 2000, 60000), false)
  // A cap change alters what the route may send, so it must re-arm too.
  const recapped = normalizeConfig({ switchRoutes: [route('a', 'b', { maxTokens: 4096 })] })
  assert.notEqual(configFingerprint(recapped), fingerprint)
  const retimed = normalizeConfig({ switchRoutes: [route('a', 'b')], attemptTimeoutMs: 90000 })
  assert.notEqual(configFingerprint(retimed), fingerprint)
})
