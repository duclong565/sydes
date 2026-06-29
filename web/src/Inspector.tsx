import { useGraphStore } from './store.js';

export function Inspector() {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === s.selectedId) ?? null);
  const updateNode = useGraphStore((s) => s.updateNode);
  const removeNode = useGraphStore((s) => s.removeNode);
  const subscribers = useGraphStore((s) => {
    const id = s.selectedId;
    if (!id) return 0;
    return s.edges.filter(
      (e) => e.target === id && s.nodes.find((n) => n.id === e.source)?.data.type === 'worker',
    ).length;
  });

  if (!node) {
    return (
      <div className="w-64 shrink-0 border-l border-slate-200 bg-white p-3 text-sm text-slate-400">
        Select a node to edit.
      </div>
    );
  }

  const cfg = node.data.config ?? {};
  return (
    <div className="w-64 shrink-0 overflow-y-auto border-l border-slate-200 bg-white p-3">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Inspector</div>
      <div className="mb-1 text-[10px] uppercase text-slate-400">{node.data.type}</div>

      <label htmlFor="insp-label" className="block text-xs text-slate-500">label</label>
      <input
        id="insp-label"
        aria-label="label"
        value={node.data.label}
        onChange={(e) => updateNode(node.id, { label: e.target.value })}
        className="mb-3 w-full rounded border border-slate-300 px-2 py-1 text-sm"
      />

      {node.data.type === 'service' && (
        <>
          <label htmlFor="insp-latency" className="block text-xs text-slate-500">latencyMs</label>
          <input
            id="insp-latency"
            aria-label="latencyMs"
            type="number"
            value={cfg.latencyMs ?? 0}
            onChange={(e) => updateNode(node.id, { config: { ...cfg, latencyMs: Number(e.target.value) } })}
            className="mb-2 w-full rounded border border-slate-300 px-2 py-1 text-sm"
          />
          <label htmlFor="insp-error" className="block text-xs text-slate-500">errorRate (0–1)</label>
          <input
            id="insp-error"
            aria-label="errorRate"
            type="number"
            step="0.01"
            value={cfg.errorRate ?? 0}
            onChange={(e) => updateNode(node.id, { config: { ...cfg, errorRate: Number(e.target.value) } })}
            className="mb-3 w-full rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </>
      )}

      {node.data.type === 'kafka' && (() => {
        const partitions = cfg.partitions ?? 1;
        const invalid = !Number.isInteger(partitions) || partitions < 1;
        let text: string;
        let tone: string;
        if (invalid) {
          text = 'fix the value to see the consumer balance';
          tone = 'border-slate-200 bg-slate-50 text-slate-500';
        } else if (subscribers === 0) {
          text = 'no consumers yet — wire a worker → this topic';
          tone = 'border-slate-200 bg-slate-50 text-slate-600';
        } else if (subscribers > partitions) {
          const idle = subscribers - partitions;
          text = `⚠ ${idle} worker${idle === 1 ? '' : 's'} will sit idle — a partition feeds only one consumer in a group`;
          tone = 'border-l-4 border-amber-500 bg-amber-50 text-amber-900';
        } else if (subscribers === partitions) {
          text = `✓ ${subscribers} workers · ${partitions} partitions — all active`;
          tone = 'border-emerald-300 bg-emerald-50 text-emerald-800';
        } else {
          const idle = partitions - subscribers;
          text = `${idle} partition${idle === 1 ? '' : 's'} idle`;
          tone = 'border-slate-200 bg-slate-50 text-slate-600';
        }
        return (
          <>
            <label htmlFor="insp-partitions" className="block text-xs text-slate-500">partitions</label>
            <input
              id="insp-partitions"
              aria-label="partitions"
              type="number"
              min={1}
              value={cfg.partitions ?? 1}
              onChange={(e) => updateNode(node.id, { config: { ...cfg, partitions: Number(e.target.value) } })}
              className={`mb-1 w-full rounded border px-2 py-1 text-sm ${invalid ? 'border-red-500 bg-red-50' : 'border-slate-300'}`}
            />
            {invalid && <div className="mb-2 text-xs font-semibold text-red-600">Partitions must be a whole number ≥ 1</div>}
            <div className={`mb-3 rounded border px-2 py-1.5 text-xs ${tone}`}>{text}</div>
          </>
        );
      })()}

      <button
        onClick={() => removeNode(node.id)}
        className="w-full rounded border border-red-200 bg-red-50 px-2 py-1 text-sm text-red-600"
      >
        Delete node
      </button>
      <div className="mt-3 text-[10px] leading-tight text-slate-400">
        env vars / healthchecks are compiler-derived from the graph — not edited here.
      </div>
    </div>
  );
}
