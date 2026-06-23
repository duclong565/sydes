import type { NodeType } from './store.js';
import { useGraphStore } from './store.js';

const TYPES: { type: NodeType; label: string; cls: string }[] = [
  { type: 'service', label: 'Service', cls: 'border-blue-500 bg-blue-50' },
  { type: 'kafka', label: 'Kafka', cls: 'border-amber-500 bg-amber-50' },
  { type: 'worker', label: 'Worker', cls: 'border-violet-500 bg-violet-50' },
  { type: 'db', label: 'DB', cls: 'border-emerald-500 bg-emerald-50' },
  { type: 'lb', label: 'LB', cls: 'border-slate-500 bg-slate-100' },
];

export function Palette() {
  const addNode = useGraphStore((s) => s.addNode);
  return (
    <div className="w-40 shrink-0 overflow-y-auto border-r border-slate-200 bg-white p-2">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Palette</div>
      <div className="space-y-2">
        {TYPES.map((t) => (
          <button
            key={t.type}
            onClick={() => addNode(t.type)}
            className={`w-full rounded border-l-4 px-2 py-1.5 text-left text-sm ${t.cls}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="mt-3 text-[10px] leading-tight text-slate-400">click to add → drag to move</div>
    </div>
  );
}
