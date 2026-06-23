import { useEffect, useState } from 'react';
import { api, type ExampleEntry, type RunStatus } from './api.js';
import { useGraphStore, type Graph } from './store.js';
import { Palette } from './Palette.js';
import { Canvas } from './Canvas.js';
import { Inspector } from './Inspector.js';
import { Drawer, type DrawerTab } from './Drawer.js';

export function App() {
  const [examples, setExamples] = useState<ExampleEntry[]>([]);
  const [compose, setCompose] = useState('');
  const [runId, setRunId] = useState('');
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('compose');

  const experimentId = useGraphStore((s) => s.experimentId);
  const setExperimentId = useGraphStore((s) => s.setExperimentId);
  const loadExample = useGraphStore((s) => s.loadExample);

  useEffect(() => { api.examples().then(setExamples); }, []);
  useEffect(() => {
    if (!runId) return;
    const t = setInterval(async () => setStatus(await api.status(runId)), 2000);
    return () => clearInterval(t);
  }, [runId]);

  async function onPreview() {
    const r = await api.compile(useGraphStore.getState().toGraph());
    setCompose(r.output?.compose ?? `errors: ${JSON.stringify(r.errors)}`);
    setDrawerTab('compose');
    setDrawerOpen(true);
  }
  async function onRun() {
    const r = await api.run(useGraphStore.getState().toGraph());
    setRunId(r.runId);
    setDrawerTab('status');
    setDrawerOpen(true);
  }
  async function onStop() {
    if (!runId) return;
    await api.stop(runId);
    setStatus(await api.status(runId));
  }
  function onLoadExample(id: string) {
    const ex = examples.find((e) => e.id === id);
    if (ex) loadExample(ex.graph as Graph);
  }

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
        <div className="flex-1" />
        <button className="rounded bg-slate-200 px-3 py-1 text-sm" onClick={onPreview}>Preview</button>
        <button className="rounded bg-blue-600 px-3 py-1 text-sm text-white" onClick={onRun}>Run</button>
        <button className="rounded bg-red-600 px-3 py-1 text-sm text-white" onClick={onStop}>Stop</button>
      </div>

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
      />
    </div>
  );
}
