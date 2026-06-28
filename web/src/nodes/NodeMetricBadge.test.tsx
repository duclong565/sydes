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
  it('renders a writes line with delta for a db metric', () => {
    render(<NodeMetricBadge metric={{ cpuPercent: 5, memMB: 50, writes: 1234, writesPerSec: 402 }} />);
    expect(screen.getByText(/1,234 writes/)).toBeInTheDocument();
    expect(screen.getByText(/\+402\/s/)).toBeInTheDocument();
  });
  it('omits the delta on the first tick (writesPerSec undefined)', () => {
    render(<NodeMetricBadge metric={{ cpuPercent: 5, memMB: 50, writes: 1234 }} />);
    expect(screen.getByText(/1,234 writes/)).toBeInTheDocument();
    expect(screen.queryByText(/\/s/)).toBeNull();
  });
  it('renders no writes line for a non-db metric', () => {
    render(<NodeMetricBadge metric={{ cpuPercent: 5, memMB: 50 }} />);
    expect(screen.queryByText(/writes/)).toBeNull();
  });
});
