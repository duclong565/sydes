import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Palette } from './Palette.js';
import { useGraphStore } from './store.js';

beforeEach(() => {
  useGraphStore.setState({ experimentId: 'untitled', nodes: [], edges: [], selectedId: null });
});

describe('Palette', () => {
  it('renders a button per node type', () => {
    render(<Palette />);
    for (const name of ['Service', 'Kafka', 'Worker', 'DB', 'LB']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('clicking a palette button adds a node of that type', async () => {
    render(<Palette />);
    await userEvent.click(screen.getByRole('button', { name: 'Worker' }));
    const { nodes } = useGraphStore.getState();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.data.type).toBe('worker');
  });
});
