import { useEffect, useMemo, useState } from 'react';
import { api, type ExampleEntry, type RunStatus, type K6Result } from './api.js';
import { useGraphStore, type Graph } from './store.js';
import { Palette } from './Palette.js';
import { Canvas } from './Canvas.js';
import { Inspector } from './Inspector.js';
import { Drawer, type DrawerTab } from './Drawer.js';
import { RunBadge } from './RunBadge.js';
import { useMetricsStore } from './metrics-store.js';

function errorText(errors: unknown[]): string {
  return errors.map((e) => (e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : JSON.stringify(e))).join('; ');
}

export function App() {
  const [examples, setExamples] = useState<ExampleEntry[]>([]);
  const [compose, setCompose] = useState('');
  const [logs, setLogs] = useState('');
  const [runId, setRunId] = useState('');
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('compose');

  const experimentId = useGraphStore((s) => s.experimentId);
  const setExperimentId = useGraphStore((s) => s.setExperimentId);
  const loadExample = useGraphStore((s) => s.loadExample);

  const nodes = useGraphStore((s) => s.nodes);
  const sources = useMemo(
    () =>
      nodes
        .filter((n) => {
          const t = n.data.type, r = n.data.config?.loadRate;
          return (t === 'service' || t === 'lb') && Number.isInteger(r) && (r as number) >= 1;
        })
        .map((n) => ({
          nodeId: n.id,
          rate: n.data.config!.loadRate as number,
          ...(n.data.config?.loadBodyKb ? { bodyKb: n.data.config.loadBodyKb } : {}),
        })),
    [nodes],
  );
  const totalRps = sources.reduce((acc, t) => acc + t.rate, 0);

  const metricsByService = useMetricsStore((s) => s.byService);
  const setSnapshot = useMetricsStore((s) => s.setSnapshot);
  const clearMetrics = useMetricsStore((s) => s.clear);
  const [wsLive, setWsLive] = useState(false);
  const [durationSec, setDurationSec] = useState(10);
  const [lastLoad, setLastLoad] = useState<K6Result | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => { api.examples().then(setExamples).catch(() => setError('failed to load examples')); }, []);

  // Status poll: self-cancelling, stops on terminal state.
  useEffect(() => {
    if (!runId) return;
    let active = true;
    async function poll() {
      let s: RunStatus;
      try { s = await api.status(runId); } catch (e) { if (active) setError(String(e)); return; }
      if (!active) return;
      setStatus(s);
      if (s.state === 'error') setError(s.error ?? 'run failed');
      if (s.state === 'starting' || s.state === 'running') setTimeout(poll, 2000);
    }
    poll();
    return () => { active = false; };
  }, [runId]);

  // Logs poll: only while the Logs tab is open and a run exists.
  useEffect(() => {
    if (!runId || !drawerOpen || drawerTab !== 'logs') return;
    let active = true;
    async function poll() {
      try { const r = await api.logs(runId); if (active) setLogs(r.lines); } catch { /* transient */ }
      // torn down when runId clears (onStop) or the drawer/tab changes; no terminal-state self-stop needed
      if (active) setTimeout(poll, 2000);
    }
    poll();
    return () => { active = false; };
  }, [runId, drawerOpen, drawerTab]);

  const state = status?.state ?? null;

  // Metrics WebSocket: open while running, close + clear on stop/terminal/unmount.
  useEffect(() => {
    if (!runId || state !== 'running') return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/metrics/${runId}`);
    ws.onopen = () => setWsLive(true);
    ws.onmessage = (ev) => {
      try { setSnapshot(JSON.parse(ev.data)); } catch { /* ignore malformed frame */ }
    };
    ws.onclose = () => setWsLive(false);
    ws.onerror = () => setWsLive(false);
    return () => { ws.close(); setWsLive(false); clearMetrics(); };
  }, [runId, state, setSnapshot, clearMetrics]);

  async function onPreview() {
    try {
      const r = await api.compile(useGraphStore.getState().toGraph());
      if (r.ok) { setCompose(r.output.compose); setError(null); setDrawerTab('compose'); setDrawerOpen(true); }
      else setError(`Compile failed: ${errorText(r.errors)}`);
    } catch (e) { setError(String(e)); }
  }
  async function onRun() {
    try {
      const r = await api.run(useGraphStore.getState().toGraph());
      if ('runId' in r) {
        setError(null);
        setStatus({ runId: r.runId, state: 'starting', services: [] }); // optimistic warmup
        setRunId(r.runId);
        setDrawerTab('status');
        setDrawerOpen(true);
      } else setError(`Compile failed: ${errorText(r.errors)}`);
    } catch (e) { setError(String(e)); }
  }
  async function onStop() {
    if (!runId) return;
    try {
      await api.stop(runId);
      setStatus({ runId, state: 'stopped', services: [] });
      setRunId(''); // halts polling
    } catch (e) { setError(String(e)); }
  }
  async function onRunLoad() {
    if (!runId || sources.length === 0) return;
    setLoading(true);
    try {
      const r = await api.load(runId, durationSec, sources);
      if ('perTarget' in r) { setLastLoad(r); setError(null); setDrawerTab('metrics'); setDrawerOpen(true); }
      else setError(`Load failed: ${r.error ?? errorText(r.errors ?? [])}`);
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }
  function onLoadExample(id: string) {
    const ex = examples.find((e) => e.id === id);
    if (ex) loadExample(ex.graph as Graph);
  }

  const warming = state === 'starting';
  // 'error' too: a failed run can leave a half-up stack — Stop tears it down (agent /api/stop is state-agnostic).
  const stoppable = state === 'starting' || state === 'running' || state === 'error';

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-ground font-mono text-ink">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface/80 px-4 py-2 backdrop-blur">
        <h1 className="mr-1 font-display text-xl font-extrabold tracking-tight">
          sy<span className="text-load">des</span>
          <span className="ml-2 align-middle font-mono text-[10px] font-normal lowercase tracking-wide text-muted">system design sandbox</span>
        </h1>
        <label className="ml-2 text-xs text-muted" htmlFor="exp">experiment</label>
        <input id="exp" aria-label="experiment" value={experimentId} onChange={(e) => setExperimentId(e.target.value)}
          className="w-32 rounded-md border border-line bg-surface2 px-2 py-1 text-sm text-ink outline-none focus:border-load/60" />
        <select aria-label="load example" defaultValue="" onChange={(e) => onLoadExample(e.target.value)}
          className="rounded-md border border-line bg-surface2 px-2 py-1 text-sm text-ink outline-none focus:border-load/60">
          <option value="" disabled>Load example…</option>
          {examples.map((e) => (<option key={e.id} value={e.id}>{e.label}</option>))}
        </select>
        <RunBadge state={state} error={status?.error} />
        {wsLive && <span className="flex items-center gap-1.5 text-xs text-dbg"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-dbg" />live metrics</span>}
        <div className="flex-1" />
        {state === 'running' && (
          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface2 px-2 py-1">
            <label className="text-[11px] text-muted">dur
              <input aria-label="duration" type="number" min={1} max={120} value={durationSec}
                onChange={(e) => setDurationSec(Number(e.target.value))}
                className="ml-1 w-12 rounded border border-line bg-surface px-1 py-0.5 text-right text-sm text-ink outline-none focus:border-load/60" /></label>
            <span className={`text-[11px] font-semibold ${sources.length ? 'text-load' : 'text-muted'}`}>
              {sources.length ? `⚡ ${sources.length} sources · ${totalRps} rps` : 'select a service → toggle ⚡ Load source'}
            </span>
            <button onClick={onRunLoad} disabled={loading || sources.length === 0}
              className="rounded-md bg-load px-2.5 py-1 text-sm font-semibold text-[#1a0a02] transition hover:brightness-110 disabled:opacity-40">
              {loading ? 'Running load…' : 'Run load'}
            </button>
          </div>
        )}
        <button className="rounded-md border border-line px-3 py-1 text-sm text-ink transition hover:bg-white/5" onClick={onPreview}>Preview</button>
        <button className="rounded-md bg-svc px-3 py-1 text-sm font-semibold text-[#04122e] transition hover:brightness-110 disabled:opacity-40" disabled={warming} onClick={onRun}>Run</button>
        <button className="rounded-md bg-red-600 px-3 py-1 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-40" disabled={!stoppable} onClick={onStop}>Stop</button>
      </div>

      {error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-red-500/30 bg-red-500/10 px-4 py-1.5 text-sm text-red-300">
          <span className="font-semibold">✕</span>
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="rounded px-2 py-0.5 text-xs text-red-400 hover:bg-red-500/20">dismiss</button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <Palette />
        <div className="min-w-0 flex-1"><Canvas loading={loading} /></div>
        <Inspector />
      </div>

      <Drawer
        open={drawerOpen}
        tab={drawerTab}
        onToggle={() => setDrawerOpen((o) => !o)}
        onSelectTab={setDrawerTab}
        compose={compose}
        status={status}
        logs={logs}
        metrics={Object.entries(metricsByService).map(([service, m]) => ({ service, cpuPercent: m.cpuPercent, memMB: m.memMB, writes: m.writes, writesPerSec: m.writesPerSec }))}
        lastLoad={lastLoad}
      />
    </div>
  );
}
