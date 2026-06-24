import { useEffect, useState } from 'react';
import { api, type ExampleEntry, type RunStatus } from './api.js';
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

  const metricsByService = useMetricsStore((s) => s.byService);
  const setSnapshot = useMetricsStore((s) => s.setSnapshot);
  const clearMetrics = useMetricsStore((s) => s.clear);
  const [wsLive, setWsLive] = useState(false);

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
  function onLoadExample(id: string) {
    const ex = examples.find((e) => e.id === id);
    if (ex) loadExample(ex.graph as Graph);
  }

  const warming = state === 'starting';
  const stoppable = state === 'starting' || state === 'running';

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-slate-100 text-slate-800">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2">
        <h1 className="mr-2 text-lg font-bold">System Design Sandbox</h1>
        <label className="text-xs text-slate-500" htmlFor="exp">experiment</label>
        <input id="exp" aria-label="experiment" value={experimentId} onChange={(e) => setExperimentId(e.target.value)}
          className="w-32 rounded border border-slate-300 px-2 py-1 text-sm" />
        <select aria-label="load example" defaultValue="" onChange={(e) => onLoadExample(e.target.value)}
          className="rounded border border-slate-300 px-2 py-1 text-sm">
          <option value="" disabled>Load example…</option>
          {examples.map((e) => (<option key={e.id} value={e.id}>{e.label}</option>))}
        </select>
        <RunBadge state={state} error={status?.error} />
        {wsLive && <span className="text-xs text-emerald-600">● live metrics</span>}
        <div className="flex-1" />
        <button className="rounded bg-slate-200 px-3 py-1 text-sm" onClick={onPreview}>Preview</button>
        <button className="rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-50" disabled={warming} onClick={onRun}>Run</button>
        <button className="rounded bg-red-600 px-3 py-1 text-sm text-white disabled:opacity-50" disabled={!stoppable} onClick={onStop}>Stop</button>
      </div>

      {error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-red-200 bg-red-50 px-4 py-1.5 text-sm text-red-700">
          <span className="font-semibold">✕</span>
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="rounded px-2 py-0.5 text-xs text-red-600 hover:bg-red-100">dismiss</button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <Palette />
        <div className="min-w-0 flex-1"><Canvas /></div>
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
        metrics={Object.entries(metricsByService).map(([service, m]) => ({ service, cpuPercent: m.cpuPercent, memMB: m.memMB }))}
      />
    </div>
  );
}
