# UI Concepts And Fidelity

This directory is active when `project/profile.json` enables UI. `ui-manifest.json` is the machine-readable gate; `docs/ui.md` owns the global interaction contract.

## Sequence

1. Build and exercise a thin headless or minimally styled L1 flow first when the product has separable core behavior. Do not postpone core correctness behind visual polish.
2. Inventory every active-release surface, major state, modal, configuration, viewport, permission, and failure mode in the manifest.
3. If direction is unresolved, use `$ui-design` and the image generation skill to create exactly two coherent options under `option-a/` and `option-b/`. Each option needs its own theme, representative mockups, and complete exact design-system proposal.
4. Ask the human to choose. Record the selection and do not combine options unless the human explicitly approves a new composite direction.
5. Translate the selected direction into semantic code tokens and an executable component gallery covering all components, variants, states, responsive behavior, motion, and accessibility. This coded gallery is the exact component reference; mockups remain the composition reference.
6. Before each UI block, add just-in-time references for all pages, states, modals, configurations, and responsive layouts the block will implement.
7. Generate suitable shipping raster assets one file at a time with `$visual-assets`. Use maintained icon libraries and code-native controls for familiar interface symbols.
8. Implement with `$ui-fidelity`. Capture the same viewports and states as the references, compare them manually or with visual diff, fix material drift, and record only human-approved exceptions.

## Non-Negotiable Gate

Final visual implementation cannot begin until the manifest names:

- a human-selected direction;
- exact semantic color, typography, spacing, radius, elevation, layout, and breakpoint values;
- an executable component-gallery command and path;
- references for the active block's surfaces and states;
- an asset inventory with intended use;
- validation viewports and allowed tolerances.

“Inspired by,” approximate styling, test success, or a partial token list does not satisfy fidelity. The implementation is accepted only when runtime inspection matches the approved composition and coded design system, or every material difference has explicit human approval.

## Asset Rules

- Generate each logo, illustration, texture, sprite, or other custom raster as its own correctly sized asset. Never generate one combined sheet and crop it into unrelated assets.
- Do not ask image generation to recreate familiar interface icons when a maintained icon system exists.
- Record file path, dimensions, purpose, source prompt or provenance, license when external, and implementation location.
- Every approved asset must be used, replaced with approval, or explicitly deferred. Unused generated assets are not completion evidence.
- Keep exploratory images under option folders. Move selected shipping assets to the product's normal asset directory and retain manifest traceability.
