import { render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { describe, it, expect } from 'vitest';
import { SdsNode } from './SdsNode.js';

const renderNode = (data: any) =>
  render(<ReactFlowProvider><SdsNode id="n1" data={data} type="sds" selected={false} zIndex={0} isConnectable dragging={false} xPos={0} yPos={0} /></ReactFlowProvider> as any);

describe('SdsNode ⚡ chip', () => {
  it('shows ⚡N/s when a service is a load source', () => {
    renderNode({ type: 'service', label: 'Checkout', config: { loadRate: 50 } });
    expect(screen.getByText(/⚡ 50\/s/)).toBeInTheDocument();
  });
  it('shows no chip when loadRate is unset', () => {
    renderNode({ type: 'service', label: 'Search' });
    expect(screen.queryByText(/\/s/)).not.toBeInTheDocument();
  });
  it('shows ⚡N/s when an lb node is a load source', () => {
    renderNode({ type: 'lb', label: 'Gateway', config: { loadRate: 100 } });
    expect(screen.getByText(/⚡ 100\/s/)).toBeInTheDocument();
  });
  it('does not show chip for non-source types (kafka)', () => {
    renderNode({ type: 'kafka', label: 'Events', config: { loadRate: 10 } });
    expect(screen.queryByText(/\/s/)).not.toBeInTheDocument();
  });
  it('does not show chip when loadRate is 0', () => {
    renderNode({ type: 'service', label: 'Idle', config: { loadRate: 0 } });
    expect(screen.queryByText(/\/s/)).not.toBeInTheDocument();
  });
});
