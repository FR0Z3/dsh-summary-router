/**
 * Browser half of the summary router: the settings page and the optional
 * BetterSidebar tab. Both render the same panel, so a profile without the third
 * party sidebar still gets a full editor under Plugins → Summary router.
 *
 * The bundle is a browser artifact: it registers itself through the module
 * loader and has no `export` statements of its own.
 */
window.__ModuleLoader__.load({
  id: 'dsh-summary-router',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-summary-router'
    const NAMESPACES = [`include:${NS}`, NS]

    /** Strings duplicated verbatim into `locale/<lang>.json`; check-locale keeps them in step. */
    const zh = {
      "intro": "压缩摘要请求会单独路由到你选的模型。会话 > 工作区 > 全局，逐级覆盖。",
      "enabled": "启用摘要路由",
      "enabledHint": "关闭后所有压缩都恢复使用会话自己的模型。",
      "pressureTitle": "省钱链（自动压缩、上下文溢出、手动 /compact）",
      "pressureHint": "按顺序尝试；失败的路线会被跳过，成功的摘要交给主对话模型。",
      "pressureEmpty": "还没有路线；这条链为空时不改路由。",
      "switchTitle": "兜底链（换模型时的那次压缩）",
      "switchHint": "换模型时 DSH 先用会话原模型写摘要，失败后才用这里配置的路线。",
      "switchEmpty": "还没有兜底路线；原模型失败时换模型仍会被拒绝。",
      "sessionFirst": "先尝试会话自己的模型",
      "sessionFirstHint": "关掉后换模型时直接使用兜底路线，不再碰原模型。",
      "addRoute": "添加路线",
      "removeRoute": "移除",
      "provider": "服务商",
      "model": "模型",
      "effort": "推理等级",
      "effortPlaceholder": "留空用该模型默认",
      "workspaceTitle": "工作区覆盖",
      "workspaceHint": "路径按前缀匹配；最具体的工作区胜出。留空路线表示继承全局链。",
      "workspaceAdd": "添加工作区",
      "workspacePath": "工作区路径",
      "workspaceEnabled": "启用",
      "workspaceEmpty": "还没有工作区覆盖。",
      "workspaceInherit": "继承全局链",
      "workspaceInheritHint": "这个工作区沿用全局的两条链。",
      "workspaceOwnHint": "这个工作区使用下面的链，覆盖全局。",
      "workspaceRemove": "移除这个工作区",
      "advancedTitle": "高级",
      "safetyMargin": "窗口安全余量（token）",
      "safetyMarginHint": "前缀 + 输出上限 + 余量超过路线窗口时跳过该路线。",
      "timeout": "单次尝试超时（毫秒）",
      "timeoutHint": "上游迟迟不返回时，超时即换下一条路线。",
      "backoff": "全失败后的冷却（毫秒）",
      "backoffHint": "冷却期内同一会话直接失败，避免每个 step 反复重试；改动配置立即解除。",
      "announce": "在会话里提示改路由",
      "announceHint": "摘要改由别的模型写时，在会话里留一行提示（这一行会进入模型上下文）。",
      "purposes": "匹配的辅助调用类别",
      "purposesHint": "逗号分隔；摘要调用固定是 compaction。",
      "commandTitle": "会话内命令",
      "commandHint": "/compact-model 查看当前路线；/compact-model provider/model [等级] 只在当前会话固定一条路线；/compact-model off 清除。",
      "sidebarTitle": "摘要路由",
      "sidebarHint": "查看和修改压缩摘要使用哪些模型。",
      "saveFailed": "保存失败",
      "notWritable": "当前配置不可写。",
      "openSettings": "打开插件设置"
    }
    const en = {
      "intro": "Compaction summary requests are routed to the models you choose. Session, then workspace, then global: the closest scope wins.",
      "enabled": "Enable compaction routing",
      "enabledHint": "When off, every compaction uses the session's own model again.",
      "pressureTitle": "Cheap chain (automatic pressure, overflow, manual /compact)",
      "pressureHint": "Routes are tried in order; a failed one is skipped and the summary goes to the chat model.",
      "pressureEmpty": "No route yet; an empty chain leaves routing untouched.",
      "switchTitle": "Fallback chain (the compaction a model switch runs)",
      "switchHint": "On a switch DSH first summarizes with the session's own model, then falls back to these routes.",
      "switchEmpty": "No fallback route yet; a failing switch is still refused.",
      "sessionFirst": "Try the session's own model first",
      "sessionFirstHint": "Off routes a switch straight to the fallback chain.",
      "addRoute": "Add route",
      "removeRoute": "Remove",
      "provider": "Provider",
      "model": "Model",
      "effort": "Reasoning effort",
      "effortPlaceholder": "Empty uses the model default",
      "workspaceTitle": "Workspace overrides",
      "workspaceHint": "Paths match by prefix; the most specific workspace wins. An empty route list inherits the global chain.",
      "workspaceAdd": "Add workspace",
      "workspacePath": "Workspace path",
      "workspaceEnabled": "Enabled",
      "workspaceEmpty": "No workspace override yet.",
      "workspaceInherit": "Inherit the global chain",
      "workspaceInheritHint": "This workspace uses the global chains.",
      "workspaceOwnHint": "This workspace uses the chains below instead.",
      "workspaceRemove": "Remove this workspace",
      "advancedTitle": "Advanced",
      "safetyMargin": "Window safety margin (tokens)",
      "safetyMarginHint": "A route is skipped when prefix + output cap + margin exceed its window.",
      "timeout": "Attempt timeout (ms)",
      "timeoutHint": "When the upstream stays silent this long, the next route is tried.",
      "backoff": "Cool-down after total failure (ms)",
      "backoffHint": "Within the cool-down the same session fails fast; changing the rules clears it.",
      "announce": "Announce rerouted summaries",
      "announceHint": "Post one notice line when another model writes the summary. The line enters the model context.",
      "purposes": "Auxiliary call purposes",
      "purposesHint": "Comma separated; the summarizer's purpose is compaction.",
      "commandTitle": "Session command",
      "commandHint": "/compact-model shows the routes; /compact-model provider/model [effort] pins one route for this session; /compact-model off clears it.",
      "sidebarTitle": "Summary router",
      "sidebarHint": "See and change the models compaction summaries use.",
      "saveFailed": "Save failed",
      "notWritable": "This configuration is not writable.",
      "openSettings": "Open plugin settings"
    }

    const styles = {
      panel: { display: 'flex', flexDirection: 'column', gap: '18px', padding: '4px 0' },
      section: { display: 'flex', flexDirection: 'column', gap: '10px' },
      title: { fontWeight: 600, fontSize: '13px' },
      hint: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: 1.5 },
      row: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr)', gap: '10px', alignItems: 'center' },
      route: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) 120px 32px', gap: '8px', alignItems: 'center' },
      field: {
        width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)', fontSize: '12px',
      },
      button: {
        padding: '5px 10px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
        fontSize: '12px', cursor: 'pointer',
      },
      iconButton: {
        padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent', color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', cursor: 'pointer',
      },
      list: { display: 'flex', flexDirection: 'column', gap: '8px' },
      card: {
        display: 'flex', flexDirection: 'column', gap: '10px', padding: '10px 12px',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px',
      },
      pathRow: { display: 'flex', gap: '8px', alignItems: 'center' },
      switchRow: { display: 'flex', gap: '8px', alignItems: 'center' },
      notice: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' },
      saved: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
    }

    function getOptional(ctx, key) {
      try { return ctx.get(key) } catch { return undefined }
    }

    /** Stable identities so an absent form cannot spin `useSyncExternalStore`. */
    const EMPTY_SNAPSHOT = { status: 'unavailable', writable: false }
    const NO_SUBSCRIBE = () => () => {}

    function useStore(store) {
      const subscribe = React.useCallback(listener => (store ? store.subscribe(listener) : NO_SUBSCRIBE()), [store])
      const snapshot = React.useCallback(() => (store ? store.getSnapshot() : EMPTY_SNAPSHOT), [store])
      return React.useSyncExternalStore(subscribe, snapshot)
    }

    /** Read the live config form, preferring the older `ready` namespace. */
    function useConfig(ctx, pageForm) {
      const forms = getOptional(ctx, 'configForms')
      const first = forms?.get?.(NAMESPACES[0])
      const second = forms?.get?.(NAMESPACES[1])
      const firstSnapshot = useStore(first)
      const secondSnapshot = useStore(second)
      const useFirst = firstSnapshot.status === 'ready'
        || (firstSnapshot.status === 'loading' && secondSnapshot.status !== 'ready')
      const store = useFirst ? first : second
      // A page that owns the form (`plugins.bundle.config`) supplies its own
      // read/write fence; using it keeps both halves on one revision queue.
      const snapshot = pageForm?.state ?? (useFirst ? firstSnapshot : secondSnapshot)
      return {
        target: pageForm ?? store,
        snapshot,
        value: snapshot.value ?? {},
        writable: snapshot.writable === true,
      }
    }

    /** A text field that commits on blur, so no keystroke writes the profile. */
    function Field({ value, placeholder, ariaLabel, disabled, onCommit, style }) {
      const [draft, setDraft] = React.useState(String(value ?? ''))
      React.useEffect(() => { setDraft(String(value ?? '')) }, [value])
      return h('input', {
        style: style ?? styles.field,
        value: draft,
        disabled,
        placeholder,
        'aria-label': ariaLabel,
        onChange: event => setDraft(event.target.value),
        onBlur: () => { if (draft !== String(value ?? '')) onCommit(draft) },
      })
    }

    function Route({ t, route, index, disabled, onChange, onRemove }) {
      const set = patch => onChange({ ...route, ...patch })
      return h('div', { style: styles.route },
        h(Field, {
          value: route.provider ?? '',
          placeholder: t('provider'),
          ariaLabel: `${t('provider')} ${index + 1}`,
          disabled,
          onCommit: provider => set({ provider }),
        }),
        h(Field, {
          value: route.model ?? '',
          placeholder: t('model'),
          ariaLabel: `${t('model')} ${index + 1}`,
          disabled,
          onCommit: model => set({ model }),
        }),
        h(Field, {
          value: route.reasoningEffort ?? '',
          placeholder: t('effortPlaceholder'),
          ariaLabel: `${t('effort')} ${index + 1}`,
          disabled,
          onCommit: reasoningEffort => set({ reasoningEffort }),
        }),
        h('button', {
          style: styles.iconButton,
          type: 'button',
          disabled,
          title: t('removeRoute'),
          'aria-label': `${t('removeRoute')} ${index + 1}`,
          onClick: onRemove,
        }, '✕'),
      )
    }

    function RouteList({ t, routes, disabled, onChange }) {
      const list = Array.isArray(routes) ? routes : []
      return h('div', { style: styles.list },
        list.length === 0 ? null : list.map((route, index) => h(Route, {
          key: index,
          t,
          route,
          index,
          disabled,
          onChange: next => onChange(list.map((item, at) => (at === index ? next : item))),
          onRemove: () => onChange(list.filter((_, at) => at !== index)),
        })),
        h('div', null, h('button', {
          style: styles.button,
          type: 'button',
          disabled,
          onClick: () => onChange([...list, { provider: '', model: '' }]),
        }, t('addRoute'))),
      )
    }

    function Toggle({ label, hint, checked, onChange, disabled }) {
      return h('div', { style: styles.section },
        h('div', { style: styles.switchRow },
          h('button', {
            role: 'switch',
            type: 'button',
            'aria-checked': checked,
            'aria-label': label,
            disabled,
            onClick: () => onChange(!checked),
            style: { ...styles.button, opacity: checked ? 1 : 0.7 },
          }, checked ? '●' : '○'),
          h('span', { style: styles.title }, label),
        ),
        hint === undefined ? null : h('div', { style: styles.hint }, hint),
      )
    }

    function NumberField({ t, label, hint, value, onCommit, disabled }) {
      const [draft, setDraft] = React.useState(String(value ?? ''))
      React.useEffect(() => { setDraft(String(value ?? '')) }, [value])
      return h('div', { style: styles.section },
        h('div', { style: styles.row },
          h('span', { style: styles.title }, label),
          h('input', {
            style: styles.field,
            inputMode: 'numeric',
            value: draft,
            disabled,
            'aria-label': label,
            onChange: event => setDraft(event.target.value),
            onBlur: () => {
              const parsed = Math.trunc(Number(draft))
              if (!Number.isSafeInteger(parsed) || parsed < 0) { setDraft(String(value ?? '')); return }
              if (parsed !== value) onCommit(parsed)
            },
          }),
        ),
        hint === undefined ? null : h('div', { style: styles.hint }, hint),
      )
    }

    function TextField({ t, label, hint, value, onCommit, disabled }) {
      const [draft, setDraft] = React.useState(String(value ?? ''))
      React.useEffect(() => { setDraft(String(value ?? '')) }, [value])
      return h('div', { style: styles.section },
        h('div', { style: styles.row },
          h('span', { style: styles.title }, label),
          h('input', {
            style: styles.field,
            value: draft,
            disabled,
            'aria-label': label,
            onChange: event => setDraft(event.target.value),
            onBlur: () => { if (draft !== String(value ?? '')) onCommit(draft) },
          }),
        ),
        hint === undefined ? null : h('div', { style: styles.hint }, hint),
      )
    }

    function WorkspaceEntry({ t, entry, index, disabled, onChange, onRemove }) {
      // `null` on both lists means "inherit the global chains"; an array (even
      // an empty one) means this workspace decides for itself.
      const inherit = entry.switchRoutes === null || entry.switchRoutes === undefined
      const enabled = entry.enabled !== false
      return h('div', { style: styles.card },
        h('div', { style: styles.pathRow },
          h(Field, {
            value: entry.path ?? '',
            placeholder: t('workspacePath'),
            ariaLabel: `${t('workspacePath')} ${index + 1}`,
            disabled,
            style: { ...styles.field, flex: 1 },
            onCommit: path => onChange({ ...entry, path }),
          }),
          h('button', {
            style: styles.iconButton,
            type: 'button',
            disabled,
            title: t('workspaceRemove'),
            'aria-label': `${t('workspaceRemove')} ${index + 1}`,
            onClick: onRemove,
          }, '✕'),
        ),
        h(Toggle, {
          label: t('workspaceEnabled'),
          checked: enabled,
          disabled,
          onChange: value => onChange({ ...entry, enabled: value }),
        }),
        h(Toggle, {
          label: t('workspaceInherit'),
          hint: inherit ? t('workspaceInheritHint') : t('workspaceOwnHint'),
          checked: inherit,
          disabled,
          onChange: value => onChange({
            ...entry,
            switchRoutes: value ? null : (Array.isArray(entry.switchRoutes) ? entry.switchRoutes : []),
            pressureRoutes: value ? null : (Array.isArray(entry.pressureRoutes) ? entry.pressureRoutes : []),
          }),
        }),
        inherit ? null : h('div', { style: styles.list },
          h('span', { style: styles.title }, t('pressureTitle')),
          h(RouteList, {
            t, disabled, routes: entry.pressureRoutes,
            onChange: next => onChange({ ...entry, pressureRoutes: next }),
          }),
          h('span', { style: styles.title }, t('switchTitle')),
          h(RouteList, {
            t, disabled, routes: entry.switchRoutes,
            onChange: next => onChange({ ...entry, switchRoutes: next }),
          }),
        ),
      )
    }

    function Panel({ t, ctx, compact, form }) {
      const config = useConfig(ctx, form)
      const [notice, setNotice] = React.useState('')
      const value = config.value ?? {}
      const writable = config.writable
      const set = async (path, next) => {
        if (!writable) { setNotice(t('notWritable')); return false }
        try {
          const ops = [{ op: 'set', path, value: next }]
          // The bundle page owns its own revision fence; a bare config form
          // needs the revision this render read.
          const accepted = form === undefined
            ? await config.target.mutate(ops, config.snapshot.revision)
            : await config.target.mutate(ops)
          setNotice(accepted ? '' : t('saveFailed'))
          return accepted
        } catch (error) {
          setNotice(`${t('saveFailed')}: ${error?.message ?? error}`)
          return false
        }
      }
      const disabled = !writable
      const workspaces = Array.isArray(value.workspaces) ? value.workspaces : []
      const pressureRoutes = Array.isArray(value.pressureRoutes) ? value.pressureRoutes : []
      const switchRoutes = Array.isArray(value.switchRoutes) ? value.switchRoutes : []
      const setWorkspace = (index, next) => set(['workspaces'],
        workspaces.map((entry, at) => (at === index ? next : entry)))

      return h('div', { style: styles.panel },
        notice.length === 0 ? null : h('div', { style: styles.notice, role: 'alert' }, notice),
        h('div', { style: styles.hint }, t('intro')),
        h(Toggle, {
          label: t('enabled'), hint: t('enabledHint'),
          checked: value.enabled !== false, disabled,
          onChange: checked => set(['enabled'], checked),
        }),
        h('div', { style: styles.section },
          h('div', { style: styles.title }, t('pressureTitle')),
          h('div', { style: styles.hint }, t('pressureHint')),
          pressureRoutes.length === 0 ? h('div', { style: styles.hint }, t('pressureEmpty')) : null,
          h(RouteList, {
            t, disabled,
            routes: pressureRoutes,
            onChange: next => set(['pressureRoutes'], next),
          }),
        ),
        h('div', { style: styles.section },
          h('div', { style: styles.title }, t('switchTitle')),
          h('div', { style: styles.hint }, t('switchHint')),
          switchRoutes.length === 0 ? h('div', { style: styles.hint }, t('switchEmpty')) : null,
          h(Toggle, {
            label: t('sessionFirst'), hint: t('sessionFirstHint'),
            checked: value.switchSessionFirst !== false, disabled,
            onChange: checked => set(['switchSessionFirst'], checked),
          }),
          h(RouteList, {
            t, disabled,
            routes: switchRoutes,
            onChange: next => set(['switchRoutes'], next),
          }),
        ),
        compact ? null : h('div', { style: styles.section },
          h('div', { style: styles.title }, t('workspaceTitle')),
          h('div', { style: styles.hint }, t('workspaceHint')),
          workspaces.length === 0 ? h('div', { style: styles.hint }, t('workspaceEmpty')) : null,
          workspaces.map((entry, index) => h(WorkspaceEntry, {
            key: index,
            t, entry, index, disabled,
            onChange: next => setWorkspace(index, next),
            onRemove: () => set(['workspaces'], workspaces.filter((_, at) => at !== index)),
          })),
          h('button', {
            style: styles.button, type: 'button', disabled,
            onClick: () => set(['workspaces'], [...workspaces, {
              path: '', enabled: true, switchRoutes: null, pressureRoutes: null,
            }]),
          }, t('workspaceAdd')),
        ),
        compact ? null : h('div', { style: styles.section },
          h('div', { style: styles.title }, t('advancedTitle')),
          h(NumberField, {
            t, disabled, label: t('safetyMargin'), hint: t('safetyMarginHint'),
            value: value.safetyMarginTokens,
            onCommit: next => set(['safetyMarginTokens'], next),
          }),
          h(NumberField, {
            t, disabled, label: t('timeout'), hint: t('timeoutHint'),
            value: value.attemptTimeoutMs,
            onCommit: next => set(['attemptTimeoutMs'], next),
          }),
          h(NumberField, {
            t, disabled, label: t('backoff'), hint: t('backoffHint'),
            value: value.failureBackoffMs,
            onCommit: next => set(['failureBackoffMs'], next),
          }),
          h(TextField, {
            t, disabled, label: t('purposes'), hint: t('purposesHint'),
            value: Array.isArray(value.purposes) ? value.purposes.join(', ') : '',
            onCommit: next => set(['purposes'], next.split(',').map(item => item.trim()).filter(Boolean)),
          }),
          h(Toggle, {
            label: t('announce'), hint: t('announceHint'),
            checked: value.announceReroute === true, disabled,
            onChange: checked => set(['announceReroute'], checked),
          }),
        ),
        compact ? null : h('div', { style: styles.section },
          h('div', { style: styles.title }, t('commandTitle')),
          h('div', { style: styles.hint }, t('commandHint')),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${NS}: dictionaries`)
        const t = ctx.locale.bind(NS)

        // Its own page in Settings, next to the other feature sections.
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: NS,
          order: 200,
          label: () => t('sidebarTitle'),
          locale: NS,
        }, () => h(Panel, { t, ctx })))

        // The Plugins page shows the same panel on the bundle's own config tab.
        // That page owns its form fence, so the panel writes through it.
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: NS,
          locale: NS,
        }, props => h(Panel, { t, ctx, form: props?.form })))

        // BetterSidebar is third-party and optional: register only when present.
        ctx.inject(['betterSidebar'], side => {
          side.effect(() => side.betterSidebar.registerTab({
            id: `${NS}:panel`,
            title: () => t('sidebarTitle'),
            description: () => t('sidebarHint'),
            order: 90,
            single: true,
            component: ({ ctx: panelCtx }) => h(Panel, {
              t, ctx: panelCtx ?? ctx, compact: true,
            }),
          }), `${NS}: sidebar tab`)
        })
      },
    }
  },
})
