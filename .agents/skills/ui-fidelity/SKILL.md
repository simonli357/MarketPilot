---
name: ui-fidelity
description: Implement, review, or harden an active UI block against its approved coded design system, mockups, state manifest, and shipping assets. Use for mockup-backed UI work and visual-regression fixes. Do not use to choose a visual direction or invent missing design references during implementation.
---

# UI Fidelity

Match the approved system and references, then prove the result in the running product.

## Workflow

1. Read the active work item and block, `docs/ui.md`, selected decision, coded component reference, UI manifest, relevant mockups, and asset inventory.
2. Stop and route to `$ui-design` when required tokens, states, viewports, or references are absent.
3. Map implementation to exact tokens, components, states, layout rules, breakpoints, interactions, and runtime asset paths.
4. Implement without freehand visual substitution. Record a divergence only when technically necessary and human-approved.
5. Capture the same viewports and important states named by the manifest.
6. Compare layout, hierarchy, dimensions, typography, color, spacing, assets, focus, reduced motion, and responsive behavior manually or by visual diff.
7. Fix visible drift, overlap, clipping, layout shift, fake state, and unused approved assets.
8. Record concise screenshot or diff paths and approved exceptions in the work item; keep disposable captures gitignored.
9. Run focused tests, browser or device inspection, and `npm run project:check`.

Do not close UI work from unit tests or a default desktop screenshot alone.
