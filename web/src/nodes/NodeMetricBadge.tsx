export function NodeMetricBadge({ metric }: { metric: { cpuPercent: number; memMB: number } | undefined }) {
  if (!metric) return null;
  return (
    <div className="px-2 pb-1.5">
      <div className="flex items-center justify-between text-[10px] text-slate-500">
        <span>cpu {metric.cpuPercent.toFixed(0)}%</span>
        <span>{metric.memMB.toFixed(0)}MB</span>
      </div>
      <div className="mt-0.5 h-1 rounded bg-slate-200">
        <div className="h-full rounded bg-blue-500" style={{ width: `${Math.min(100, metric.cpuPercent)}%` }} />
      </div>
    </div>
  );
}
