import type { Graph, LoadConfig, CompilerResult, CompilerError, ComposeService } from './types.js';
import { buildIndex } from './graph-index.js';
import { handlers } from './handlers/index.js';
import { generateCompose } from './generators/compose.js';
import { generateNginx } from './generators/nginx.js';
import { generateK6 } from './generators/k6.js';
import { slugify } from './util.js';

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
  if (errors.length > 0) return { ok: false, errors };

  // 3. Generation pass.
  const services: ComposeService[] = graph.nodes.map((node) =>
    handlers[node.type].compile(node, index),
  );

  // 4. Compose.
  const networkName = `sds-${graph.experimentId}-net`;
  const compose = generateCompose(services, networkName);
  const output: { compose: string; nginx?: string; k6?: string } = { compose };

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

  // 6. k6 (entry = first LB else first service).
  if (loadConfig) {
    const entry = lbNode ?? graph.nodes.find((n) => n.type === 'service');
    if (entry) {
      const port = entry.type === 'lb' ? 80 : 8080;
      output.k6 = generateK6(slugify(entry.label), port, loadConfig);
    }
  }

  return { ok: true, output };
}
