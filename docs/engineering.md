# Engineering Standards

## Maintainability

- Prefer simple explicit code and framework-native patterns before custom infrastructure.
- Keep modules cohesive and public contracts small.
- Add an abstraction only for demonstrated reuse, volatility, ownership, or direct testability.
- Enforce meaningful boundaries with tests, import rules, or package visibility rather than prose alone.
- Remove obsolete paths after replacement acceptance; do not preserve hidden fallback implementations.

## Failure Policy

- Fail fast for invalid configuration, missing required credentials, impossible state, schema mismatch, corruption, and unsupported platforms.
- Represent expected external failure with typed outcomes, bounded retry only when safe, user/operator visibility, and observability.
- Never return fake success, swallow an exception without an owned recovery path, or silently downgrade a required contract.
- A fallback is allowed only when required, safe, visible, documented, and tested.

## Dependencies

- Evaluate maintained libraries or repositories before reimplementing common capabilities.
- Check license, security posture, maintenance, release cadence, platform support, bundle/runtime cost, and exit strategy.
- Avoid adapters around stable libraries unless the boundary has a concrete test, ownership, or replacement benefit.
- Pin reproducibly and automate supported update and vulnerability checks.

## Testing And Review

- Scale validation to change risk and blast radius.
- Test changed behavior and root-cause regression, not implementation trivia.
- Use integration, E2E, visual, performance, security, packaging, simulation, HIL, or manual evidence when unit tests cannot prove the outcome.
- At L3 and L4, perform an independent adversarial review when another reviewer or agent is available.
- Keep stable validation in the normal test path; retire one-off evidence scripts after graduation.

## Performance And Scalability

- Define workload, environment, baseline, budget, and regression threshold before optimization.
- Measure distributions and resource use; do not infer production performance from a single local sample.
- Prefer the simplest architecture that meets measured capacity and reliability needs.
- Add caching, concurrency, queues, distribution, or denormalization only with explicit consistency and failure semantics.

## Security And Privacy

- Model trust boundaries and attacker-controlled input for exposed or sensitive systems.
- Minimize data and privilege, redact diagnostics, and define retention and deletion.
- Keep secrets out of source, artifacts, logs, screenshots, and generated examples.

## Cross-Platform Development

- Pin shared runtimes and automate clean setup.
- Use containers for shared services and CI parity when useful.
- Validate native SDKs, GUI behavior, hardware, signing, installers, and OS integration on their target hosts.

## Commits And Integration

- Use an imperative subject in the form `[type][WI-123] Describe the outcome`; omit the work-item tag only when no work item exists.
- Use one of `[feat]`, `[fix]`, `[test]`, `[docs]`, `[refactor]`, `[perf]`, `[security]`, `[build]`, `[ci]`, `[chore]`, or `[release]` as the first tag.
- Keep each commit coherent and validated. Do not mix unrelated cleanup, generated evidence, or user changes.
- Push coherent checkpoints when a remote exists; a successful push is not a documentation event.
