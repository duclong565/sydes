type RunState = 'starting' | 'running' | 'error' | 'stopped';

const MAP: Record<RunState, { text: string; cls: string }> = {
  starting: { text: '⏳ Warming up… (~10-30s)', cls: 'border-amber-300 bg-amber-50 text-amber-700' },
  running: { text: '● Running', cls: 'border-emerald-300 bg-emerald-50 text-emerald-700' },
  error: { text: '✕ Error', cls: 'border-red-300 bg-red-50 text-red-700' },
  stopped: { text: '○ Stopped', cls: 'border-slate-300 bg-slate-50 text-slate-500' },
};

export function RunBadge({ state, error }: { state: RunState | null; error?: string }) {
  if (!state) return null;
  const m = MAP[state];
  const text = state === 'error' && error ? `✕ ${error}` : m.text;
  return <span className={`rounded-full border px-3 py-1 text-sm font-medium ${m.cls}`}>{text}</span>;
}
