---
name: visual-assets
description: Generate, refine, validate, and integrate custom raster assets that will ship in a product UI. Use for illustrations, textures, sprites, product imagery, branded scenes, or other bitmap assets suited to image generation. Do not use for familiar UI icons, code-native vectors, text-heavy controls, or assets already available from an approved library or brand source.
---

# Visual Assets

Generate each shipping subject as a standalone file and prove the application actually uses it.

## Workflow

1. Read the active work item, selected visual direction, asset inventory, consuming runtime path, dimensions, format, transparency, and responsive use.
2. Confirm image generation is preferable to an existing brand asset, maintained library, icon system, vector, CSS, canvas, or 3D source.
3. Generate a style sheet only as a non-shipping reference when useful.
4. Generate each distinct shipping logo, illustration, texture, sprite, product image, or state asset one by one. Never crop shipping assets from a generated multi-asset sheet without explicit human approval.
5. Inspect identity, edges, text, alpha, padding, resolution, crop, state meaning, and consistency using `references/asset-acceptance.md`.
6. Store the final asset at the runtime path, update the inventory and manifest, and reference it from implementation code.
7. Capture it in the running UI at intended sizes. Contact sheets may support inspection but are not runtime sources.
8. Reject or regenerate defects; do not hide them with CSS cropping or fallback imagery.
9. Record lineage and focused validation in the work item.
