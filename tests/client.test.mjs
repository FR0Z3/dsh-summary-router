import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const React = require('react')
const { act, create } = require('react-test-renderer')

const NS = 'dsh-summary-router'

// The bundle registers itself through the module loader, and an ES module is
// evaluated once: capture its factory here and reuse it for every test.
let factory
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory: load }) {
      assert.equal(id, NS)
      factory = load
    },
  },
}
await import('../client.js')

/** Render the registered settings panel and return the renderer. */
async function mountClient(value = {}, { writable = true } = {}) {
  const writes = []
  const snapshot = { status: 'ready', writable, revision: 7, value }
  const store = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    mutate: async (ops, revision) => { writes.push({ ops, revision }); return true },
  }
  const registrations = []
  const mod = factory(name => {
    assert.equal(name, 'react')
    return React
  })
  const ctx = {
    effect: run => run(),
    locale: {
      register() {},
      bind: () => key => key,
    },
    slots: {
      inject(name, run) {
        assert.ok(['settings.section', 'plugins.bundle.config'].includes(name))
        run()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
    get: key => (key === 'configForms'
      ? { get: id => (id === `include:${NS}` || id === NS ? store : undefined) }
      : undefined),
    // BetterSidebar is third-party and absent in this profile.
    inject() {},
  }
  mod.apply(ctx)
  const section = registrations.find(entry => entry.options.name === 'settings.section')
  assert.ok(section, 'a settings section is registered')
  assert.equal(section.options.id, NS)
  const bundle = registrations.find(entry => entry.options.name === 'plugins.bundle.config')
  assert.ok(bundle, 'the bundle config tab is registered')
  assert.equal(bundle.options.key, NS)

  let root
  await act(async () => {
    root = create(React.createElement(section.component, { view: 'page' }))
  })
  return { root, writes }
}

const textOf = root => JSON.stringify(root.toJSON())

test('the panel renders both chains', async () => {
  const { root } = await mountClient({
    enabled: true,
    pressureRoutes: [{ provider: 'cheap', model: 'small' }],
    switchRoutes: [{ provider: 'safe', model: 'big' }],
    switchSessionFirst: true,
    workspaces: [],
    safetyMarginTokens: 8192,
    attemptTimeoutMs: 120000,
    failureBackoffMs: 60000,
    purposes: ['compaction'],
  })
  const text = textOf(root)
  assert.ok(text.includes('cheap'), 'the pressure route is rendered')
  assert.ok(text.includes('big'), 'the fallback route is rendered')
  const switches = root.root.findAll(node => node.props && node.props.role === 'switch')
  assert.ok(switches.length >= 2, 'toggles are rendered as switches')
})

test('the panel adds a route through a mutated array', async () => {
  const { root, writes } = await mountClient({
    enabled: true,
    pressureRoutes: [],
    switchRoutes: [],
    workspaces: [],
  })
  const add = root.root.findAll(node => node.type === 'button' && node.children.join('').includes('addRoute'))
  assert.ok(add.length >= 1, 'the add button is rendered')
  await act(async () => { add[0].props.onClick() })
  assert.equal(writes.length, 1)
  const op = writes[0].ops[0]
  assert.deepEqual(op.path, ['pressureRoutes'])
  assert.deepEqual(op.value, [{ provider: '', model: '' }])
  assert.equal(writes[0].revision, 7, 'the write carries the revision it read')
})

test('a toggle writes its own flat path', async () => {
  const { root, writes } = await mountClient({ enabled: true, pressureRoutes: [], switchRoutes: [] })
  const switches = root.root.findAll(node => node.props && node.props.role === 'switch')
  await act(async () => { switches[0].props.onClick() })
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].ops[0], { op: 'set', path: ['enabled'], value: false })
})

test('a workspace row labels both switches instead of showing bare glyphs', async () => {
  const { root, writes } = await mountClient({
    enabled: true,
    pressureRoutes: [],
    switchRoutes: [],
    workspaces: [{ path: 'E:\\Misc\\Proj', enabled: true, switchRoutes: [], pressureRoutes: [] }],
  })
  const switches = root.root.findAll(node => node.props && node.props.role === 'switch')
  const labels = switches.map(node => node.props['aria-label'])
  assert.ok(labels.includes('workspaceEnabled'), 'the enable switch is labeled')
  assert.ok(labels.includes('workspaceInherit'), 'the inherit switch is labeled')
  assert.ok(labels.includes('enabled') && labels.includes('sessionFirst'), 'the global switches keep their labels')

  // Turning inheritance on clears this workspace's own chains.
  const inheritSwitch = switches.find(node => node.props['aria-label'] === 'workspaceInherit')
  await act(async () => { inheritSwitch.props.onClick() })
  assert.equal(writes.length, 1)
  const workspace = writes[0].ops[0].value[0]
  assert.equal(workspace.switchRoutes, null)
  assert.equal(workspace.pressureRoutes, null)
})

test('a disabled form refuses to write', async () => {
  const { root, writes } = await mountClient(
    { enabled: true, pressureRoutes: [], switchRoutes: [] },
    { writable: false },
  )
  const switches = root.root.findAll(node => node.props && node.props.role === 'switch')
  await act(async () => { switches[0].props.onClick() })
  assert.equal(writes.length, 0)
})
