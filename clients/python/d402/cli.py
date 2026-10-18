"""
Command line for the Python d402 client.

    python -m d402 keygen
    python -m d402 discover http://localhost:8787
    python -m d402 earn http://localhost:8787 --answers answers.json [--tier s]
    python -m d402 fetch "http://localhost:8787/search?q=gpu" [--answers answers.json]
    python -m d402 status

State lives in $D402_HOME (default ~/.d402): keypair.json and vouchers.json, the same
files the TypeScript client and the d402 MCP server use.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, Optional
from urllib.parse import urlsplit

from .client import HEADERS, D402Client, D402Error, Keypair, find_d402_accept, lookup_solver


def d402_home() -> str:
    home = os.environ.get("D402_HOME", "").strip() or "~/.d402"
    return os.path.expanduser(home)


def _solver_from_file(path: Optional[str], fallback: Optional[str]):
    if path is None and fallback is None:
        return None
    mapping: Dict[str, str] = {}
    if path:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise D402Error("bad_answers", f"{path} must be a JSON object of item id -> label")
        mapping = {str(k): str(v) for k, v in data.items()}
    if fallback is None:
        return lookup_solver(mapping)
    return lookup_solver(lambda item, bundle: mapping.get(item["id"], fallback))


def _client(args: argparse.Namespace) -> D402Client:
    home = d402_home()
    keypair = Keypair.load_or_create(os.path.join(home, "keypair.json"))
    solver = _solver_from_file(getattr(args, "answers", None), getattr(args, "fallback", None))
    return D402Client(
        keypair,
        solver=solver,
        model=getattr(args, "model", None),
        tier=getattr(args, "tier", None),
        cache_path=home,
        sign_spends=not getattr(args, "no_sign", False),
        max_earn_attempts=getattr(args, "attempts", 3),
    )


def _dump(obj: Any) -> None:
    print(json.dumps(obj, indent=2, ensure_ascii=False))


def cmd_keygen(args: argparse.Namespace) -> int:
    path = args.out or os.path.join(d402_home(), "keypair.json")
    if os.path.exists(path) and not args.force:
        kp = Keypair.load(path)
        print(f"keypair already exists at {path} (use --force to overwrite)", file=sys.stderr)
    else:
        kp = Keypair.generate()
        kp.save(path)
        print(f"wrote {path}", file=sys.stderr)
    print(kp.publicKey)
    return 0


def cmd_discover(args: argparse.Namespace) -> int:
    client = _client(args)
    offer = client.discover(args.base)
    _dump(offer)
    return 0


def cmd_earn(args: argparse.Namespace) -> int:
    client = _client(args)
    if client.solver is None:
        print("earn needs --answers answers.json (item id -> label) or --fallback LABEL", file=sys.stderr)
        return 2
    offer = client.discover(args.base)
    accept = find_d402_accept(offer)
    voucher = client.earn(accept, args.tier)
    _dump(voucher.to_dict())
    return 0


def cmd_fetch(args: argparse.Namespace) -> int:
    client = _client(args)
    headers = {}
    for h in args.header or []:
        k, _, v = h.partition(":")
        headers[k.strip()] = v.strip()
    kwargs: Dict[str, Any] = {"headers": headers}
    if args.data is not None:
        kwargs["data"] = args.data.encode("utf-8")
    # Learn the seller up front so a cached voucher is attached on the first request
    # (fetch() also finds it after a 402, this just saves the round trip).
    u = urlsplit(args.url)
    try:
        client.discover(f"{u.scheme}://{u.netloc}")
    except D402Error:
        pass
    res = client.fetch(args.url, method=args.method, **kwargs)
    print(f"HTTP {res.status_code}", file=sys.stderr)
    for name in HEADERS.values():
        if name in res.headers:  # requests' header map is case-insensitive
            print(f"{name}: {res.headers[name]}", file=sys.stderr)
    body = res.text
    try:
        _dump(json.loads(body))
    except ValueError:
        print(body)
    return 0 if res.ok else 1


def cmd_status(args: argparse.Namespace) -> int:
    client = _client(args)
    vouchers = client.status()
    print(f"home: {d402_home()}", file=sys.stderr)
    print(f"key:  {client.keypair.publicKey}", file=sys.stderr)
    _dump([v.to_dict() for v in vouchers])
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="d402", description="Minimal d402 agent client (Python).")
    sub = p.add_subparsers(dest="cmd", required=True)

    k = sub.add_parser("keygen", help="create $D402_HOME/keypair.json (prints the public key)")
    k.add_argument("--out", help="write the keypair here instead")
    k.add_argument("--force", action="store_true", help="overwrite an existing keypair")
    k.set_defaults(fn=cmd_keygen)

    d = sub.add_parser("discover", help="GET <base>/.well-known/d402 and print the offer")
    d.add_argument("base")
    d.set_defaults(fn=cmd_discover)

    e = sub.add_parser("earn", help="earn a voucher from <base> and cache it")
    e.add_argument("base")
    e.add_argument("--tier", help="tier id (default: fewest items)")
    e.add_argument("--answers", help="JSON file: item id -> label (lookup solver)")
    e.add_argument("--fallback", help="label to use for ids missing from --answers")
    e.add_argument("--model", help="D402-Model value")
    e.add_argument("--attempts", type=int, default=3, help="bundles to try on 422 quality (default 3)")
    e.set_defaults(fn=cmd_earn)

    f = sub.add_parser("fetch", help="request <url> with a cached voucher; earn one on 402")
    f.add_argument("url")
    f.add_argument("-X", "--method", default="GET")
    f.add_argument("-H", "--header", action="append", help="extra header, 'Name: value'")
    f.add_argument("-d", "--data", help="request body")
    f.add_argument("--answers", help="JSON file: item id -> label, used if a voucher must be earned")
    f.add_argument("--fallback", help="label to use for ids missing from --answers")
    f.add_argument("--tier", help="tier id for earning (default: fewest items)")
    f.add_argument("--model", help="D402-Model value")
    f.add_argument("--attempts", type=int, default=3)
    f.add_argument("--no-sign", action="store_true", help="do not send D402-Key/Timestamp/Sig on spends")
    f.set_defaults(fn=cmd_fetch)

    s = sub.add_parser("status", help="list cached vouchers")
    s.set_defaults(fn=cmd_status)
    return p


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.fn(args)
    except D402Error as e:
        print(f"d402 error {e.code}: {e.message}" + (f" (HTTP {e.status})" if e.status else ""), file=sys.stderr)
        if e.body is not None and e.code not in ("earn_failed", "quality"):
            try:
                print(json.dumps(e.body, indent=2)[:2000], file=sys.stderr)
            except (TypeError, ValueError):
                pass
        return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
