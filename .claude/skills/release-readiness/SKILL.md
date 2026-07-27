---
name: release-readiness
description: Produce an evidence-backed go or no-go for a named release, package, deployment, demo, or handoff. Use only when a release target is being prepared or audited. Do not use for routine task completion, module-level functional checks, or speculative future releases.
---

# Release Readiness

Treat `project/release.json` as canonical release state and attempt to invalidate readiness.

## Workflow

1. Name the release target and required maturity.
2. Read `project/release.json`, `docs/product.md`, `docs/quality.md`, required block states, relevant guides, and retained release evidence manifests.
3. Check each activated gate against current evidence; historical or stale evidence cannot close a changed outcome.
4. Verify clean setup, configuration and secret failure, primary workflows, important failure paths, package/deploy behavior, rollback or cleanup, and user/operator documentation.
5. Inspect runtime and UI manually where automation is incomplete.
6. Record `go`, `no-go`, or `conditional` only in `project/release.json`, with blockers, approved deferrals, and evidence paths.
7. Regenerate status and run `npm run project:check`.

Use `references/release-gates.md` to select gates by release type. Never declare readiness from test counts alone.
