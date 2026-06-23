import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { Canvas } from './Canvas.js';
import { useGraphStore } from './store.js';

beforeEach(() => {
  useGraphStore.setState({ experimentId: 'untitled', nodes: [], edges: [], selectedId: null });
});

describe('Canvas', () => {
  it('mounts the React Flow surface without throwing', () => {
    const { container } = render(<Canvas />);
    expect(container.querySelector('.react-flow')).not.toBeNull();
  });
});
