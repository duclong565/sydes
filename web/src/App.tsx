import { useEffect, useState } from 'react';
import { api, type ExampleEntry, type RunStatus } from './api.js';

export function App() {
  const [examples, setExamples] = useState<ExampleEntry[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [compose, setCompose] = useState<string>('');
  const [runId, setRunId] = useState<string>('');
  const [status, setStatus] = useState<RunStatus | null>(null);

  useEffect(() => {
    api.examples().then((list) => {
      setExamples(list);
      if (list[0]) setSelected(list[0].id);
    });
  }, []);

  useEffect(() => {
    if (!runId) return;
    const t = setInterval(async () => setStatus(await api.status(runId)), 2000);
    return () => clearInterval(t);
  }, [runId]);

  const current = examples.find((e) => e.id === selected);

  async function onPreview() {
    if (!current) return;
    const r = await api.compile(current.graph);
    setCompose(r.output?.compose ?? `errors: ${JSON.stringify(r.errors)}`);
  }
  async function onRun() {
    if (!current) return;
    const r = await api.run(current.graph);
    setRunId(r.runId);
  }
  async function onStop() {
    if (!runId) return;
    await api.stop(runId);
    setStatus(await api.status(runId));
  }

  return (
    <div className="mx-auto max-w-3xl p-6 font-sans">
      <h1 className="mb-4 text-2xl font-bold">System Design Sandbox</h1>
      <div className="mb-4 flex items-center gap-2">
        <select
          aria-label="example"
          className="rounded border px-2 py-1"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          {examples.map((e) => (
            <option key={e.id} value={e.id}>{e.label}</option>
          ))}
        </select>
        <button className="rounded bg-gray-200 px-3 py-1" onClick={onPreview}>Preview</button>
        <button className="rounded bg-blue-600 px-3 py-1 text-white" onClick={onRun}>Run</button>
        <button className="rounded bg-red-600 px-3 py-1 text-white" onClick={onStop}>Stop</button>
      </div>

      {compose && (
        <pre className="mb-4 max-h-60 overflow-auto rounded bg-gray-900 p-3 text-xs text-gray-100">{compose}</pre>
      )}

      {status && (
        <div>
          <p className="mb-2">State: <span className="font-mono">{status.state}</span>{status.error ? ` — ${status.error}` : ''}</p>
          <table className="w-full text-left text-sm">
            <thead><tr><th>Service</th><th>State</th><th>Health</th></tr></thead>
            <tbody>
              {status.services.map((s) => (
                <tr key={s.name}><td className="font-mono">{s.name}</td><td>{s.state}</td><td>{s.health ?? '-'}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
