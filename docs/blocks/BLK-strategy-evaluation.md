---
id: BLK-strategy-evaluation
title: Frozen strategies and forward qualification
status: proposed
maturity: L0
release: V1
requirements: ["FR-003", "FR-006", "FR-007", "IR-002", "QR-001", "QR-002", "SFR-001"]
depends_on: ["BLK-agent-runtime", "BLK-market-intelligence"]
ui: false
---

# Frozen Strategies And Forward Qualification

## Outcome

MarketPilot can run immutable position, swing, and deterministic intraday candidates in paper/shadow mode, measure them under conservative economics, and make each cadence live-eligible only through its independent forward gate. Reflection may suggest a new candidate but cannot change or promote the active one.

## Requirements

| ID | Requirement | Priority | Important failure or edge | Work item, spike, or deferral | Verification |
| --- | --- | --- | --- | --- | --- |
| BLK-strategy-evaluation-R001 | Seed position quality+catalyst, swing trend+event, and deterministic long opening-range-breakout candidates. | Must | Strategy mixing can conceal cadence-specific risk and evidence. | Future work item at block activation | Frozen manifests and deterministic fixtures. |
| BLK-strategy-evaluation-R002 | Maintain independent paper, shadow, benchmark, costs, evidence windows, failures, and live eligibility per candidate/cadence. | Must | Optimistic fills, best-trade dependence, sparse activity, and configuration drift create false confidence. | Future work item at block activation | Forward qualification state-machine tests and manual evidence audit. |
| BLK-strategy-evaluation-R003 | Isolate at most two live sleeves with fixed allocation, no borrowing, cross-sleeve netting, or overlapping symbols. | Must | Shared symbols or capital can invalidate attribution and limits. | Future work item at block activation | Property and scenario tests. |
| BLK-strategy-evaluation-R004 | Paper-test four allowed option strategies without 0DTE or live V1 eligibility. | Should | Capital, lot size, assignment/exercise, tax, and expiry risk are unresolved. | Live options deferred beyond V1 | Paper contracts and explicit live-ineligible state. |

## Boundary

- Owns: strategy manifests, deterministic parameters/workers, candidate registry, paper simulator inputs, shadow ledger, performance attribution, reflection artifacts, and qualification state.
- Does not own: source licensing, model runtime, account ledger, risk/order authority, or user authorization.
- Inputs and outputs: normalized evidence, agent intents, and market snapshots in; candidate decisions, target exposures, evaluation events, and `QualificationRecord` out.
- Dependencies: qualified agent and market-intelligence contracts.

## Contracts And Failure

A candidate hashes every decision-affecting model, skill, strategy, universe, pricing, cost, risk, and data policy. Loosening any boundary creates a new candidate and disarms it. Forward episodes are flat-to-flat; decisions are nonduplicate evidence-complete material checkpoints. Missing data, safety failure, exceeded maximum window, or inconsistent shadow/broker state fails the candidate visibly.

## Architecture

Codex authors position and swing intents. Intraday execution is a frozen deterministic worker that Codex may select/configure but cannot improvise mid-run. Paper and shadow ledgers share order contracts but not optimistic fills. Qualification consumes immutable evidence and cannot be written by reflection or the UI.

## Implementation Blueprint

Begin with position strategy and the common candidate/evaluation state machine, then swing, then deterministic intraday. Add paper options only after equity L2. Use forward observations and deterministic fixtures for correctness; do not claim research-grade historical validation.

## Maturity Criteria

### L1 Walking Skeleton

- [ ] One frozen position candidate produces an intent, conservative simulated fill, flat-to-flat episode, and updated qualification record.
- [ ] A configuration change creates a distinct unqualified candidate.

### L2 Functional

- [ ] Position, swing, intraday, and four paper-option strategies expose all required states, costs, benchmarks, and failures.
- [ ] Cadence-specific forward gates and isolated sleeves are complete.

### L3 Hardened

- [ ] Long soaks, corrections, corporate actions, benchmark integrity, reproducibility, diagnostics, and adversarial evaluation review pass.
- [ ] Position evidence qualifies before any micro-live authorization.

## Validation

| Outcome or risk | Method | Environment | Evidence |
| --- | --- | --- | --- |
| Candidate immutability | Hash/property/state-machine tests | Deterministic fixtures | Normal regression suite |
| Economic gate is conservative | Paper versus shadow comparisons including fees, spreads, fractional costs, and best-result removal | Forward paper sessions | Qualification record |
| Cadences remain isolated | Mixed-strategy and restart scenarios | Simulator and later IBKR paper | Sleeve invariant evidence |

## Known Gaps

- Exact leaf strategy parameters are intentionally deferred until this block becomes current and the common L1 contract exists.
- Live options require a later capital, account-permission, tax, assignment/exercise, expiry, and evidence plan.
