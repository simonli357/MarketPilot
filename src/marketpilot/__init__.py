"""MarketPilot's small, dependency-free paper-authority boundary.

Imports are lazy so ``python -m marketpilot.paper_fixture_authority`` does not
load its target module twice (which would produce a runtime warning on stderr,
violating the one-line protocol).
"""

__all__ = ["PROFILE", "POLICY_ID", "InputContractError", "canonical_json_bytes", "compute_hash", "evaluate_request", "verify_response"]


def __getattr__(name: str):
    if name in __all__:
        from . import paper_fixture_authority

        return getattr(paper_fixture_authority, name)
    raise AttributeError(name)
