import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Inspector } from './Inspector.js';
import { useGraphStore } from './store.js';

beforeEach(() => {
  useGraphStore.setState({ experimentId: 'untitled', nodes: [], edges: [], selectedId: null });
});

function addAndSelect(type: 'service' | 'kafka' | 'lb') {
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

  it('shows a partitions input for kafka nodes (not service fields)', () => {
    addAndSelect('kafka');
    render(<Inspector />);
    expect(screen.getByLabelText('partitions')).toBeInTheDocument();
    expect(screen.queryByLabelText('latencyMs')).toBeNull();
  });

  it('edits the partitions of a kafka node', async () => {
    const id = addAndSelect('kafka');
    render(<Inspector />);
    const input = screen.getByLabelText('partitions');
    await userEvent.clear(input);
    await userEvent.type(input, '4');
    expect(useGraphStore.getState().nodes.find((n) => n.id === id)!.data.config!.partitions).toBe(4);
  });

  it('warns when more workers subscribe than there are partitions', () => {
    const store = useGraphStore.getState();
    store.addNode('kafka');
    store.addNode('worker');
    store.addNode('worker');
    store.addNode('worker');
    const [k, w1, w2, w3] = useGraphStore.getState().nodes.map((n) => n.id);
    const conn = (source: string) => ({ source, target: k!, sourceHandle: null, targetHandle: null });
    store.onConnect(conn(w1!));
    store.onConnect(conn(w2!));
    store.onConnect(conn(w3!));
    store.setSelected(k!);
    render(<Inspector />);
    expect(screen.getByText(/2 workers will sit idle/i)).toBeInTheDocument(); // 3 subscribers, 1 partition
  });

  it('shows an inline error and pauses the hint for partitions < 1', () => {
    const id = addAndSelect('kafka');
    useGraphStore.getState().updateNode(id, { config: { partitions: 0 } });
    render(<Inspector />);
    expect(screen.getByText(/whole number ≥ 1/i)).toBeInTheDocument();
    expect(screen.getByText(/fix the value/i)).toBeInTheDocument();
  });

  it('shows the load toggle on a service and adds loadRate when turned on', async () => {
    const id = addAndSelect('service');
    render(<Inspector />);
    const toggle = screen.getByRole('button', { name: /load source/i });
    expect(toggle).toBeInTheDocument();
    expect(screen.queryByLabelText('rate')).toBeNull();
    await userEvent.click(toggle);
    expect(useGraphStore.getState().nodes.find((n) => n.id === id)!.data.config!.loadRate).toBeGreaterThanOrEqual(1);
    expect(screen.getByLabelText('rate')).toBeInTheDocument();
  });

  it('shows the load toggle on an lb node too', () => {
    addAndSelect('lb');
    render(<Inspector />);
    expect(screen.getByRole('button', { name: /load source/i })).toBeInTheDocument();
  });

  it('flags a non-integer rate inline', () => {
    const id = addAndSelect('service');
    useGraphStore.getState().updateNode(id, { config: { loadRate: 2.5 } });
    render(<Inspector />);
    expect(screen.getByText(/Rate must be a whole number ≥ 1/i)).toBeInTheDocument();
  });

  it('does not show a load toggle on a kafka node', () => {
    addAndSelect('kafka');
    render(<Inspector />);
    expect(screen.queryByRole('button', { name: /load source/i })).toBeNull();
  });
});
