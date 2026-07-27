# UI Contract

This owner is active when `project/profile.json` sets `capabilities.ui` to `true`. For `auto`, planning must choose before UI work.

## Headless First Gate

- Prove the core behavior through a service boundary, CLI, test harness, or other non-final interface before committing to the final visual implementation.
- If the product cannot be meaningfully separated from its UI, use the thinnest unstyled interface that can exercise real behavior and failure states.
- Manually exercise the L1 flow and feed observed constraints back into product, architecture, and block planning.
- Headless-first does not mean UI-last: resolve flows and states early, then perform final visual implementation only after the selected coded design system is ready.

## Product States

| Surface/flow | Required states | Data/permission source | Block |
| --- | --- | --- | --- |
|  | Empty, loading, ready, stale, degraded, offline, denied, error |  |  |

## Direction Gate

`assets/ui-concepts/ui-manifest.json` is the only owner of direction state, option references, human selection, exact coded component reference, surface inventory, asset use, and fidelity exceptions. Do not copy those values here.

When direction is unresolved, produce exactly two complete options. When brand or a human decision already resolves direction, record that and use one direction.

## Interaction And Accessibility

- Keyboard and focus:
- Screen reader and labels:
- Contrast and non-color state cues:
- Touch targets and compact layouts:
- Motion and reduced motion:
- Destructive and permission-sensitive actions:

## Fidelity Policy

- Generated mockups define approved composition and visual intent.
- Exact coded tokens and component gallery define implementable component values and states.
- Each active UI block must name screen, state, modal, configuration, and responsive references before implementation.
- Capture matching viewports, inspect drift, fix defects, and record human-approved exceptions.
- Every approved shipping asset must be used or explicitly replaced or deferred.
