# Retained Release Evidence

Create `<version>/manifest.json` from `manifest-template.json` only when preparing a real release. Each entry must identify the gate, artifact path or external reference, creation command or method, environment, timestamp, and content hash for a local artifact. The checker verifies local hashes and rejects unowned gates.
