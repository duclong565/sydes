# UI Brick 3 — Run/Teardown UX + Warmup + Logs Tab (Design)

Date: 2026-06-23 · Branch: `feat/ui-run` (off `feat/ui-canvas`) · Base: `f86d54e`

## Context

UI brick 2 (PR #14) gave the `web/` SPA a React Flow canvas + Zustand store +
`toGraph()` + the brick-1 wiring (Preview/Run/Stop, status polling) + a
collapsible tabbed Drawer (Compose | Status). This is **brick 3 of 4**: turn the
raw run controls into a real experiment-running UX — a warmup/run-state badge, a
dismissible error banner, a live **Logs** drawer tab, and the run-control polish
deferred from bricks 1–2.

**Epic position:** 1 = agent + minimal SPA (done). 2 = canvas → graph JSON
(done, PR #14). **3 = run/teardown UX + warmup + Logs (this brick).** 4 = live
metric badges over WebSocket (Metrics tab).

**Branch dependency:** stacks on `feat/ui-canvas` (#14) — it modifies brick-2's
`App.tsx`, `Drawer.tsx`, `api.ts`. Cut from `feat/ui-canvas`; rebase onto `main`
once #14 merges. (A reviewed static mockup is at gitignored
`docs/_local/ui-brick3-mockup.html`.)

## Locked decisions

- **Logs delivery:** HTTP poll. Agent adds `GET /api/logs/:runId`; the Logs tab
  polls it (2s) while open — consistent with status polling, no WebSocket this
  brick (WS arrives in brick 4 for metrics).
- **Warmup:** simple state-based. Map the agent's existing run state — no new
  backend sub-phases.
- **Error UX:** a dismissible red banner under the top bar (visible even when the
  drawer is collapsed).

## Agent (backend)

1. **`ExperimentController.logs(id: string): Promise<string>`** (`src/engine/controller.ts`)
   — runs `docker compose -p sds-<id> -f <runDir>/compose.yml logs --tail 200` via
   the injected `Runner` (mirrors `status`/`down` using `baseArgs(id)`); returns
   `RunResult.stdout` (empty string tolerated). Engine addition.
2. **`GET /api/logs/:runId`** (`src/agent/server.ts`) — `404 { error }` for an
   unknown run; otherwise `200 { runId, lines: string }` where `lines` is
   `controller.logs(runId)`.

## SPA (`web/`)

3. **`api.ts`**
   - Add `logs(runId): Promise<{ runId: string; lines: string }>`.
   - Make `jsonFetch` surface failures: if `fetch` rejects (network) it throws as
     today; additionally, if `!res.ok` AND the body is not JSON, throw
     `Error('HTTP <status>')`. Compile/run `400` responses ARE JSON
     (`{ ok: false, errors }`) and are returned normally so callers can show the
     errors. (Folds the deferred `res.ok` minor without breaking the 400 path.)

4. **`Drawer.tsx`** — promote **Logs** from stub to a real tab.
   `type DrawerTab = 'compose' | 'status' | 'logs'`. New prop `logs: string`. The
   Logs pane renders `logs` in a `<pre>` (with a hint when empty). Metrics stays an
   inert stub (brick 4).

5. **`RunBadge.tsx`** (small new component) — given a `state`
   (`'starting' | 'running' | 'error' | 'stopped' | null`) and optional `error`,
   renders the top-bar badge: `starting → "⏳ Warming up… (~10-30s)"` (spinner),
   `running → "● Running"`, `error → "✕ <message>"`, `stopped → "○ Stopped"`,
   `null → nothing`. Pure presentational.

6. **`App.tsx`** (integration):
   - **Run-state badge** in the top bar fed by the latest `status?.state` (and
     `compile/run` errors set state context).
   - **Dismissible error banner** under the top bar: an `error: string | null`
     state, set from compile/run `400` bodies, `status.error`, and caught
     exceptions; a `[dismiss]` button clears it. Rendered only when non-null.
   - **Button logic:** `Run` disabled while state is `starting` (warming up);
     `Stop` enabled only while state is `starting | running`.
   - **Stop** clears `runId` (halting polling — folds the deferred `onStop`
     minor) and sets a local `stopped` status snapshot.
   - **Status polling** rewritten as a self-cancelling recursive `setTimeout`
     (~2s): re-arms only while state is `starting | running`; **stops on terminal
     state** (`error | stopped`) and on unmount (an `active` flag guards late
     resolves). On `error` it also populates the banner.
   - **Logs polling:** while the Logs drawer tab is open AND a run exists, poll
     `api.logs(runId)` (~2s) into the Drawer's `logs` prop; stop when the tab
     closes / drawer collapses / run clears.

## Data flow

`Run → POST /api/run (202) → recursive status poll`: badge shows
`starting → running`; the Logs tab (when open) polls `GET /api/logs`. Errors —
compile/run `400` bodies, `status.error`, thrown exceptions — populate the banner.
`Stop → POST /api/stop → stopped`, `runId` cleared, polling halts.

## Error handling

- Compile/run validation errors (`400 { ok:false, errors }`) → banner lists them.
- Run failure (`status.state === 'error'`, `status.error`) → banner + badge.
- Network / non-JSON failures → `jsonFetch` throws → `App` `try/catch` → banner
  ("request failed: …").
- Unknown `runId` on logs/status → `404`; the SPA only polls a `runId` it set, so
  this is defensive.

## Testing

- **Agent (`.inject()`, FakeRunner — no Docker):** `controller.logs(id)` returns
  the runner's stdout for a `logs` argv; `GET /api/logs/:runId` → `{ lines }`;
  `404` for an unknown run.
- **`api.ts`:** `logs()` calls the endpoint and returns `{ lines }`; a `!res.ok`
  non-JSON response makes `jsonFetch` throw; a compile `400` JSON body is returned
  (not thrown).
- **`RunBadge`:** renders the right text per state; renders nothing for `null`.
- **`Drawer`:** the Logs tab renders the `logs` string; tab switching to/from Logs
  works.
- **`App` (RTL, mocked fetch):**
  - after Run, the badge shows "Warming up…" while status is `starting`, then
    "Running" once status flips (sequenced mock).
  - a compile `400` shows the error banner; `[dismiss]` clears it.
  - `Stop` clears `runId` → no further `/api/status` polling (assert call count
    stops growing).
  - opening the Logs tab triggers `GET /api/logs` polling.
- No gated Docker test needed (brick 1's agent e2e already proves the real
  pipeline); this brick is UI + one read-only agent endpoint.

## Out of scope (later / polish)

Live metric badges + Metrics tab (brick 4, WebSocket), phased warmup sub-states,
log search/filter/download, per-service log selection, drag-from-palette,
undo/redo, the cloud hybrid (post-epic).

## Likely task breakdown (for writing-plans)

1. Agent: `ExperimentController.logs(id)` + `GET /api/logs/:runId` + `.inject()`
   tests.
2. `web/src/api.ts`: `logs()` + `jsonFetch` error-surfacing + tests.
3. `web/src/Drawer.tsx`: add the Logs tab (`compose|status|logs`) + `RunBadge.tsx`
   + their tests.
4. `web/src/App.tsx`: error banner + run-state badge wiring + button logic +
   Stop-clears-runId + terminal-stopping status poll + Logs polling + updated RTL
   tests.
