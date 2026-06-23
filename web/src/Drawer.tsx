import type { RunStatus } from './api.js';

export type DrawerTab = 'compose' | 'status' | 'logs';

interface DrawerProps {
  open: boolean;
  tab: DrawerTab;
  onToggle(): void;
  onSelectTab(tab: DrawerTab): void;
  compose: string;
  status: RunStatus | null;
  logs: string;
}

function TabButton({ tab, active, onSelect, children }: { tab: DrawerTab; active: boolean; onSelect(t: DrawerTab): void; children: string }) {
  return (
    <button
      onClick={() => onSelect(tab)}
      className={`px-3 py-1.5 text-sm ${active ? 'border-b-2 border-blue-500 font-semibold' : 'text-slate-500'}`}
    >
      {children}
    </button>
  );
}

export function Drawer({ open, tab, onToggle, onSelectTab, compose, status, logs }: DrawerProps) {
  return (
    <div className="shrink-0 border-t border-slate-200 bg-white">
      <div className="flex items-center px-2">
        <TabButton tab="compose" active={tab === 'compose'} onSelect={onSelectTab}>Compose</TabButton>
        <TabButton tab="status" active={tab === 'status'} onSelect={onSelectTab}>Status</TabButton>
        <TabButton tab="logs" active={tab === 'logs'} onSelect={onSelectTab}>Logs</TabButton>
        <span className="px-3 py-1.5 text-sm text-slate-300" title="brick 4">Metrics ▸</span>
        <div className="flex-1" />
        <button onClick={onToggle} className="px-2 py-1 text-sm text-slate-500">
          {open ? '▾ collapse' : '▴ expand'}
        </button>
      </div>

      {open && (
        <div className="max-h-[34vh] overflow-auto p-3">
          {tab === 'compose' && (
            <pre className="max-h-[28vh] overflow-auto rounded bg-slate-900 p-3 text-[11px] leading-snug text-slate-100">
              {compose || '(press Preview to compile the canvas)'}
            </pre>
          )}
          {tab === 'logs' && (
            <pre className="max-h-[28vh] overflow-auto rounded bg-slate-900 p-3 text-[11px] leading-snug text-slate-100">
              {logs || '(no logs yet — run an experiment)'}
            </pre>
          )}
          {tab === 'status' && (!status ? (
            <div className="text-sm text-slate-400">(press Run to start the experiment)</div>
          ) : (
            <div>
              <div className="mb-2 text-sm">State: <span className="font-mono">{status.state}</span>{status.error ? ` — ${status.error}` : ''}</div>
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase text-slate-400"><tr><th className="py-1">Service</th><th>State</th><th>Health</th></tr></thead>
                <tbody className="font-mono">
                  {status.services.map((s) => (
                    <tr key={s.name} className="border-t border-slate-100"><td className="py-1">{s.name}</td><td>{s.state}</td><td>{s.health ?? '—'}</td></tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-1 text-[10px] text-slate-400">live CPU/mem badges arrive as the Metrics tab in brick 4.</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
