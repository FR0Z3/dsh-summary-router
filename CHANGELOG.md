# Changelog

## 0.2.0

- Rename the package to dsh-summary-router: the settings namespace, Loader row id, plugin-record type and settings titles follow. The plugin routes *summary* writes, not compaction policy, and the old name collided with that reading.
- Document installation steps, state explicitly that the plugin does not decide when compaction happens, and fix a duplicated bullet in the English README.

## 0.1.2

- Coexist with a backend that already chose a summary model (the surcharge guard's per-rule route, a preset-level setting): when the request's provider matches the chain's first route, that model runs first with its own reasoning effort and the chain backs it up; when the provider differs, the chain stays in charge. Each attempt keeps its own effort.
- Cover it on the real runtime: a configured summarization route on the shipped backend is preserved, and a cross-provider one is overridden.

## 0.1.1

- Fix the chain aborting when a summary call throws before it returns a stream (missing adapter, credential failure, a middleware throwing). Dispatch now happens inside the attempt's guard, so such a throw is one failed route instead of the end of the chain — and the attempt's idle timer no longer leaks and holds the process.
- Add `tests/installed-host.test.mjs`: against a real DSH installation it drives the shipped model-switch compaction with a provider that answers 429 and 500, asserts the fallback writes the summary and the switch is allowed, and pins the same failure blocking the switch when the router is absent.

## 0.1.0

- Add per-scope compaction routing through the `llm/stream` waterfall: `purpose: 'compaction'` calls are served by the selected route chain.
- Add the cheap chain for automatic pressure, context overflow and manual `/compact`, and the fallback chain for the compaction a model switch runs.
- Resolve routes per session (session log record, `/compact-model`), per workspace (path prefix), then globally.
- Skip a route whose context window cannot hold the replayed prefix, using the token meter and the adapter's declared window.
- Buffer each attempt so a failed route never leaks partial output, give every attempt its own idle timeout, and fail the session fast for a cool-down after a total failure.
- Write the route that actually ran back onto its request, so `compaction/summary` names the real model.
- Add the settings page (global chains, workspace list, advanced knobs), the bundle config tab, and an optional BetterSidebar tab.
- Serve a manual `/compact` from the pressure chain even while a model switch is pending, by reading its `compaction/start` transaction marker.
- Price tool schemas into the window check by their JSON density instead of a per-tool constant, and keep the estimate conservative for one-shot system text.
- Re-arm the cool-down when any routing input changes, including a route's output cap and the attempt timeout.
- Report the usage a failed attempt already burned, and say so when a session route could not be persisted instead of silently keeping it in memory.
- Declare `@deepseek-ai/dsh-session` as a peer so a linked install resolves the plugin-record writer.
- Add `announceReroute`: after a compaction whose summary ran on another model, post one attributed `notice` message, so a routed summary is visible in the transcript instead of only in host logs. It is opt-in because the line enters the model context.
- Make `/compact-model` a full self-check: enabled state, matched workspace, both chains with their source scope, the active trigger, and the committed/pending routes.
