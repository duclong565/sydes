import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Drawer } from './Drawer.js';

const status = {
  runId: 'saga', state: 'running' as const,
  services: [{ name: 'order-service', state: 'running', health: undefined }],
};
const metrics = [{ service: 'order-service', cpuPercent: 12, memMB: 48 }];

describe('Drawer', () => {
  it('shows compose content when open on the compose tab', () => {
    render(<Drawer open tab="compose" onToggle={() => {}} onSelectTab={() => {}} compose="services: {}" status={null} logs="" metrics={[]} lastLoad={null} />);
    expect(screen.getByText(/services:/)).toBeInTheDocument();
  });

  it('hides pane content when collapsed', () => {
    render(<Drawer open={false} tab="compose" onToggle={() => {}} onSelectTab={() => {}} compose="services: {}" status={null} logs="" metrics={[]} lastLoad={null} />);
    expect(screen.queryByText(/services:/)).toBeNull();
  });

  it('calls onSelectTab when the Status tab is clicked', async () => {
    const onSelectTab = vi.fn();
    render(<Drawer open tab="compose" onToggle={() => {}} onSelectTab={onSelectTab} compose="" status={status} logs="" metrics={[]} lastLoad={null} />);
    await userEvent.click(screen.getByRole('button', { name: 'Status' }));
    expect(onSelectTab).toHaveBeenCalledWith('status');
  });

  it('renders the service rows on the status tab', () => {
    render(<Drawer open tab="status" onToggle={() => {}} onSelectTab={() => {}} compose="" status={status} logs="" metrics={[]} lastLoad={null} />);
    expect(screen.getByText('order-service')).toBeInTheDocument();
  });

  it('renders log lines on the logs tab', () => {
    render(<Drawer open tab="logs" onToggle={() => {}} onSelectTab={() => {}} compose="" status={null} logs="worker | consumed 1" metrics={[]} lastLoad={null} />);
    expect(screen.getByText(/consumed 1/)).toBeInTheDocument();
  });

  it('renders metric rows on the metrics tab and lets you select it', async () => {
    const onSelectTab = vi.fn();
    render(<Drawer open tab="metrics" onToggle={() => {}} onSelectTab={onSelectTab} compose="" status={null} logs="" metrics={metrics} lastLoad={null} />);
    expect(screen.getByText('order-service')).toBeInTheDocument();
    expect(screen.getByText(/48/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Metrics' }));
    expect(onSelectTab).toHaveBeenCalledWith('metrics');
  });

  it('renders a per-target results table with a total and highlights saturated rows', () => {
    const lastLoad = {
      perTarget: [
        { slug: 'gateway', targetRps: 200, achievedRps: 200, requests: 2000, dropped: 0, errorRate: 0.002, latencyAvgMs: 9, latencyP95Ms: 18, latencyMaxMs: 61 },
        { slug: 'checkout', targetRps: 50, achievedRps: 38, requests: 380, dropped: 120, errorRate: 0.014, latencyAvgMs: 22, latencyP95Ms: 40, latencyMaxMs: 96 },
      ],
      total: { requests: 2380, targetRps: 250, achievedRps: 238, dropped: 120, errorRate: 0.005 },
    };
    render(<Drawer open tab="metrics" onToggle={() => {}} onSelectTab={() => {}} compose="" status={null} logs="" metrics={[]} lastLoad={lastLoad as any} />);
    expect(screen.getByText('checkout')).toBeInTheDocument();
    expect(screen.getAllByText(/120/).length).toBeGreaterThan(0); // dropped (appears in row + total)
    expect(screen.getByText('total')).toBeInTheDocument();
    const row = screen.getByText('checkout').closest('tr')!;
    expect(row.className).toMatch(/orange|amber|bg-/);          // saturated highlight
  });
  it('renders Writes and Δ columns for a db row, — for a non-db row', () => {
    const m = [
      { service: 'order-service', cpuPercent: 12, memMB: 48 },
      { service: 'db-1', cpuPercent: 17, memMB: 97, writes: 208803, writesPerSec: 402 },
    ];
    render(<Drawer open tab="metrics" onToggle={() => {}} onSelectTab={() => {}} compose="" status={null} logs="" metrics={m} lastLoad={null} />);
    expect(screen.getByText(/208,803/)).toBeInTheDocument();
    expect(screen.getByText(/\+402/)).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0); // non-db writes/Δ cells
  });
});
