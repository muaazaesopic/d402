"""
Minimal d402 agent client (spec/SPEC.md sections 2-7.1), Python edition.

Dependencies: the standard library, `cryptography` (Ed25519) and `requests`.

The on-disk formats are shared with the TypeScript client (packages/client):

- keypair file: ``{"publicKey": <b64url 32 bytes>, "privateKey": <b64url 32-byte seed>}``
- voucher cache: ``{"version": 1, "vouchers": [StoredVoucher, ...]}`` in ``<dir>/vouchers.json``

so one identity and one voucher cache can be used from both languages.
"""

from __future__ import annotations

import base64
import json
import os
import re
import stat
import tempfile
import time
from dataclasses import dataclass, asdict
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode, quote

import requests
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.exceptions import InvalidSignature

__all__ = [
    "D402Error",
    "Keypair",
    "HEADERS",
    "WELL_KNOWN_PATH",
    "SIGN_PREFIX",
    "b64u",
    "from_b64u",
    "canonical_json",
    "submit_message",
    "spend_message",
    "sign_bytes",
    "verify_bytes",
    "sign_submit",
    "verify_submit",
    "sign_spend",
    "verify_spend",
    "new_nonce",
    "find_d402_accept",
    "smallest_tier",
    "scope_matches",
    "StoredVoucher",
    "MemoryVoucherCache",
    "FileVoucherCache",
    "lookup_solver",
    "llm_solver",
    "build_classify_prompt",
    "parse_classify_answers",
    "D402Client",
]

# --- constants (packages/spec/src/constants.ts) -----------------------------

HEADERS = {
    "key": "D402-Key",
    "voucher": "D402-Voucher",
    "model": "D402-Model",
    "timestamp": "D402-Timestamp",
    "sig": "D402-Sig",
    "nonce": "D402-Nonce",
    "callsRemaining": "D402-Calls-Remaining",
}
WELL_KNOWN_PATH = "/.well-known/d402"
SIGN_PREFIX = {"submit": "d402:submit", "spend": "d402:spend"}

_VOUCHER_EVICT_ERRORS = {"voucher_exhausted", "voucher_expired", "voucher_invalid"}


class D402Error(Exception):
    """Protocol-level failure. Never raised for an ordinary non-2xx from a gated route."""

    def __init__(self, code: str, message: str, status: int = 0, body: Any = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.body = body

    def __str__(self) -> str:  # pragma: no cover - cosmetic
        return f"{self.code}: {self.message}" + (f" (HTTP {self.status})" if self.status else "")


# --- base64url and canonical JSON ------------------------------------------


def b64u(data: bytes) -> str:
    """base64url without padding, as Node's `base64url` encoding produces."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def from_b64u(s: str) -> bytes:
    s = s.strip()
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def canonical_json(value: Any) -> str:
    """JSON with object keys sorted recursively and no whitespace.

    Byte-identical to `canonicalJSON` in packages/spec/src/canonical.ts for the
    JSON value space (strings, ints, bools, null, lists, dicts).
    """
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


# --- keys and signatures (packages/spec/src/crypto.ts) ---------------------


@dataclass
class Keypair:
    """Ed25519 identity. `public_key` is the agent's identity on the wire (D402-Key)."""

    publicKey: str
    privateKey: str

    @property
    def public_key(self) -> str:
        return self.publicKey

    @property
    def private_key(self) -> str:
        return self.privateKey

    @classmethod
    def generate(cls) -> "Keypair":
        priv = Ed25519PrivateKey.generate()
        return cls.from_private_key(_raw_private(priv))

    @classmethod
    def from_private_key(cls, private_key: str | bytes) -> "Keypair":
        seed = private_key if isinstance(private_key, bytes) else from_b64u(private_key)
        if len(seed) != 32:
            raise D402Error("bad_keyfile", "private key must be 32 bytes")
        priv = Ed25519PrivateKey.from_private_bytes(seed)
        pub = priv.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        return cls(publicKey=b64u(pub), privateKey=b64u(seed))

    @classmethod
    def load(cls, path: str) -> "Keypair":
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError) as e:
            raise D402Error("bad_keyfile", f"could not parse keypair file {path}: {e}")
        if not isinstance(data, dict) or not isinstance(data.get("publicKey"), str) or not isinstance(data.get("privateKey"), str):
            raise D402Error("bad_keyfile", f"keypair file {path} is not a valid {{publicKey, privateKey}}")
        try:
            kp = cls.from_private_key(data["privateKey"])
        except Exception as e:  # noqa: BLE001
            raise D402Error("bad_keyfile", f"keypair file {path} has an invalid private key: {e}")
        if kp.publicKey != data["publicKey"]:
            raise D402Error("bad_keyfile", f"keypair file {path}: public key does not match the private key")
        return kp

    @classmethod
    def load_or_create(cls, path: str) -> "Keypair":
        """Load {publicKey, privateKey} from `path`, or generate one and write it (mode 0600)."""
        path = os.path.expanduser(path)
        if os.path.exists(path):
            return cls.load(path)
        kp = cls.generate()
        kp.save(path)
        return kp

    def save(self, path: str) -> None:
        path = os.path.expanduser(path)
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        text = json.dumps({"publicKey": self.publicKey, "privateKey": self.privateKey}, indent=2) + "\n"
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        try:
            os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
        except OSError:
            pass

    def to_dict(self) -> Dict[str, str]:
        return {"publicKey": self.publicKey, "privateKey": self.privateKey}


def _raw_private(priv: Ed25519PrivateKey) -> bytes:
    return priv.private_bytes(
        serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()
    )


def _private_key_object(private_key: str) -> Ed25519PrivateKey:
    seed = from_b64u(private_key)
    if len(seed) != 32:
        raise D402Error("bad_key", "private key must be 32 bytes")
    return Ed25519PrivateKey.from_private_bytes(seed)


def _public_key_object(public_key: str) -> Ed25519PublicKey:
    raw = from_b64u(public_key)
    if len(raw) != 32:
        raise D402Error("bad_key", "public key must be 32 bytes")
    return Ed25519PublicKey.from_public_bytes(raw)


def is_valid_public_key(public_key: str) -> bool:
    try:
        _public_key_object(public_key)
        return True
    except Exception:  # noqa: BLE001
        return False


def sign_bytes(private_key: str, message: bytes | str) -> str:
    msg = message.encode("utf-8") if isinstance(message, str) else message
    return b64u(_private_key_object(private_key).sign(msg))


def verify_bytes(public_key: str, message: bytes | str, sig: str) -> bool:
    try:
        msg = message.encode("utf-8") if isinstance(message, str) else message
        _public_key_object(public_key).verify(from_b64u(sig), msg)
        return True
    except (InvalidSignature, ValueError, D402Error):
        return False


def submit_message(bundle_id: str, answers: Dict[str, str]) -> str:
    """SPEC 5: "d402:submit\\n" + bundleId + "\\n" + canonicalJSON(answers)."""
    return f"{SIGN_PREFIX['submit']}\n{bundle_id}\n{canonical_json(answers)}"


def sign_submit(private_key: str, bundle_id: str, answers: Dict[str, str]) -> str:
    return sign_bytes(private_key, submit_message(bundle_id, answers))


def verify_submit(public_key: str, bundle_id: str, answers: Dict[str, str], sig: str) -> bool:
    return verify_bytes(public_key, submit_message(bundle_id, answers), sig)


def spend_message(method: str, path: str, jti: str, timestamp: int, nonce: Optional[str] = None) -> str:
    """SPEC 7.1: "d402:spend\\n" + METHOD + "\\n" + path + "\\n" + jti + "\\n" + timestamp.

    With a `nonce` (SPEC 7.2) it is appended as a 6th line; without one the 5-line form is used.
    """
    base = f"{SIGN_PREFIX['spend']}\n{method.upper()}\n{path}\n{jti}\n{int(timestamp)}"
    return base if nonce is None else f"{base}\n{nonce}"


def sign_spend(private_key: str, method: str, path: str, jti: str, timestamp: int, nonce: Optional[str] = None) -> str:
    return sign_bytes(private_key, spend_message(method, path, jti, timestamp, nonce))


def verify_spend(
    public_key: str, method: str, path: str, jti: str, timestamp: int, sig: str, nonce: Optional[str] = None
) -> bool:
    return verify_bytes(public_key, spend_message(method, path, jti, timestamp, nonce), sig)


def new_nonce() -> str:
    """16 random bytes, base64url: the recommended D402-Nonce value (SPEC 7.2)."""
    return b64u(os.urandom(16))


# --- offers, tiers, scopes --------------------------------------------------


def find_d402_accept(offer: Any) -> Optional[Dict[str, Any]]:
    """The first `accepts` entry with scheme "d402" that has the fields SPEC 3 requires."""
    if not isinstance(offer, dict) or offer.get("d402") != "1" or not isinstance(offer.get("accepts"), list):
        return None
    for a in offer["accepts"]:
        if (
            isinstance(a, dict)
            and a.get("scheme") == "d402"
            and isinstance(a.get("sellerId"), str)
            and isinstance(a.get("taskUrl"), str)
            and isinstance(a.get("scope"), list)
            and isinstance(a.get("tiers"), list)
            and a["tiers"]
        ):
            return a
    return None


def smallest_tier(accept: Dict[str, Any]) -> str:
    best = accept["tiers"][0]
    for t in accept["tiers"]:
        if t["items"] < best["items"]:
            best = t
    return best["id"]


def scope_matches(scope: List[str], path: str) -> bool:
    return any(path.startswith(prefix) for prefix in scope)


# --- voucher cache (packages/client/src/cache.ts) ---------------------------


@dataclass
class StoredVoucher:
    jti: str
    sellerId: str
    token: str
    scope: List[str]
    calls: int
    expiresAt: int
    sub: str
    taskUrl: str

    def usable(self, seller_id: str, path: str, now: int) -> bool:
        return self.sellerId == seller_id and self.calls > 0 and self.expiresAt > now and scope_matches(self.scope, path)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "StoredVoucher":
        return cls(
            jti=d["jti"],
            sellerId=d.get("sellerId", ""),
            token=d.get("token", ""),
            scope=list(d.get("scope", [])),
            calls=int(d.get("calls", 0)),
            expiresAt=int(d.get("expiresAt", 0)),
            sub=d.get("sub", ""),
            taskUrl=d.get("taskUrl", ""),
        )


def _pick_best(candidates: List[StoredVoucher]) -> Optional[StoredVoucher]:
    # Prefer the voucher that expires soonest so nothing goes to waste.
    best = None
    for v in candidates:
        if best is None or v.expiresAt < best.expiresAt:
            best = v
    return best


class MemoryVoucherCache:
    def __init__(self) -> None:
        self._v: Dict[str, StoredVoucher] = {}

    def list(self) -> List[StoredVoucher]:
        return [StoredVoucher.from_dict(v.to_dict()) for v in self._v.values()]

    def find(self, seller_id: str, path: str, now: int) -> Optional[StoredVoucher]:
        return _pick_best([v for v in self._v.values() if v.usable(seller_id, path, now)])

    def put(self, v: StoredVoucher) -> None:
        self._v[v.jti] = StoredVoucher.from_dict(v.to_dict())

    def set_calls(self, jti: str, calls: int) -> None:
        if jti in self._v:
            self._v[jti].calls = calls

    def remove(self, jti: str) -> None:
        self._v.pop(jti, None)


class FileVoucherCache:
    """Vouchers in `<dir>/vouchers.json`, the same file the TS FileVoucherCache uses.

    `path` may be a directory (-> `<dir>/vouchers.json`) or a path ending in `.json`.
    Every write goes to a temp file and is renamed over the real one; the file is
    re-read on every operation so several processes (or both clients) can share it.
    """

    def __init__(self, path: str) -> None:
        path = os.path.expanduser(path)
        if path.endswith(".json"):
            self.file = path
        else:
            self.file = os.path.join(path, "vouchers.json")
        self.dir = os.path.dirname(self.file) or "."

    def _read(self) -> List[StoredVoucher]:
        try:
            with open(self.file, "r", encoding="utf-8") as f:
                data = json.load(f)
        except FileNotFoundError:
            return []
        except ValueError:
            return []
        if not isinstance(data, dict) or not isinstance(data.get("vouchers"), list):
            return []
        out = []
        for v in data["vouchers"]:
            if isinstance(v, dict) and isinstance(v.get("jti"), str):
                out.append(StoredVoucher.from_dict(v))
        return out

    def _write(self, vouchers: List[StoredVoucher]) -> None:
        os.makedirs(self.dir, exist_ok=True)
        data = {"version": 1, "vouchers": [v.to_dict() for v in vouchers]}
        fd, tmp = tempfile.mkstemp(prefix=".vouchers.", suffix=".tmp", dir=self.dir)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(json.dumps(data, indent=2))
            os.replace(tmp, self.file)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    def list(self) -> List[StoredVoucher]:
        return self._read()

    def find(self, seller_id: str, path: str, now: int) -> Optional[StoredVoucher]:
        return _pick_best([v for v in self._read() if v.usable(seller_id, path, now)])

    def put(self, v: StoredVoucher) -> None:
        vouchers = [x for x in self._read() if x.jti != v.jti]
        vouchers.append(StoredVoucher.from_dict(v.to_dict()))
        self._write(vouchers)

    def set_calls(self, jti: str, calls: int) -> None:
        vouchers = self._read()
        for v in vouchers:
            if v.jti == jti:
                v.calls = calls
                self._write(vouchers)
                return

    def remove(self, jti: str) -> None:
        vouchers = self._read()
        rest = [v for v in vouchers if v.jti != jti]
        if len(rest) != len(vouchers):
            self._write(rest)


# --- solvers (packages/client/src/solvers.ts) -------------------------------

Solver = Callable[[Dict[str, Any]], Dict[str, str]]


def lookup_solver(mapping: Dict[str, str] | Callable[[Dict[str, Any], Dict[str, Any]], str]) -> Solver:
    """A solver backed by a static map (item id -> label) or a function (item, bundle) -> label."""

    def solve(bundle: Dict[str, Any]) -> Dict[str, str]:
        answers: Dict[str, str] = {}
        for item in bundle["items"]:
            answer = mapping(item, bundle) if callable(mapping) else mapping.get(item["id"])
            if not isinstance(answer, str):
                raise D402Error("solver_missing_answer", f"lookup solver has no answer for item {item['id']}")
            answers[item["id"]] = answer
        return answers

    return solve


def build_classify_prompt(bundle: Dict[str, Any]) -> str:
    """Same text as buildClassifyPrompt in packages/client/src/solvers.ts."""
    lines: List[str] = []
    lines.append("You are labelling data for a classification task.")
    lines.append("")
    lines.append("Instructions:")
    lines.append((bundle.get("instructions") or "").strip() or "Label each item with exactly one of the labels.")
    lines.append("")
    lines.append("Allowed labels (use these exact strings):")
    for label in bundle["labels"]:
        lines.append(f"- {label}")
    lines.append("")
    lines.append(f"Items ({len(bundle['items'])}):")
    for i, item in enumerate(bundle["items"]):
        lines.append(f"{i + 1}. [id: {item['id']}] {_js_stringify(item['text'])}")
    lines.append("")
    lines.append(
        "Respond with ONLY a JSON object mapping each item id to one of the allowed labels, "
        "with no prose, no markdown and no code fences. Every item id must appear exactly once."
    )
    lines.append("Example shape:")
    example: Dict[str, str] = {}
    labels = bundle["labels"]
    for i, item in enumerate(bundle["items"][:2]):
        example[item["id"]] = labels[i % len(labels)]
    lines.append(_js_stringify(example))
    return "\n".join(lines)


def _js_stringify(value: Any) -> str:
    """JSON.stringify(value) with no spacing and insertion-ordered keys."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


_FENCE = re.compile(r"```(?:json|JSON)?\s*([\s\S]*?)```")


def _try_parse_object(s: str) -> Optional[Dict[str, Any]]:
    if not s.startswith("{"):
        return None
    try:
        v = json.loads(s)
    except ValueError:
        return None
    return v if isinstance(v, dict) else None


def extract_json_object(text: str) -> Optional[Dict[str, Any]]:
    """Find the first balanced {...} block in `text` that parses as a JSON object."""
    direct = _try_parse_object(text.strip())
    if direct is not None:
        return direct
    for m in _FENCE.finditer(text):
        inner = _try_parse_object(m.group(1).strip())
        if inner is not None:
            return inner
    start = text.find("{")
    while start != -1:
        depth = 0
        in_string = False
        escaped = False
        for i in range(start, len(text)):
            ch = text[i]
            if in_string:
                if escaped:
                    escaped = False
                elif ch == "\\":
                    escaped = True
                elif ch == '"':
                    in_string = False
                continue
            if ch == '"':
                in_string = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    candidate = _try_parse_object(text[start : i + 1])
                    if candidate is not None:
                        return candidate
                    break
        start = text.find("{", start + 1)
    return None


def parse_classify_answers(text: str, bundle: Dict[str, Any]) -> Dict[str, str]:
    """Parse an LLM reply into answers. Tolerates fences and prose; matches labels case-insensitively."""
    obj = extract_json_object(text)
    if obj is None:
        raise D402Error("solver_bad_output", "no JSON object found in solver output", body=text)
    labels: List[str] = bundle["labels"]
    by_lower = {label.lower(): label for label in labels}
    answers: Dict[str, str] = {}
    missing: List[str] = []
    bad: List[Dict[str, Any]] = []
    for item in bundle["items"]:
        raw = obj.get(item["id"])
        if raw is None:
            missing.append(item["id"])
            continue
        value = raw.strip() if isinstance(raw, str) else _js_stringify(raw) if isinstance(raw, (bool, dict, list)) else str(raw)
        label = value if value in labels else by_lower.get(value.lower())
        if label is None:
            bad.append({"id": item["id"], "value": raw})
            continue
        answers[item["id"]] = label
    if missing or bad:
        parts = []
        if missing:
            parts.append("missing answers for: " + ", ".join(missing))
        if bad:
            parts.append("answers not in labels: " + ", ".join(f"{b['id']}={_js_stringify(b['value'])}" for b in bad))
        raise D402Error("solver_bad_output", "; ".join(parts), body={"missing": missing, "bad": bad})
    return answers


def llm_solver(complete: Callable[[str], str], max_retries: int = 2) -> Solver:
    """A solver that asks an LLM (`complete(prompt) -> text`) and parses its JSON reply,
    retrying with a correction when the reply cannot be used."""

    def solve(bundle: Dict[str, Any]) -> Dict[str, str]:
        base = build_classify_prompt(bundle)
        prompt = base
        last: Optional[D402Error] = None
        for _attempt in range(max_retries + 1):
            text = complete(prompt)
            try:
                return parse_classify_answers(text, bundle)
            except D402Error as e:
                if e.code != "solver_bad_output":
                    raise
                last = e
                prompt = (
                    base
                    + "\n\nYour previous reply could not be used ("
                    + e.message
                    + "). Reply again with ONLY the JSON object, covering every item id, "
                    + "using only the allowed labels."
                )
        raise D402Error(
            "solver_bad_output",
            f"solver output could not be parsed after {max_retries + 1} attempts: {last.message if last else ''}",
            body=last.body if last else None,
        )

    return solve


# --- the client -------------------------------------------------------------


def _decode_jwt_payload(token: str) -> Dict[str, Any]:
    parts = token.split(".")
    if len(parts) < 2:
        raise D402Error("bad_voucher", "voucher is not a JWT")
    try:
        payload = json.loads(from_b64u(parts[1]).decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as e:
        raise D402Error("bad_voucher", f"voucher payload could not be decoded: {e}")
    if not isinstance(payload, dict):
        raise D402Error("bad_voucher", "voucher payload is not an object")
    return payload


def _read_json(res: requests.Response) -> Any:
    text = res.text
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return text


def _error_from_response(res: requests.Response, body: Any, fallback_code: str) -> D402Error:
    if isinstance(body, dict) and isinstance(body.get("error"), str):
        msg = body.get("message") if isinstance(body.get("message"), str) else f"{body['error']} (HTTP {res.status_code})"
        return D402Error(body["error"], msg, status=res.status_code, body=body)
    return D402Error(fallback_code, f"HTTP {res.status_code} from {res.url or 'seller'}", status=res.status_code, body=body)


def _origin(url: str) -> str:
    u = urlsplit(url)
    return f"{u.scheme}://{u.netloc}"


class D402Client:
    """Earn vouchers by labelling and spend them, with a `fetch()` wrapper around `requests`.

    Args:
        keypair: the agent identity (see `Keypair`).
        solver: `bundle -> answers`; required for `earn()` and for `fetch()` to recover from a 402.
        model: sent as D402-Model and `body.model` (model family, e.g. "claude").
        tier: tier id, or a callable `accept -> tier id`. Default: the tier with the fewest items.
        cache_path: a directory (-> `<dir>/vouchers.json`, shared with the TS client) or a
            `.json` file path. Default: in-memory.
        sign_spends: send D402-Key / D402-Timestamp / D402-Sig on every spend (SPEC 7.1). Default True.
        spend_nonce: also send D402-Nonce and sign the 6-line form (SPEC 7.2). Default True, like
            the TS client; set False for a seller that predates 7.2 and verifies only the 5-line form.
        max_earn_attempts: bundles to try when one fails with 422 quality. Default 3.
        session: a `requests.Session` to use. Default: a new one.
        now: unix-seconds clock, injectable for tests.
    """

    def __init__(
        self,
        keypair: Keypair,
        solver: Optional[Solver] = None,
        model: Optional[str] = None,
        tier: Optional[str | Callable[[Dict[str, Any]], str]] = None,
        cache_path: Optional[str] = None,
        sign_spends: bool = True,
        spend_nonce: bool = True,
        max_earn_attempts: int = 3,
        session: Optional[requests.Session] = None,
        now: Optional[Callable[[], int]] = None,
        timeout: float = 30.0,
    ) -> None:
        self.keypair = keypair
        self.solver = solver
        self.model = model
        self.tier = tier
        self.cache = FileVoucherCache(cache_path) if cache_path else MemoryVoucherCache()
        self.sign_spends = sign_spends
        self.spend_nonce = spend_nonce
        self.max_earn_attempts = max(1, max_earn_attempts)
        self.session = session or requests.Session()
        self.now = now or (lambda: int(time.time()))
        self.timeout = timeout
        # origin -> accept learned from 402s or discover()
        self.accepts: Dict[str, Dict[str, Any]] = {}

    # -- helpers --

    def _remember_accept(self, url: str, accept: Dict[str, Any]) -> None:
        try:
            self.accepts[_origin(url)] = accept
        except ValueError:
            pass

    def _pick_tier(self, accept: Dict[str, Any]) -> str:
        chosen = self.tier(accept) if callable(self.tier) else self.tier
        tier_id = chosen or smallest_tier(accept)
        if not any(t.get("id") == tier_id for t in accept["tiers"]):
            raise D402Error("bad_tier", f'tier "{tier_id}" is not offered by {accept["sellerId"]}', body=accept["tiers"])
        return tier_id

    def _task_headers(self, extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        h = dict(extra or {})
        h[HEADERS["key"]] = self.keypair.publicKey
        if self.model:
            h[HEADERS["model"]] = self.model
        return h

    # -- SPEC 3: discovery --

    def discover(self, base_url_or_offer_url: str) -> Dict[str, Any]:
        """GET {base}/.well-known/d402 (a full well-known URL is used as is). Returns the offer."""
        u = urlsplit(base_url_or_offer_url)
        if not u.scheme or not u.netloc:
            raise D402Error("bad_url", f"not an absolute URL: {base_url_or_offer_url}")
        path = u.path.rstrip("/")
        if path.endswith(WELL_KNOWN_PATH):
            url = urlunsplit((u.scheme, u.netloc, u.path, u.query, ""))
        else:
            url = f"{u.scheme}://{u.netloc}{path}{WELL_KNOWN_PATH}"
        res = self.session.get(url, headers={"Accept": "application/json"}, timeout=self.timeout)
        body = _read_json(res)
        accept = find_d402_accept(body)
        if accept is None:
            raise D402Error("bad_offer", f"no valid d402 offer at {url} (HTTP {res.status_code})", status=res.status_code, body=body)
        self._remember_accept(url, accept)
        return body

    # -- SPEC 4: earning a bundle --

    def get_bundle(self, task_url: str, tier: str) -> Dict[str, Any]:
        """GET taskUrl?tier=... with D402-Key (+ D402-Model)."""
        u = urlsplit(task_url)
        q = [(k, v) for k, v in parse_qsl(u.query, keep_blank_values=True) if k != "tier"]
        q.append(("tier", tier))
        url = urlunsplit((u.scheme, u.netloc, u.path, urlencode(q), ""))
        res = self.session.get(url, headers=self._task_headers({"Accept": "application/json"}), timeout=self.timeout)
        body = _read_json(res)
        if not res.ok:
            raise _error_from_response(res, body, "bundle_failed")
        if (
            not isinstance(body, dict)
            or not isinstance(body.get("bundleId"), str)
            or not isinstance(body.get("items"), list)
            or not isinstance(body.get("labels"), list)
        ):
            raise D402Error("bad_bundle", "seller returned an invalid bundle", status=res.status_code, body=body)
        return body

    # -- SPEC 5: submitting answers --

    def submit(
        self, task_url: str, bundle: Dict[str, Any], answers: Dict[str, str], accept: Optional[Dict[str, Any]] = None
    ) -> StoredVoucher:
        """Sign and POST answers; the voucher is stored in the cache and returned."""
        sig = sign_submit(self.keypair.privateKey, bundle["bundleId"], answers)
        payload: Dict[str, Any] = {"answers": answers, "sig": sig}
        if self.model:
            payload["model"] = self.model
        url = task_url.rstrip("/") + "/" + quote(bundle["bundleId"], safe="")
        res = self.session.post(
            url,
            headers=self._task_headers({"Content-Type": "application/json", "Accept": "application/json"}),
            data=json.dumps(payload).encode("utf-8"),
            timeout=self.timeout,
        )
        body = _read_json(res)
        if not res.ok:
            raise _error_from_response(res, body, "submit_failed")
        if not isinstance(body, dict) or not isinstance(body.get("voucher"), str) or not isinstance(body.get("calls"), int):
            raise D402Error("bad_submit_result", "seller returned an invalid submit result", status=res.status_code, body=body)
        claims = _decode_jwt_payload(body["voucher"])
        jti = claims.get("jti")
        if not isinstance(jti, str):
            raise D402Error("bad_voucher", "voucher has no jti claim", body=claims)
        seller_id = accept["sellerId"] if accept else claims.get("iss")
        if not isinstance(seller_id, str):
            raise D402Error("bad_voucher", "voucher has no iss claim and no accept was given", body=claims)
        scope = body.get("scope") if isinstance(body.get("scope"), list) and body.get("scope") else (accept["scope"] if accept else [])
        voucher = StoredVoucher(
            jti=jti,
            sellerId=seller_id,
            token=body["voucher"],
            scope=list(scope),
            calls=int(body["calls"]),
            expiresAt=int(body.get("expiresAt", claims.get("exp", 0))),
            sub=claims["sub"] if isinstance(claims.get("sub"), str) else self.keypair.publicKey,
            taskUrl=task_url,
        )
        self.cache.put(voucher)
        if accept:
            self._remember_accept(task_url, accept)
        return voucher

    def earn(self, accept: Dict[str, Any], tier: Optional[str] = None) -> StoredVoucher:
        """get_bundle -> solver -> submit, retrying on 422 quality up to max_earn_attempts."""
        if self.solver is None:
            raise D402Error("no_solver", "a solver is required to earn vouchers")
        tier_id = tier or self._pick_tier(accept)
        last: Optional[D402Error] = None
        for _attempt in range(self.max_earn_attempts):
            bundle = self.get_bundle(accept["taskUrl"], tier_id)
            answers = self.solver(bundle)
            try:
                return self.submit(accept["taskUrl"], bundle, answers, accept)
            except D402Error as e:
                if e.code == "quality":
                    last = e
                    continue
                raise
        raise D402Error(
            "earn_failed",
            f"failed quality check on {self.max_earn_attempts} bundle(s) from {accept['sellerId']}: {last.message if last else ''}",
            status=last.status if last else 422,
            body=last.body if last else None,
        )

    # -- SPEC 7 / 7.1: spending --

    def _send(self, method: str, url: str, path: str, voucher: Optional[StoredVoucher], kwargs: Dict[str, Any]) -> requests.Response:
        headers = dict(kwargs.pop("headers", None) or {})
        if voucher is not None:
            headers[HEADERS["voucher"]] = voucher.token
            if self.sign_spends:
                ts = self.now()
                headers[HEADERS["key"]] = self.keypair.publicKey
                headers[HEADERS["timestamp"]] = str(ts)
                nonce = new_nonce() if self.spend_nonce else None
                if nonce is not None:
                    headers[HEADERS["nonce"]] = nonce
                headers[HEADERS["sig"]] = sign_spend(self.keypair.privateKey, method, path, voucher.jti, ts, nonce)
        kwargs.setdefault("timeout", self.timeout)
        return self.session.request(method, url, headers=headers, **kwargs)

    def _note_calls(self, res: requests.Response, voucher: Optional[StoredVoucher]) -> None:
        if voucher is None:
            return
        raw = res.headers.get(HEADERS["callsRemaining"])
        if raw is None:
            return
        try:
            self.cache.set_calls(voucher.jti, int(raw.strip()))
        except ValueError:
            pass

    def fetch(self, url: str, method: str = "GET", **requests_kwargs: Any) -> requests.Response:
        """Like `requests.request`, but attaches a cached voucher for the seller and, on a
        402 with a d402 offer, earns one and retries once. Returns the final response."""
        method = method.upper()
        u = urlsplit(url)
        if not u.scheme or not u.netloc:
            raise D402Error("bad_url", f"not an absolute URL: {url}")
        path = u.path or "/"
        origin = _origin(url)
        kwargs = dict(requests_kwargs)
        # `data`/`json`/`files` are replayable only if they are not streams.
        body = kwargs.get("data")
        if hasattr(body, "read"):
            raise D402Error("unreplayable_body", f"request body for {method} {url} is a stream and cannot be replayed after earning a voucher")

        voucher: Optional[StoredVoucher] = None
        known = self.accepts.get(origin)
        if known is not None:
            voucher = self.cache.find(known["sellerId"], path, self.now())

        first = self._send(method, url, path, voucher, dict(kwargs))
        if first.status_code != 402:
            self._note_calls(first, voucher)
            return first

        offer = _read_json(first)
        accept = find_d402_accept(offer)
        if accept is None:
            return first
        self.accepts[origin] = accept

        if voucher is not None and isinstance(offer, dict) and offer.get("error") in _VOUCHER_EVICT_ERRORS:
            self.cache.remove(voucher.jti)
        elif voucher is None and known is None:
            # First contact with this seller: a voucher earned earlier (another process, the
            # CLI, the TS client) may already be in the cache. Try it before earning.
            cached = self.cache.find(accept["sellerId"], path, self.now())
            if cached is not None:
                retry = self._send(method, url, path, cached, dict(kwargs))
                if retry.status_code != 402:
                    self._note_calls(retry, cached)
                    return retry
                retry_offer = _read_json(retry)
                if isinstance(retry_offer, dict) and retry_offer.get("error") in _VOUCHER_EVICT_ERRORS:
                    self.cache.remove(cached.jti)

        fresh = self.earn(accept)
        second = self._send(method, url, path, fresh, dict(kwargs))
        if second.status_code != 402:
            self._note_calls(second, fresh)
        return second

    def status(self) -> List[StoredVoucher]:
        """Everything in the cache."""
        return self.cache.list()
