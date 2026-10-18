"""d402 agent client for Python. See client.py for the full surface."""

from .client import (  # noqa: F401
    HEADERS,
    SIGN_PREFIX,
    WELL_KNOWN_PATH,
    D402Client,
    D402Error,
    FileVoucherCache,
    Keypair,
    MemoryVoucherCache,
    StoredVoucher,
    b64u,
    build_classify_prompt,
    canonical_json,
    find_d402_accept,
    from_b64u,
    llm_solver,
    new_nonce,
    lookup_solver,
    parse_classify_answers,
    scope_matches,
    sign_bytes,
    sign_spend,
    sign_submit,
    smallest_tier,
    spend_message,
    submit_message,
    verify_bytes,
    verify_spend,
    verify_submit,
)

__version__ = "0.1.0"
