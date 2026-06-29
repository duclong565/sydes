export function NodeMetricBadge({
  metric,
}: {
  metric: { cpuPercent: number; memMB: number; writes?: number; writesPerSec?: number } | undefined;
}) {
  if (!metric) return null;
  return (
    <div className="px-2 pb-1.5 font-mono">
      <div className="flex items-center justify-between text-[10px] text-muted">
        <span>cpu {metric.cpuPercent.toFixed(0)}%</span>
        <span>{metric.memMB.toFixed(0)}MB</span>
      </div>
      <div className="mt-0.5 h-1 rounded bg-white/10">
        <div className="h-full rounded bg-svc" style={{ width: `${Math.min(100, metric.cpuPercent)}%` }} />
      </div>
      {metric.writes !== undefined && (
        <div className="mt-1 flex items-center justify-between border-t border-white/10 pt-1 text-[10px]">
          <span className="font-semibold text-dim">{metric.writes.toLocaleString()} writes</span>
          {metric.writesPerSec !== undefined && (
            <span className={metric.writesPerSec > 0 ? 'font-semibold text-dbg' : 'text-muted'}>
              +{metric.writesPerSec.toFixed(0)}/s
            </span>
          )}
        </div>
      )}
    </div>
  );
}
