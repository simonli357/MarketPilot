# Asset Acceptance

Reject an asset when any applicable condition is true:

- Neighboring subjects, sheet gutters, labels, crop seams, or unrelated objects remain.
- Borders, shadows, limbs, titles, or important subject details are clipped.
- Identity, state, iconography, perspective, lighting, or palette contradicts the selected design.
- Text is misspelled, nonsensical, illegible, or better represented as live UI text.
- Transparent assets have opaque corners, key-color fringe, or excessive padding.
- Resolution is visibly upscaled or insufficient at the largest runtime size.
- The runtime manifest or code does not consume the final file.
- A familiar symbol was generated as an inconsistent bitmap despite an approved icon library.

Acceptance requires runtime use, automated path/format checks, and visual inspection at intended desktop and compact sizes when both apply.
