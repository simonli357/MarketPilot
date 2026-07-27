# Release Gate Catalog

Activate only gates relevant to the release target.

| Gate | Evidence examples |
| --- | --- |
| Functional acceptance | End-to-end primary and failure workflows |
| Build/package/deploy | Reproducible artifact, hash, install or deployment smoke |
| Environment | Clean supported Linux/Windows setup, required native tools |
| Security/privacy | Threat review, authorization, secrets, redaction, retention |
| Data lifecycle | Migration, backup, restore, rollback, deletion |
| Performance/resources | Budgeted benchmark, load or soak, leak inspection |
| UI/accessibility | Approved viewports and states, keyboard, contrast, reduced motion |
| Operations/support | Health, logs, alerts, diagnostics, incident and rollback path |
| Documentation | Verified user, developer, operator, and command guidance |
| Human acceptance | Named unresolved choices and explicit final decision |

Every blocker needs an owner or exact external input. A warning cannot silently substitute for a required gate.
