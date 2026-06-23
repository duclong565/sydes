import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Drawer } from './Drawer.js';

const status = {
  runId: 'saga', state: 'running' as const,
  services: [{ name: 'order-service', state: 'running', health: undefined }],
};

describe('Drawer', () => {
  it('shows compose content when open on the compose tab', () => {
    render(<Drawer open tab="compose" onToggle={() => {}} onSelectTab={() => {}} compose="services: {}" status={null} logs="" />);
    expect(screen.getByText(/services:/)).toBeInTheDocument();
  });

  it('hides pane content when collapsed', () => {
    render(<Drawer open={false} tab="compose" onToggle={() => {}} onSelectTab={() => {}} compose="services: {}" status={null} logs="" />);
    expect(screen.queryByText(/services:/)).toBeNull();
  });

  it('calls onSelectTab when the Status tab is clicked', async () => {
    const onSelectTab = vi.fn();
    render(<Drawer open tab="compose" onToggle={() => {}} onSelectTab={onSelectTab} compose="" status={status} logs="" />);
    await userEvent.click(screen.getByRole('button', { name: 'Status' }));
    expect(onSelectTab).toHaveBeenCalledWith('status');
  });

  it('renders the service rows on the status tab', () => {
    render(<Drawer open tab="status" onToggle={() => {}} onSelectTab={() => {}} compose="" status={status} logs="" />);
    expect(screen.getByText('order-service')).toBeInTheDocument();
  });

  it('renders log lines on the logs tab and lets you select it', async () => {
    const onSelectTab = vi.fn();
    render(<Drawer open tab="logs" onToggle={() => {}} onSelectTab={onSelectTab} compose="" status={null} logs="worker | consumed 1" />);
    expect(screen.getByText(/consumed 1/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Logs' }));
    expect(onSelectTab).toHaveBeenCalledWith('logs');
  });
});
