# Execution Goal Contract

Define all six fields before activating a long-running block goal.

| Field | Required content |
| --- | --- |
| Outcome | Observable end state for this block and maturity level |
| Verification | Test, benchmark, runtime flow, screenshot, artifact, or inspection that proves it |
| Constraints | Behavior, data, compatibility, security, or UX that must not regress |
| Boundaries | Allowed repositories, modules, tools, services, data, and external resources |
| Iteration policy | How to choose the next experiment or fix after each result |
| Blocked stop condition | Evidence that no defensible path remains and the exact input that would unblock work |

Prefer one compact paragraph suitable for `/goal`, then store the same contract in the active block or work item for durable project context.
