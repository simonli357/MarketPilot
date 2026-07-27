# Evidence Artifacts

- `artifacts/work/` is ignored and holds disposable screenshots, logs, traces, reports, and experiments.
- `artifacts/releases/<version>/manifest.json` may retain only evidence required for a release decision.
- Promote recurring checks into tests or CI, then remove redundant task-specific evidence scripts.
- Keep retained evidence within the budget in `project/release.json`. Use Git LFS or approved external storage for large binaries; never commit secrets or sensitive production data.
