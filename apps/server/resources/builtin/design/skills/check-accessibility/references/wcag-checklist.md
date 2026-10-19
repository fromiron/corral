# WCAG 2.2-oriented checklist

This is a focused design and interaction checklist, not the complete standard.
Use the official WCAG 2.2 Quick Reference for full criteria and techniques.

## Perceivable

### 1.1.1 Non-text Content — A

- Informative images have equivalent alternatives.
- Decorative images are ignored by assistive technology.
- Image controls have accessible names.

### 1.3.1 Info and Relationships — A

- Visual headings, lists, tables, labels, and groups are represented
  programmatically.
- Minimal visual styling does not flatten semantic structure.

### 1.3.2 Meaningful Sequence — A

- Reading and focus order preserve meaning when layout changes.

### 1.4.1 Use of Color — A

- Color is not the only way to communicate state, error, category, or action.

### 1.4.3 Contrast Minimum — AA

- Normal text: at least 4.5:1.
- Large text: at least 3:1.
- Record actual colors and measurement method.

### 1.4.10 Reflow — AA

- Content remains usable without loss or two-dimensional scrolling at the
  equivalent of 320 CSS pixels, except content that genuinely requires a
  two-dimensional layout.

### 1.4.11 Non-text Contrast — AA

- Essential component boundaries, states, and graphical information meet the
  applicable contrast requirement.

### 1.4.12 Text Spacing — AA

- User-applied text spacing does not cause loss of content or functionality.
- Treat this as a resilience test, not a prescription for the design's default
  letter spacing or line height. Evaluate default typography with the actual
  font, fallback, script, language, size, weight, role, and rendered evidence.

## Operable

### 2.1.1 Keyboard — A

- Every function is keyboard operable unless it inherently depends on a path
  of movement.

### 2.1.2 No Keyboard Trap — A

- Focus can enter and leave components using standard or documented methods.

### 2.2.2 Pause, Stop, Hide — A

- Automatically moving, blinking, scrolling, or updating content has required
  controls where applicable.

### 2.3.1 Three Flashes or Below Threshold — A

- Content does not flash above the allowed threshold.

### 2.4.1 Bypass Blocks — A

- Repeated blocks can be bypassed where applicable.

### 2.4.3 Focus Order — A

- Focus order preserves meaning and operability.

### 2.4.4 Link Purpose — A

- Link purpose is understandable in context.

### 2.4.6 Headings and Labels — AA

- Headings and labels describe their topic or purpose.

### 2.4.7 Focus Visible — AA

- Keyboard focus has a persistent visible indicator.

### 2.4.11 Focus Not Obscured Minimum — AA

- Focused components are not entirely hidden by sticky headers, overlays, or
  authored content.

### 2.5.3 Label in Name — A

- Visible control text is included in the accessible name.

### 2.5.7 Dragging Movements — AA

- Drag-only functions have a non-drag alternative unless dragging is essential.

### 2.5.8 Target Size Minimum — AA

- Pointer targets meet the minimum or an allowed exception.

## Understandable

### 3.2 Consistency

- Simplification does not make navigation or control identification
  inconsistent.

### 3.3.1 Error Identification — A

- Errors are identified in text and associated with the relevant input.

### 3.3.2 Labels or Instructions — A

- Inputs have persistent labels or necessary instructions.

### 3.3.3 Error Suggestion — AA

- Suggestions are provided when known and appropriate.

## Robust

### 4.1.2 Name, Role, Value — A

- Custom components expose accessible names, roles, states, and values.

### 4.1.3 Status Messages — AA

- Important status changes are available to assistive technology without
  moving focus unnecessarily.

## Strong project guardrail

### 2.3.3 Animation from Interactions — AAA

- Nonessential interaction motion can be disabled or reduced.
- Motion preference is supported.
- Meaning remains available without animation.

## Required manual evidence

Automated checks cannot fully establish:

- keyboard reachability and traps;
- logical reading and focus order;
- usefulness of alternative text;
- heading clarity;
- status announcement quality;
- zoom and reflow usability;
- screen-reader interaction;
- whether motion is essential.
