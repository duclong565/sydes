import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { AppNode, NodeType } from '../store.js';
import { useMetricsStore } from '../metrics-store.js';
import { slugify } from '../slug.js';
import { NodeMetricBadge } from './NodeMetricBadge.js';

const HEADER: Record<NodeType, string> = {
  service: 'bg-blue-500', kafka: 'bg-amber-500', worker: 'bg-violet-500', db: 'bg-emerald-500', lb: 'bg-slate-500',
};
const BORDER: Record<NodeType, string> = {
  service: 'border-blue-300', kafka: 'border-amber-300', worker: 'border-violet-300', db: 'border-emerald-300', lb: 'border-slate-300',
};

export function SdsNode({ data }: NodeProps<AppNode>) {
  const metric = useMetricsStore((s) => s.byService[slugify(data.label)]);
  const loadRate = data.config?.loadRate;
  const isSource = (data.type === 'service' || data.type === 'lb') && loadRate !== undefined && loadRate >= 1;
  return (
    <div className={`w-40 rounded-md border bg-white shadow-sm ${BORDER[data.type]}`}>
      <Handle type="target" position={Position.Left} />
      <div className={`flex items-center justify-between rounded-t-md px-2 py-0.5 text-[10px] font-semibold uppercase text-white ${HEADER[data.type]}`}>
        <span>{data.type}</span>
        {isSource && <span className="rounded-full bg-white/25 px-1.5 normal-case">⚡ {loadRate}/s</span>}
      </div>
      <div className="px-2 py-2 text-sm">{data.label}</div>
      <NodeMetricBadge metric={metric} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
