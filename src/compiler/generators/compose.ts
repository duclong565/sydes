import type { ComposeService } from '../types.js';

export function generateCompose(services: ComposeService[], networkName: string): string {
  const lines: string[] = ['services:'];
  for (const svc of services) {
    lines.push(`  ${svc.name}:`);
    lines.push(`    image: ${svc.image}`);
    const envKeys = Object.keys(svc.environment);
    if (envKeys.length > 0) {
      lines.push('    environment:');
      for (const key of envKeys) lines.push(`      ${key}: "${svc.environment[key]}"`);
    }
    if (svc.ports && svc.ports.length > 0) {
      lines.push('    ports:');
      for (const port of svc.ports) lines.push(`      - "${port}"`);
    }
    if (svc.volumes && svc.volumes.length > 0) {
      lines.push('    volumes:');
      for (const vol of svc.volumes) lines.push(`      - "${vol}"`);
    }
    if (svc.healthcheck) {
      const test = svc.healthcheck.test.map((t) => `"${t}"`).join(', ');
      lines.push('    healthcheck:');
      lines.push(`      test: [${test}]`);
      lines.push(`      interval: ${svc.healthcheck.interval}`);
      lines.push(`      timeout: ${svc.healthcheck.timeout}`);
      lines.push(`      retries: ${svc.healthcheck.retries}`);
    }
    if (svc.dependsOn && svc.dependsOn.length > 0) {
      lines.push('    depends_on:');
      for (const dep of svc.dependsOn) {
        lines.push(`      ${dep}:`);
        lines.push('        condition: service_healthy');
      }
    }
    lines.push('    networks:');
    lines.push(`      - ${networkName}`);
  }
  lines.push('networks:');
  lines.push(`  ${networkName}:`);
  lines.push('    driver: bridge');
  return lines.join('\n') + '\n';
}
