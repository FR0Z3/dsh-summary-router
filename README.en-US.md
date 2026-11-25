[中文](README.md)

# dsh-summary-router

Choose the model that writes DeepSeek Harness compaction summaries: the compaction a model switch runs, automatic pressure compaction, context-overflow recovery, and the manual `/compact` command. Session, workspace, and global scopes, with fallback chains.

## Why

DSH writes compaction summaries with the session's routed model. At a model switch that is exactly the problem:

- the switch is priced against the **new** model's window, but the summary request still goes to the **old** model;
- when the old route returns 429 or nothing within the upstream's 30s first-token limit, compaction fails and the switch is refused (`MODEL_SWITCH_COMPACTION_FAILED`); the pending selection stays queued, so every step retries and fails again;
- DSH's own `summarizationProvider`/`summarizationModel` fields solve this, but no shipped preset sets them and no UI exposes them.

## How it works

1. It hooks `llm/stream`, the waterfall every model call passes through, and takes only calls with `purpose === 'compaction'` that carry a `sessionId`.
2. It reads the session log: a committed request route that differs from the pending model selection means a **switch** compaction. A manual `/compact` opens its own transaction marker (`compaction/start` with a command id) and always uses the automatic chain, so selecting a new model without sending a message cannot misclassify it.
3. Routes are tried in order. Each one is checked against its own context window (messages + tool schemas + output cap + safety margin) and skipped when it cannot hold the request; each attempt has its own idle timeout.
4. The first successful summary is handed back unchanged. Failed routes only log a warning with the usage they already burned.
5. When every route fails, the call fails loudly (the message appears inside DSH's own compaction failure) and the session fails fast for the configured cool-down, so repeated steps do not spend money again; any configuration change re-arms it immediately.

## What it does not do

It does not decide **when** compaction happens, change any threshold, or act as a billing guard. Those belong to a compaction-policy plugin (for example surcharge-guard); this one only decides which provider and model write the summary, and what to try when they fail.

## Install

Install `github:FR0Z3/dsh-summary-router` from the DSH plugins page (or point a `link:` spec at a local checkout while developing), enable it, then open **Plugins → Summary router**. Refresh the page once after enabling so the client bundle loads.

## Usage

Under **Plugins → Summary router**:

| Goal | Action |
|---|---|
| Cheap model for automatic compaction | add a route to the "cheap chain" |
| Stop model switches from being blocked | add a reliable route to the "fallback chain"; keep "try the session's own model first" on |
| Per-workspace routing | add a workspace path with its own routes; an empty list inherits the global chain |
| Per-session routing | run `/compact-model provider/model [effort]` in the session |
| See when routing fires | turn on "Announce rerouted summaries"; each summary written by another model leaves one line in the session |

An empty chain means the trigger is not rerouted at all, exactly as if the plugin were absent.

> **Per-session overrides have no UI**: DSH's settings page is profile-scoped and cannot tell which session it is editing, so the page owns only the global and workspace layers. A single session's route is set **only through the command below** (it is written to that session's log and survives resume).

### Session command

- `/compact-model` self-checks: `enabled`, the matched `workspace`, both chains with their source and order, the `active` trigger this call would use, plus `session route` (committed) and `pending route` (pending switch).
- `/compact-model provider/model [effort]` pins one route for this session (both chains, and it skips the "own model first" step). It is written to the session log as a `plugin:` record, so it survives resume.
  - It pre-checks before pinning: the route must resolve (`resolveModelInfo`), a chosen effort must be servable on that model (`resolveCallConfig`), and if the current history no longer fits the route's window it says so ("will be skipped").
  - More than one effort token is a usage error instead of being silently ignored.
- `/compact-model off` clears the session override and returns to the global/workspace chains (case-insensitive).
- If the log write fails, the success reply says "not persisted" instead of pretending.

### BetterSidebar

When `dsh-better-sidebar` is installed the plugin registers a "Summary router" tab (start page card, bottom `+` menu, and the native right pane). Without it the plugin simply shows up in DSH settings.

## Coexistence with surcharge-guard

Both plugins can stay enabled. The rule is decided by the route on the summary request itself:

- **Request route ≠ the session's committed route** → an upstream layer (the guard's per-rule summary model, a preset-level summary setting) already chose a model.
  - **Same provider as the chain's first route**: its model runs first with its own reasoning effort, and our chain backs it up; later attempts keep their own efforts.
  - **Different provider**: our chain stays in charge. Cross-provider agreement cannot be assumed, and an unblocked model switch is what this plugin exists for.
- **Request route = the session's committed route** → no upstream choice; the chains apply normally.

`switchSessionFirst: true` makes the switch chain start at the session's own route, so a guard target on another provider falls into the "different provider" case above and is overridden.

## Limits

- **Not a billing cap**: every attempt in a fallback chain is a real provider call. Longer chains cost more in the worst case.
- A route's `maxTokens` only affects that call and the window arithmetic; DSH's `compaction/summary` record keeps the backend's own cap, and the plugin logs the cap it actually sent.
- A summary call replays the whole conversation prefix, so the chosen model must hold prefix + output cap + safety margin. Small cheaper models only work while the history is small; a route that cannot hold the request is skipped and the numbers are logged.
- The plugin cannot fix an upstream gateway's own first-token limit; it switches to a route that does work.
- The session override is written to the session log, and the successful route is written back onto the request, so `compaction/summary` names the model that actually wrote the summary.
- The line posted by "Announce rerouted summaries" enters the model context and is billed like any other line; it is off by default.
- Subagent sessions carry their own `sessionId` and are routed too; restrict them per workspace if that is unwanted.
- Only tagged auxiliary calls are intercepted. A third-party compaction backend that builds its own call without the `compaction` purpose needs its purpose added to "Auxiliary call purposes".

## Development

```sh
pnpm install
pnpm check
```

Real-runtime check, using an installed DSH to drive the shipped model-switch compaction:

```sh
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" --test tests/installed-host.test.mjs
```

## License

[MIT](LICENSE)
