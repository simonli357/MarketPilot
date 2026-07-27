---
name: ui-design
description: Create or repair an implementation-ready visual direction, exact design system, UI state manifest, and human selection. Use before final UI implementation when visual direction is unresolved or references are incomplete. Do not use for routine UI coding against an already approved system or for projects without a visual interface.
---

# UI Design

Turn product states into exact visual implementation inputs, not inspirational screenshots.

## Workflow

1. Confirm the core flow has been exercised headlessly or through a thin unstyled L1 interface, and that the active UI block has real flows, states, permissions, errors, responsive targets, and data contracts.
2. If direction is unresolved, use the image generation skill to create exactly two complete visual directions. If an existing brand or human decision resolves direction, document that and create one implementation direction.
3. Give each option theme notes, representative mockups, a complete design system, state coverage, responsive targets, and an asset inventory.
4. Apply every requirement in `references/design-system-gate.md`. Reject vague token values and image-only systems.
5. Ask the human to select a direction before final UI implementation.
6. Translate the selected option into code-level tokens and an executable component gallery. Treat that gallery as the exact component reference; retain mockups as composition and visual acceptance targets.
7. Fill `assets/ui-concepts/ui-manifest.json` with active screens, states, viewports, references, and required assets.
8. Create detailed screen references just in time for the active UI block.
9. Record selection as a decision and run `npm run project:check`.

Use `$visual-assets` for shipping raster assets. Prefer maintained icon libraries and code-native controls for familiar symbols.
