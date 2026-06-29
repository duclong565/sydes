import type { NodeType } from './store.js';
import { useGraphStore } from './store.js';

const TYPES: { type: NodeType; label: string; cls: string }[] = [
  { type: 'service', label: 'Service', cls: 'border-blue-500 bg-blue-500/10 text-blue-200 hover:bg-blue-500/20' },
  { type: 'kafka', label: 'Kafka', cls: 'border-amber-500 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20' },
  { type: 'worker', label: 'Worker', cls: 'border-pink-500 bg-pink-500/10 text-pink-200 hover:bg-pink-500/20' },
  { type: 'db', label: 'DB', cls: 'border-emerald-500 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20' },
  { type: 'lb', label: 'LB', cls: 'border-slate-400 bg-slate-400/10 text-slate-200 hover:bg-slate-400/20' },
];

export function Palette() {
  const addNode = useGraphStore((s) => s.addNode);
  return (
    <div className="w-40 shrink-0 overflow-y-auto border-r border-line bg-surface p-2">
      <div className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">Palette</div>
      <div className="space-y-2">
        {TYPES.map((t) => (
          <button
            key={t.type}
            onClick={() => addNode(t.type)}
            className={`w-full rounded-md border-l-4 px-2 py-1.5 text-left font-mono text-sm transition ${t.cls}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="mt-3 font-mono text-[10px] leading-tight text-muted">click to add → drag to move</div>
    </div>
  );
}
