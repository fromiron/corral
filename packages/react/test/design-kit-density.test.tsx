import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { Badge, Button, Input, Select, SizeScope, Textarea } from '../src/design-kit/index.ts';
import messages from '../src/messages/en.json' with { type: 'json' };

// The interface density reaches every kit control through the size scope (workbench.md): a
// control with no size of its own takes the scope's step, and a fixed size still wins.

type Density = 'default' | 'compact';

function inScope(density: Density, children: ReactNode) {
  return render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <SizeScope size={density}>{children}</SizeScope>
    </IntlProvider>,
  );
}

describe.each<Density>(['default', 'compact'])('in a %s scope', (density) => {
  it('a button with no size takes the scope step and says so', () => {
    inScope(density, <Button>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAttribute('data-size', density);
    expect(button).toHaveClass(density === 'compact' ? 'h-7' : 'h-9');
  });

  it('an icon button takes the scope step', () => {
    inScope(
      density,
      <Button size="icon" aria-label="Close">
        x
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Close' });
    expect(button).toHaveAttribute('data-size', density === 'compact' ? 'icon-compact' : 'icon');
    expect(button).toHaveClass(density === 'compact' ? 'h-7' : 'h-9');
  });

  it('a fixed compact button stays compact', () => {
    inScope(
      density,
      <>
        <Button size="compact">Small</Button>
        <Button size="icon-compact" aria-label="Tiny">
          x
        </Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Small' })).toHaveAttribute('data-size', 'compact');
    expect(screen.getByRole('button', { name: 'Tiny' })).toHaveAttribute(
      'data-size',
      'icon-compact',
    );
  });

  it('fields with no size take the scope step', () => {
    const { container } = inScope(
      density,
      <>
        <Input aria-label="Name" />
        <Textarea aria-label="Note" />
      </>,
    );
    expect(container.querySelector('[data-slot="input-control"]')).toHaveAttribute(
      'data-size',
      density,
    );
    expect(container.querySelector('[data-slot="textarea-control"]')).toHaveAttribute(
      'data-size',
      density,
    );
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveClass(
      density === 'compact'
        ? 'h-[calc(var(--control-height-compact)-2px)]'
        : 'h-[calc(var(--control-height)-2px)]',
    );
  });

  it('a select with no size takes the scope step', () => {
    inScope(
      density,
      <Select
        label="Mode"
        value="a"
        onValueChange={() => undefined}
        options={[{ value: 'a', label: 'A' }]}
      />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Mode' });
    expect(trigger).toHaveClass(density === 'compact' ? 'h-7' : 'h-9');
  });

  it('a badge with no size takes the scope step', () => {
    inScope(density, <Badge>New</Badge>);
    const badge = screen.getByText('New').closest('[data-slot="badge"]');
    expect(badge).toHaveClass(density === 'compact' ? 'h-5' : 'h-6');
  });
});
