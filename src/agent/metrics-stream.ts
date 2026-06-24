/** Maps a compose container name (`sds-<runId>-<service>-<n>`) to its service slug. */
export function serviceName(containerName: string, runId: string): string {
  const prefix = `sds-${runId}-`;
  const stripped = containerName.startsWith(prefix) ? containerName.slice(prefix.length) : containerName;
  return stripped.replace(/-\d+$/, '');
}
