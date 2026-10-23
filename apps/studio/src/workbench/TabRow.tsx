import { type KeyboardEvent, useRef } from 'react';

/** A WAI-ARIA tab row; arrow keys move between tabs. */
export function TabRow<T extends string>({
  id,
  label,
  values,
  current,
  text,
  onChoose,
}: {
  id: string;
  label: string;
  values: readonly T[];
  current: T;
  text: (value: T) => string;
  onChoose: (value: T) => void;
}) {
  const refs = useRef<Partial<Record<T, HTMLButtonElement | null>>>({});
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = values[(index + step + values.length) % values.length] as T;
    onChoose(next);
    refs.current[next]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="flex items-center gap-0.5">
      {values.map((value, index) => (
        <button
          key={value}
          ref={(el) => {
            refs.current[value] = el;
          }}
          type="button"
          role="tab"
          id={`${id}-${value}-tab`}
          aria-controls={current === value ? `${id}-${value}-panel` : undefined}
          aria-selected={current === value}
          tabIndex={current === value ? 0 : -1}
          onClick={() => onChoose(value)}
          onKeyDown={(event) => move(event, index)}
          className={`h-7 shrink-0 rounded-md px-2.5 text-ui transition-colors ${
            current === value
              ? 'bg-subtle font-medium text-text'
              : 'text-muted-foreground hover:text-text'
          }`}
        >
          {text(value)}
        </button>
      ))}
    </div>
  );
}
