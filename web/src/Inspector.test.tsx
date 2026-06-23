import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Inspector } from './Inspector.js';
import { useGraphStore } from './store.js';

beforeEach(() => {
  useGraphStore.setState({ experimentId: 'untitled', nodes: [], edges: [], selectedId: null });
});

function addAndSelect(type: 'service' | 'kafka') {
  useGraphStore.getState().addNode(type);
  const id = useGraphStore.getState().nodes[0]!.id;
  useGraphStore.getState().setSelected(id);
  return id;
}

describe('Inspector', () => {
  it('shows a hint when nothing is selected', () => {
    render(<Inspector />);
    expect(screen.getByText(/select a node/i)).toBeInTheDocument();
  });

  it('edits the label of the selected node', async () => {
    const id = addAndSelect('service');
    render(<Inspector />);
    const input = screen.getByLabelText('label');
    await userEvent.clear(input);
    await userEvent.type(input, 'Orders');
    expect(useGraphStore.getState().nodes.find((n) => n.id === id)!.data.label).toBe('Orders');
  });

  it('shows latency/errorRate only for service nodes', () => {
    addAndSelect('kafka');
    const { rerender } = render(<Inspector />);
    expect(screen.queryByLabelText('latencyMs')).toBeNull();
    // switch to a service node
    useGraphStore.setState({ nodes: [], edges: [], selectedId: null });
    addAndSelect('service');
    rerender(<Inspector />);
    expect(screen.getByLabelText('latencyMs')).toBeInTheDocument();
  });

  it('deletes the selected node', async () => {
    addAndSelect('service');
    render(<Inspector />);
    await userEvent.click(screen.getByRole('button', { name: /delete/i }));
    expect(useGraphStore.getState().nodes).toHaveLength(0);
  });
});
