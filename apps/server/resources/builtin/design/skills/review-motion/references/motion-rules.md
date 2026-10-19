# Motion rules

## Essential versus nonessential

Motion is essential only when removing it would fundamentally change the
information or operation and no equivalent presentation can preserve it.

Examples that may be essential:

- previewing an animation in an animation-authoring tool;
- showing the trajectory required by a task;
- a transition whose direction is the information being taught.

Most page reveals, parallax, decorative loops, and hover flourishes are
nonessential.

## Functional motion examples

### Input feedback

A pressed state confirms activation. An instant visual state may be sufficient;
large travel is rarely required.

### State change

A panel transition can explain where content came from. In reduced motion,
replace travel with an immediate or short opacity change when appropriate.

### Causality

Moving an item into a cart may connect action and result. Preserve the updated
cart count and status text statically.

### Progress

A progress indicator conveys ongoing work. Avoid indefinite animation as the
only status; expose status semantics and text.

## Scroll

Native scrolling is user-controlled movement. Do not remap wheel, touch, or
keyboard input to forced slides or a different speed without an equivalent
path.

Scroll-triggered decoration should be removable. Content must not remain
invisible if scripts fail or motion is reduced.

## Reduced motion

Prefer a positive baseline:

```css
/* Essential state change works without motion. */
.component {
  opacity: 1;
}

@media (prefers-reduced-motion: no-preference) {
  .component[data-transitioning="true"] {
    transition: opacity 160ms ease;
  }
}
```

Do not rely only on a broad `transition: none !important` reset when an
alternative state or timing behavior is required.

## Additional checks

- Pausing, stopping, or hiding automatically moving content may be required.
- Flash thresholds require separate review.
- Motion actuation needs a conventional input alternative.
- Carousels need user control, status, labels, and keyboard operation.
- Loading skeletons should not shimmer indefinitely when a static indicator
  can serve.
