# Capability Blocks

A block is an epic-sized product or technical capability with its own requirements, boundary, architecture, implementation blueprint, validation, and maturity. Examples are identity, catalog, synchronization, import/export, rendering, or device control. Create only blocks the project actually needs.

## Rules

- Map every active-release requirement to one block, a bounded spike, or an explicit deferral in `docs/product.md`.
- Keep cross-block decisions in `docs/architecture.md`; keep capability-specific contracts and implementation detail in its block.
- Detail the current block and immediate horizon. Future blocks need only purpose, requirements, dependencies, and major risks.
- Before a current block reaches L2, map each local requirement to a work item, spike, or explicit deferral. The checker rejects a block whose leaf plan cannot cover its claimed function.
- Advance maturity only when the stated proof exists: L1 walking skeleton, L2 functional completeness, L3 production hardening, L4 release proof.
- Execute through files in `docs/work-items/`; the block is the epic, so do not put a second epic or task list inside it.

Copy `BLOCK-template.md` to `BLK-<slug>.md`, replace every placeholder, and delete instructional text that no longer helps.
