import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RunBadge } from './RunBadge.js';

describe('RunBadge', () => {
  it('renders nothing when state is null', () => {
    const { container } = render(<RunBadge state={null} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('shows warming up for starting', () => {
    render(<RunBadge state="starting" />);
    expect(screen.getByText(/warming up/i)).toBeInTheDocument();
  });
  it('shows the error message for error state', () => {
    render(<RunBadge state="error" error="boom" />);
    expect(screen.getByText(/boom/)).toBeInTheDocument();
  });
});
