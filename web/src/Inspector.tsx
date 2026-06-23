import { useGraphStore } from './store.js';

export function Inspector() {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === s.selectedId) ?? null);
  const updateNode = useGraphStore((s) => s.updateNode);
  const removeNode = useGraphStore((s) => s.removeNode);

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
