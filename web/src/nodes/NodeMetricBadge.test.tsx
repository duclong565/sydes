import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NodeMetricBadge } from './NodeMetricBadge.js';

describe('NodeMetricBadge', () => {
  it('renders nothing without a metric', () => {
    const { container } = render(<NodeMetricBadge metric={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('renders cpu and mem', () => {
    render(<NodeMetricBadge metric={{ cpuPercent: 12.4, memMB: 48.9 }} />);
    expect(screen.getByText(/cpu 12%/i)).toBeInTheDocument();
    expect(screen.getByText(/49MB/)).toBeInTheDocument();
  });
});
