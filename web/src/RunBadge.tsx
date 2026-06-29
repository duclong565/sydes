type RunState = 'starting' | 'running' | 'error' | 'stopped';

const MAP: Record<RunState, { text: string; cls: string }> = {
  starting: { text: '⏳ Warming up… (~10-30s)', cls: 'border-amber-500/40 bg-amber-500/10 text-amber-300' },
  running: { text: '● Running', cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' },
  error: { text: '✕ Error', cls: 'border-red-500/40 bg-red-500/10 text-red-300' },
  stopped: { text: '○ Stopped', cls: 'border-line bg-white/5 text-muted' },
};

export function RunBadge({ state, error }: { state: RunState | null; error?: string }) {
  if (!state) return null;
  const m = MAP[state];
  const text = state === 'error' && error ? `✕ ${error}` : m.text;
  return <span className={`rounded-full border px-3 py-1 text-sm font-medium ${m.cls}`}>{text}</span>;
}
