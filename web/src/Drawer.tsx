import type { RunStatus, K6Result } from './api.js';
import type { ServiceMetric } from './metrics-store.js';

export type DrawerTab = 'compose' | 'status' | 'logs' | 'metrics';

interface DrawerProps {
  open: boolean;
  tab: DrawerTab;
  onToggle(): void;
  onSelectTab(tab: DrawerTab): void;
  compose: string;
  status: RunStatus | null;
  logs: string;
  metrics: ServiceMetric[];
  lastLoad: K6Result | null;
}

function TabButton({ tab, active, onSelect, children }: { tab: DrawerTab; active: boolean; onSelect(t: DrawerTab): void; children: string }) {
  return (
    <button
      onClick={() => onSelect(tab)}
      className={`px-3 py-1.5 text-sm transition ${active ? 'border-b-2 border-load font-semibold text-ink' : 'text-muted hover:text-dim'}`}
    >
      {children}
    </button>
  );
}

const CODE = 'max-h-[28vh] overflow-auto rounded-md border border-line bg-[#05070d] p-3 text-[11px] leading-snug text-dim';

export function Drawer({ open, tab, onToggle, onSelectTab, compose, status, logs, metrics, lastLoad }: DrawerProps) {
  return (
    <div className="shrink-0 border-t border-line bg-surface">
      <div className="flex items-center px-2">
        <TabButton tab="compose" active={tab === 'compose'} onSelect={onSelectTab}>Compose</TabButton>
        <TabButton tab="status" active={tab === 'status'} onSelect={onSelectTab}>Status</TabButton>
        <TabButton tab="logs" active={tab === 'logs'} onSelect={onSelectTab}>Logs</TabButton>
        <TabButton tab="metrics" active={tab === 'metrics'} onSelect={onSelectTab}>Metrics</TabButton>
        <div className="flex-1" />
        <button onClick={onToggle} className="px-2 py-1 text-sm text-muted transition hover:text-ink">
          {open ? '▾ collapse' : '▴ expand'}
        </button>
      </div>

      {open && (
        <div className="max-h-[34vh] overflow-auto p-3">
          {tab === 'compose' && (
            <pre className={CODE}>
              {compose || '(press Preview to compile the canvas)'}
            </pre>
          )}
          {tab === 'logs' && (
            <pre className={CODE}>
              {logs || '(no logs yet — run an experiment)'}
            </pre>
          )}
          {tab === 'metrics' && (
            <div>
              {lastLoad && (
                <div className="mb-3 overflow-hidden rounded-lg border border-line">
                  <div className="bg-surface2 px-3 py-1.5 text-xs font-semibold text-dim">Load results</div>
                  <table className="w-full text-right text-xs">
                    <thead className="text-[10px] uppercase text-muted">
                      <tr><th className="px-2 py-1 text-left">target</th><th>target/s</th><th>achieved/s</th><th>dropped/s</th><th>err %</th><th>avg</th><th>p95</th><th>peak</th></tr>
                    </thead>
                    <tbody className="font-mono text-dim">
                      {lastLoad.perTarget.map((t) => {
                        const saturated = t.achievedRps < t.targetRps;
                        return (
                          <tr key={t.slug} className={`border-t border-white/5 ${saturated ? 'bg-load/10' : ''}`}>
                            <td className="px-2 py-1 text-left text-ink">{t.slug}</td>
                            <td>{t.targetRps}</td>
                            <td className={saturated ? 'font-bold text-load' : ''}>{t.achievedRps.toFixed(0)}</td>
                            <td className={saturated ? 'font-bold text-load' : ''}>{t.droppedRps.toFixed(0)}{saturated ? ' ⚠' : ''}</td>
                            <td>{(t.errorRate * 100).toFixed(1)}</td>
                            <td>{t.latencyAvgMs.toFixed(1)}</td>
                            <td>{t.latencyP95Ms.toFixed(0)}</td>
                            <td>{t.latencyMaxMs.toFixed(0)}</td>
                          </tr>
                        );
                      })}
                      <tr className="border-t-2 border-line bg-white/[0.03] font-bold text-ink">
                        <td className="px-2 py-1 text-left">total</td>
                        <td>{lastLoad.total.targetRps}</td>
                        <td>{lastLoad.total.achievedRps.toFixed(0)}</td>
                        <td>{lastLoad.total.droppedRps.toFixed(0)}</td>
                        <td>{(lastLoad.total.errorRate * 100).toFixed(1)}</td>
                        <td>—</td><td>—</td><td>—</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
              {metrics.length === 0 ? (
                <div className="text-sm text-muted">(no live metrics — run an experiment)</div>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead className="text-xs uppercase text-muted"><tr><th className="py-1">Service</th><th>CPU %</th><th>Mem</th><th>Writes</th><th>Δ writes/s</th></tr></thead>
                  <tbody className="font-mono text-dim">
                    {metrics.map((m) => (
                      <tr key={m.service} className="border-t border-white/5">
                        <td className="py-1 text-ink">{m.service}</td>
                        <td>{m.cpuPercent.toFixed(1)}</td>
                        <td>{m.memMB.toFixed(0)} MB</td>
                        <td>{m.writes !== undefined ? m.writes.toLocaleString() : '—'}</td>
                        <td className={m.writesPerSec ? 'text-dbg' : ''}>{m.writesPerSec !== undefined ? `+${m.writesPerSec.toFixed(0)}` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
          {tab === 'status' && (!status ? (
            <div className="text-sm text-muted">(press Run to start the experiment)</div>
          ) : (
            <div>
              <div className="mb-2 text-sm text-dim">State: <span className="font-mono text-ink">{status.state}</span>{status.error ? ` — ${status.error}` : ''}</div>
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase text-muted"><tr><th className="py-1">Service</th><th>State</th><th>Health</th></tr></thead>
                <tbody className="font-mono text-dim">
                  {status.services.map((s) => (
                    <tr key={s.name} className="border-t border-white/5"><td className="py-1 text-ink">{s.name}</td><td>{s.state}</td><td>{s.health ?? '—'}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
