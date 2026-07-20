# Lessons

- Keep generated visual references separate from verified browser screenshots; a mockup is not runtime evidence.
- When an async click handler replaces its own DOM before bubbling completes, outside-click logic must use `event.composedPath()` instead of testing whether the detached target is still contained.
- A horizontally scrollable table can still inflate the root scroll width on mobile; verify `documentElement.scrollWidth` and explicitly clip page-level overflow while preserving scrolling on the table wrapper.
