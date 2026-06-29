import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { AppNode, NodeType } from '../store.js';
import { useMetricsStore } from '../metrics-store.js';
import { slugify } from '../slug.js';
import { NodeMetricBadge } from './NodeMetricBadge.js';

const HEADER: Record<NodeType, string> = {
  service: 'bg-blue-500', kafka: 'bg-amber-500', worker: 'bg-pink-500', db: 'bg-emerald-500', lb: 'bg-slate-400',
};
const BORDER: Record<NodeType, string> = {
  service: 'border-blue-500/60', kafka: 'border-amber-500/60', worker: 'border-pink-500/60', db: 'border-emerald-500/60', lb: 'border-slate-400/60',
};

export function SdsNode({ data }: NodeProps<AppNode>) {
  const metric = useMetricsStore((s) => s.byService[slugify(data.label)]);

  // DB renders as a postgres cylinder (matches the landing diagram).
  if (data.type === 'db') {
    return (
      <div className="sds-db">
        <Handle type="target" position={Position.Left} />
        <div className="text-center text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-300/90">db</div>
        <div className="mt-0.5 text-center font-mono text-sm text-ink">{data.label}</div>
        {metric?.writes !== undefined && (
          <div className="mt-1 text-center font-mono text-[10px] text-dbg">
            {metric.writes.toLocaleString()} w{metric.writesPerSec ? ` · +${metric.writesPerSec.toFixed(0)}/s` : ''}
          </div>
        )}
        <Handle type="source" position={Position.Right} />
      </div>
    );
  }

  const loadRate = data.config?.loadRate;
  const isSource = (data.type === 'service' || data.type === 'lb') && loadRate !== undefined && loadRate >= 1;
  return (
    <div className={`w-40 overflow-hidden rounded-lg border bg-surface2 shadow-[0_10px_28px_-12px_rgba(0,0,0,0.8)] ${BORDER[data.type]}`}>
      <Handle type="target" position={Position.Left} />
      <div className={`flex items-center justify-between px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-black/85 ${HEADER[data.type]}`}>
        <span>{data.type}</span>
        {isSource && <span className="rounded-full bg-black/20 px-1.5 font-mono normal-case text-black/90">⚡ {loadRate}/s</span>}
      </div>
      <div className="px-2 py-2 font-mono text-sm text-ink">{data.label}</div>
      <NodeMetricBadge metric={metric} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
