import { useGraphStore } from './store.js';
import { slugify } from './slug.js';

const INPUT = 'w-full rounded-md border bg-surface2 px-2 py-1 text-sm text-ink outline-none transition focus:border-load/60';
const OK = 'border-line';
const BAD = 'border-red-500 bg-red-500/10';

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
      <div className="w-64 shrink-0 border-l border-line bg-surface p-3 text-sm text-muted">
        Select a node to edit.
      </div>
    );
  }

  const cfg = node.data.config ?? {};
  return (
    <div className="w-64 shrink-0 overflow-y-auto border-l border-line bg-surface p-3">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">Inspector</div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">{node.data.type}</div>

      <label htmlFor="insp-label" className="block text-xs text-muted">label</label>
      <input
        id="insp-label"
        aria-label="label"
        value={node.data.label}
        onChange={(e) => updateNode(node.id, { label: e.target.value })}
        className={`mb-3 ${INPUT} ${OK}`}
      />

      {node.data.type === 'service' && (
        <>
          <label htmlFor="insp-latency" className="block text-xs text-muted">latencyMs</label>
          <input
            id="insp-latency"
            aria-label="latencyMs"
            type="number"
            value={cfg.latencyMs ?? 0}
            onChange={(e) => updateNode(node.id, { config: { ...cfg, latencyMs: Number(e.target.value) } })}
            className={`mb-2 ${INPUT} ${OK}`}
          />
          <label htmlFor="insp-error" className="block text-xs text-muted">errorRate (0–1)</label>
          <input
            id="insp-error"
            aria-label="errorRate"
            type="number"
            step="0.01"
            value={cfg.errorRate ?? 0}
            onChange={(e) => updateNode(node.id, { config: { ...cfg, errorRate: Number(e.target.value) } })}
            className={`mb-3 ${INPUT} ${OK}`}
          />
          <label htmlFor="insp-mspkb" className="block text-xs text-muted">payload sensitivity (ms/KB)</label>
          {(() => {
            const ms = cfg.msPerKb ?? 0;
            const bad = typeof ms !== 'number' || ms < 0;
            return (<>
              <input
                id="insp-mspkb" aria-label="msPerKb" type="number" step="0.1" min={0}
                value={cfg.msPerKb ?? 0}
                onChange={(e) => updateNode(node.id, { config: { ...cfg, msPerKb: Number(e.target.value) } })}
                className={`mb-1 ${INPUT} ${bad ? BAD : OK}`}
              />
              {bad && <div className="mb-2 text-xs font-semibold text-red-400">Must be ≥ 0</div>}
            </>);
          })()}
        </>
      )}

      {node.data.type === 'kafka' && (() => {
        const partitions = cfg.partitions ?? 1;
        const invalid = !Number.isInteger(partitions) || partitions < 1;
        let text: string;
        let tone: string;
        if (invalid) {
          text = 'fix the value to see the consumer balance';
          tone = 'border-line bg-white/5 text-muted';
        } else if (subscribers === 0) {
          text = 'no consumers yet — wire a worker → this topic';
          tone = 'border-line bg-white/5 text-dim';
        } else if (subscribers > partitions) {
          const idle = subscribers - partitions;
          text = `⚠ ${idle} worker${idle === 1 ? '' : 's'} will sit idle — a partition feeds only one consumer in a group`;
          tone = 'border-l-4 border-amber-500 bg-amber-500/10 text-amber-200';
        } else if (subscribers === partitions) {
          text = `✓ ${subscribers} workers · ${partitions} partitions — all active`;
          tone = 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200';
        } else {
          const idle = partitions - subscribers;
          text = `${idle} partition${idle === 1 ? '' : 's'} idle`;
          tone = 'border-line bg-white/5 text-dim';
        }
        return (
          <>
            <label htmlFor="insp-partitions" className="block text-xs text-muted">partitions</label>
            <input
              id="insp-partitions"
              aria-label="partitions"
              type="number"
              min={1}
              value={cfg.partitions ?? 1}
              onChange={(e) => updateNode(node.id, { config: { ...cfg, partitions: Number(e.target.value) } })}
              className={`mb-1 ${INPUT} ${invalid ? BAD : OK}`}
            />
            {invalid && <div className="mb-2 text-xs font-semibold text-red-400">Partitions must be a whole number ≥ 1</div>}
            <div className={`mb-3 rounded-md border px-2 py-1.5 text-xs ${tone}`}>{text}</div>
          </>
        );
      })()}

      {(node.data.type === 'service' || node.data.type === 'lb') && (() => {
        const on = cfg.loadRate !== undefined;
        const rate = cfg.loadRate ?? 0;
        const invalid = on && (!Number.isInteger(rate) || rate < 1);
        const port = node.data.type === 'lb' ? 80 : 8080;
        const toggle = () =>
          updateNode(node.id, { config: { ...cfg, loadRate: on ? undefined : 20 } });
        return (
          <div className="mb-3 mt-2 border-t border-dashed border-line pt-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-dim">⚡ Load source</span>
              <button
                aria-label="load source"
                aria-pressed={on}
                onClick={toggle}
                className={`relative h-5 w-9 rounded-full transition ${on ? 'bg-load' : 'bg-white/15'}`}
              >
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition ${on ? 'left-[18px]' : 'left-0.5'}`} />
              </button>
            </div>
            {on ? (
              <>
                <label htmlFor="insp-rate" className="mt-2 block text-xs text-muted">rate (req/s)</label>
                <input
                  id="insp-rate"
                  aria-label="rate"
                  type="number"
                  min={1}
                  value={rate}
                  onChange={(e) => updateNode(node.id, { config: { ...cfg, loadRate: Number(e.target.value) } })}
                  className={`${INPUT} ${invalid ? BAD : OK}`}
                />
                {invalid && <div className="mt-1 text-xs font-semibold text-red-400">Rate must be a whole number ≥ 1</div>}
                <div className="mt-1 text-[10px] text-muted">k6 hits {slugify(node.data.label)}:{port}{node.data.type === 'lb' ? ' → nginx round-robins' : ''} at {rate} rps</div>
                <label htmlFor="insp-bodykb" className="mt-2 block text-xs text-muted">body size (KB)</label>
                {(() => {
                  const kb = cfg.loadBodyKb;
                  const bad = kb !== undefined && (!Number.isInteger(kb) || kb < 1 || kb > 1024);
                  return (<>
                    <input
                      id="insp-bodykb" aria-label="body size" type="number" min={1}
                      value={kb ?? ''} placeholder="(unset → {ping:true})"
                      onChange={(e) => updateNode(node.id, { config: { ...cfg, loadBodyKb: e.target.value === '' ? undefined : Number(e.target.value) } })}
                      className={`${INPUT} ${bad ? BAD : OK}`}
                    />
                    {bad
                      ? <div className="mt-1 text-xs font-semibold text-red-400">Max body size is 1024 KB</div>
                      : <div className="mt-1 text-[10px] text-muted">only bites a service with ms/KB &gt; 0</div>}
                  </>);
                })()}
              </>
            ) : (
              <div className="mt-1 text-[10px] text-muted">off — no traffic generated here</div>
            )}
          </div>
        );
      })()}

      <button
        onClick={() => removeNode(node.id)}
        className="w-full rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-sm text-red-300 transition hover:bg-red-500/20"
      >
        Delete node
      </button>
      <div className="mt-3 text-[10px] leading-tight text-muted">
        env vars / healthchecks are compiler-derived from the graph — not edited here.
      </div>
    </div>
  );
}
