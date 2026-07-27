# Machine-Readable Project State

- `profile.json`: activated platform, capability, and risk profile.
- `release.json`: only mutable planning-approval, release-gate, and release-decision owner.
- `template.json`: template provenance.
- `template-contract.json`: protected template behavior.
- `migrations/`: non-destructive migration maps.

Edit these files through deliberate planning or release work. Routine implementation should not churn them.
