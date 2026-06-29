import type { Graph, LoadConfig, CompilerResult, CompilerError, ComposeService } from './types.js';
import { buildIndex } from './graph-index.js';
import { handlers } from './handlers/index.js';
import { generateCompose } from './generators/compose.js';
import { generateNginx } from './generators/nginx.js';
import { generateK6 } from './generators/k6.js';
import { slugify } from './util.js';

/** Source→target type combos the compiler actually wires. Everything else is a no-op edge. */
const ALLOWED_EDGES = new Set<string>([
  'service>kafka', 'service>db', 'service>service',
  'worker>kafka', 'worker>db',
  'lb>service',
]);

export function compile(graph: Graph, loadConfig?: LoadConfig): CompilerResult {
  // 1. Duplicate-label check first.
  const seen = new Map<string, string>();
  const dupErrors: CompilerError[] = [];
  for (const node of graph.nodes) {
    const slug = slugify(node.label);
    const prior = seen.get(slug);
    if (prior) {
      dupErrors.push({ nodeId: node.id, message: `Duplicate label "${node.label}" collides with node ${prior}` });
    } else {
      seen.set(slug, node.id);
    }
  }
  if (dupErrors.length > 0) return { ok: false, errors: dupErrors };

  const index = buildIndex(graph);

  // 2. Validation pass — collect ALL errors.
  const errors: CompilerError[] = [];
  for (const node of graph.nodes) {
    errors.push(...handlers[node.type].validate(node, index));
  }

  // Edge-legality pass — default-deny. Reject dangling refs, self-loops, and any
  // source→target combo no handler wires (silent no-ops like db→service).
  for (const edge of graph.edges) {
    const src = index.nodeMap.get(edge.source);
    const tgt = index.nodeMap.get(edge.target);
    if (!src || !tgt) {
      const missing = !src ? edge.source : edge.target;
      errors.push({ nodeId: edge.source, message: `Edge references unknown node "${missing}"` });
      continue;
    }
    if (edge.source === edge.target) {
      errors.push({ nodeId: edge.source, message: `A node cannot connect to itself ("${src.label}")` });
      continue;
    }
    if (!ALLOWED_EDGES.has(`${src.type}>${tgt.type}`)) {
      errors.push({
        nodeId: edge.source,
        message: `Invalid connection: a ${src.type} ("${src.label}") cannot connect to a ${tgt.type} ("${tgt.label}")`,
      });
    }
  }

  // Load-targeting pass — only when a load config is supplied (Preview/Run pass none).
  if (loadConfig) {
    if (loadConfig.targets.length === 0) {
      errors.push({ nodeId: '', message: 'Load requires at least one target' });
    }
    for (const t of loadConfig.targets) {
      const node = index.nodeMap.get(t.nodeId);
      if (!node) {
        errors.push({ nodeId: t.nodeId, message: `Load target "${t.nodeId}" is not in the graph` });
        continue;
      }
      if (node.type !== 'service' && node.type !== 'lb') {
        errors.push({ nodeId: t.nodeId, message: `Load target "${node.label}" must be a service or lb (got ${node.type})` });
      }
      if (!Number.isInteger(t.rate) || t.rate < 1) {
        errors.push({ nodeId: t.nodeId, message: `Load rate for "${node.label}" must be a whole number ≥ 1` });
      }
      if (t.bodyKb !== undefined && (!Number.isInteger(t.bodyKb) || t.bodyKb < 1 || t.bodyKb > 1024)) {
        errors.push({ nodeId: t.nodeId, message: `Body size for "${node?.label ?? t.nodeId}" must be a whole number 1–1024 KB` });
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // 3. Generation pass.
  const services: ComposeService[] = graph.nodes.map((node) =>
    handlers[node.type].compile(node, index),
  );

  // 3b. Host-port collision check — a published host port can only be bound once.
  // Without this, two publishers (e.g. two LBs on :80) reach `docker compose up`
  // and die with an opaque "port is already allocated"; fail loud at compile time
  // instead. `seen` maps a service slug back to its node id for the error.
  const portOwner = new Map<string, string>(); // host port -> owning service slug
  const portErrors: CompilerError[] = [];
  for (const svc of services) {
    for (const mapping of svc.ports ?? []) {
      const hostPort = mapping.split(':')[0]!;
      const prior = portOwner.get(hostPort);
      if (prior) {
        portErrors.push({
          nodeId: seen.get(svc.name) ?? svc.name,
          message: `Host port ${hostPort} is published by both "${prior}" and "${svc.name}" — a host port can only be bound once per experiment`,
        });
      } else {
        portOwner.set(hostPort, svc.name);
      }
    }
  }
  if (portErrors.length > 0) return { ok: false, errors: portErrors };

  // 4. Compose.
  const networkName = `sds-${graph.experimentId}-net`;
  const compose = generateCompose(services, networkName);
  const output: { compose: string; nginx?: string; k6?: string; loadTargets?: { slug: string; targetRps: number }[] } = { compose };

  // 5. Nginx (first LB node, if any).
  const lbNode = graph.nodes.find((n) => n.type === 'lb');
  if (lbNode) {
    const upstreams = index
      .outEdges(lbNode.id)
      .map((e) => index.nodeMap.get(e.target))
      .filter((n) => n?.type === 'service')
      .map((n) => slugify(n!.label));
    output.nginx = generateNginx(upstreams);
  }

  // 6. k6 — one tagged scenario per explicit load target (validated above; no auto-pick).
  if (loadConfig) {
    const resolved = loadConfig.targets.map((t) => {
      const node = index.nodeMap.get(t.nodeId)!;
      return { slug: slugify(node.label), port: node.type === 'lb' ? 80 : 8080, rate: t.rate, bodyKb: t.bodyKb };
    });
    output.k6 = generateK6(resolved, loadConfig.durationSec);
    output.loadTargets = resolved.map((r) => ({ slug: r.slug, targetRps: r.rate }));
  }

  return { ok: true, output };
}
