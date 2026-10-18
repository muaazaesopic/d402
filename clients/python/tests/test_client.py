"""
Tests for the Python d402 client.

Unit tests check canonical JSON and both signatures against vectors produced by the
TypeScript implementation (packages/spec) with a fixed private key; Ed25519 is
deterministic so the signatures must be byte-equal.

Integration tests start examples/search-proxy as a subprocess and run the whole
protocol against it, then check that the keypair file and the voucher cache written
here are read correctly by the TypeScript client (packages/client).

Run:  cd clients/python && python3 -m unittest -v     (or python3 -m pytest -q)
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from typing import Any, Dict, List

HERE = os.path.dirname(os.path.abspath(__file__))
PKG_ROOT = os.path.dirname(HERE)
REPO_ROOT = os.path.dirname(os.path.dirname(PKG_ROOT))
if PKG_ROOT not in sys.path:
    sys.path.insert(0, PKG_ROOT)

from d402 import (  # noqa: E402
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
    lookup_solver,
    new_nonce,
    parse_classify_answers,
    scope_matches,
    sign_spend,
    sign_submit,
    smallest_tier,
    spend_message,
    submit_message,
    verify_spend,
    verify_submit,
)

# --- vectors generated with packages/spec/src (node --import tsx) ------------
# Fixed seed: bytes 0..31. Same key is used on the TS side to produce every value below.
FIXED_PRIVATE_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
FIXED_PUBLIC_KEY = "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg"

VEC_ANSWERS: Dict[str, Any] = {
    "i_2": "tech",
    "i_10": "sports",
    "i_1": 'wörld "quoted" \\ \n\t\u0001\u007f 😀',
    "a": {"z": [1, "two", None, True], "b": {}},
}
VEC_CANONICAL = '{"a":{"b":{},"z":[1,"two",null,true]},"i_1":"wörld \\"quoted\\" \\\\ \\n\\t\\u0001\u007f 😀","i_10":"sports","i_2":"tech"}'
VEC_SUBMIT_MESSAGE = "d402:submit\nb_test123\n" + VEC_CANONICAL
VEC_SUBMIT_SIG = "etOfV6BhmGsvWsWjn5zpr_AAultkLITADUKzzEz1H9vCVA4rRg-LG8N54xyJjkkWdLgmSOwAB-Z1sbID9oVYCA"
VEC_SIMPLE_SIG = "XxNFppn6_qTAVvFq7xqaG9uev0M1hsBfjhbxZZqBEXH8sJsZ2aBfeJrbTFi3PyLjBm7Zw3tk0PKsD0GpRbtMAA"
VEC_SPEND_MESSAGE = "d402:spend\nGET\n/search\nv_abc\n1760000000"
VEC_SPEND_SIG = "WUA2l4Nm9vbqwvVBVN9al1mpDn9VaJ5SywqacPCZhle64g5wsIKVqh2ZpHX5LS6qsebJi-miWNL8QwBLIW2yDQ"
VEC_NONCE = "AAAAAAAAAAAAAAAAAAAAAA"
VEC_NONCE_MESSAGE = "d402:spend\nPOST\n/search\nv_abc\n1760000000\nAAAAAAAAAAAAAAAAAAAAAA"
VEC_NONCE_SIG = "u38rVLqk_GHHsVNjHiq3-JxKta7ipMLCtClUo7AL9vdU9s8u33_9y-WTPfQMOfW4Q0LbJyKsfAkzYh9iRlQLBg"

VEC_BUNDLE = {
    "bundleId": "b_x",
    "tier": "s",
    "type": "classify",
    "instructions": "  Label each news snippet with exactly one of: sports, business, tech, world.  ",
    "labels": ["sports", "business", "tech", "world"],
    "items": [
        {"id": "i_1", "text": 'The chipmaker "unveiled" a GPU\n'},
        {"id": "i_2", "text": "Cup final wön"},
        {"id": "i_3", "text": "x"},
    ],
    "expiresAt": 1,
}
VEC_PROMPT = (
    "You are labelling data for a classification task.\n\nInstructions:\n"
    "Label each news snippet with exactly one of: sports, business, tech, world.\n\n"
    "Allowed labels (use these exact strings):\n- sports\n- business\n- tech\n- world\n\n"
    'Items (3):\n1. [id: i_1] "The chipmaker \\"unveiled\\" a GPU\\n"\n2. [id: i_2] "Cup final wön"\n3. [id: i_3] "x"\n\n'
    "Respond with ONLY a JSON object mapping each item id to one of the allowed labels, with no prose, "
    "no markdown and no code fences. Every item id must appear exactly once.\nExample shape:\n"
    '{"i_1":"sports","i_2":"business"}'
)


class CanonicalAndSigningTests(unittest.TestCase):
    def test_canonical_json_matches_ts_vector(self):
        self.assertEqual(canonical_json(VEC_ANSWERS), VEC_CANONICAL)
        self.assertEqual(canonical_json(VEC_ANSWERS).encode("utf-8"), VEC_CANONICAL.encode("utf-8"))

    def test_canonical_json_sorts_nested_and_has_no_whitespace(self):
        self.assertEqual(canonical_json({"b": {"d": 1, "c": [{"z": 0, "y": 0}]}, "a": "x"}), '{"a":"x","b":{"c":[{"y":0,"z":0}],"d":1}}')

    def test_b64u_is_unpadded_and_roundtrips(self):
        raw = bytes(range(32))
        s = b64u(raw)
        self.assertNotIn("=", s)
        self.assertNotIn("+", s)
        self.assertNotIn("/", s)
        self.assertEqual(s, FIXED_PRIVATE_KEY)
        self.assertEqual(from_b64u(s), raw)
        self.assertEqual(from_b64u(s + "="), raw)

    def test_fixed_seed_derives_same_public_key_as_ts(self):
        kp = Keypair.from_private_key(FIXED_PRIVATE_KEY)
        self.assertEqual(kp.publicKey, FIXED_PUBLIC_KEY)
        self.assertEqual(len(from_b64u(kp.publicKey)), 32)

    def test_submit_signature_matches_ts_vector(self):
        self.assertEqual(submit_message("b_test123", VEC_ANSWERS), VEC_SUBMIT_MESSAGE)
        self.assertEqual(sign_submit(FIXED_PRIVATE_KEY, "b_test123", VEC_ANSWERS), VEC_SUBMIT_SIG)
        self.assertEqual(sign_submit(FIXED_PRIVATE_KEY, "b_01", {"i_1": "tech", "i_2": "sports"}), VEC_SIMPLE_SIG)
        # key order in the dict must not matter
        self.assertEqual(sign_submit(FIXED_PRIVATE_KEY, "b_01", {"i_2": "sports", "i_1": "tech"}), VEC_SIMPLE_SIG)
        self.assertTrue(verify_submit(FIXED_PUBLIC_KEY, "b_test123", VEC_ANSWERS, VEC_SUBMIT_SIG))

    def test_spend_signature_matches_ts_vector(self):
        self.assertEqual(spend_message("get", "/search", "v_abc", 1760000000), VEC_SPEND_MESSAGE)
        self.assertEqual(sign_spend(FIXED_PRIVATE_KEY, "get", "/search", "v_abc", 1760000000), VEC_SPEND_SIG)
        self.assertTrue(verify_spend(FIXED_PUBLIC_KEY, "GET", "/search", "v_abc", 1760000000, VEC_SPEND_SIG))

    def test_spend_signature_with_nonce_matches_ts_vector(self):
        self.assertEqual(spend_message("post", "/search", "v_abc", 1760000000, VEC_NONCE), VEC_NONCE_MESSAGE)
        self.assertEqual(sign_spend(FIXED_PRIVATE_KEY, "post", "/search", "v_abc", 1760000000, VEC_NONCE), VEC_NONCE_SIG)
        self.assertTrue(verify_spend(FIXED_PUBLIC_KEY, "POST", "/search", "v_abc", 1760000000, VEC_NONCE_SIG, VEC_NONCE))
        self.assertEqual(len(from_b64u(new_nonce())), 16)

    def test_verify_rejects_tampering(self):
        self.assertFalse(verify_submit(FIXED_PUBLIC_KEY, "b_test124", VEC_ANSWERS, VEC_SUBMIT_SIG))
        self.assertFalse(verify_submit(FIXED_PUBLIC_KEY, "b_test123", {**VEC_ANSWERS, "i_2": "world"}, VEC_SUBMIT_SIG))
        self.assertFalse(verify_spend(FIXED_PUBLIC_KEY, "POST", "/search", "v_abc", 1760000000, VEC_SPEND_SIG))
        self.assertFalse(verify_spend(FIXED_PUBLIC_KEY, "GET", "/search", "v_abc", 1760000001, VEC_SPEND_SIG))
        other = Keypair.generate()
        self.assertFalse(verify_spend(other.publicKey, "GET", "/search", "v_abc", 1760000000, VEC_SPEND_SIG))
        self.assertFalse(verify_spend(FIXED_PUBLIC_KEY, "GET", "/search", "v_abc", 1760000000, "not-a-sig"))


class KeypairAndCacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="d402py-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_keypair_file_format_and_mode(self):
        path = os.path.join(self.tmp, "sub", "keypair.json")
        kp = Keypair.load_or_create(path)
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        with open(path) as f:
            data = json.load(f)
        self.assertEqual(set(data), {"publicKey", "privateKey"})
        self.assertEqual(len(from_b64u(data["publicKey"])), 32)
        self.assertEqual(len(from_b64u(data["privateKey"])), 32)
        again = Keypair.load_or_create(path)
        self.assertEqual(again, kp)
        with open(path, "w") as f:
            f.write('{"publicKey": "nope"}')
        with self.assertRaises(D402Error) as ctx:
            Keypair.load_or_create(path)
        self.assertEqual(ctx.exception.code, "bad_keyfile")

    def test_file_cache_matches_ts_shape_and_operations(self):
        cache = FileVoucherCache(self.tmp)
        self.assertEqual(cache.file, os.path.join(self.tmp, "vouchers.json"))
        self.assertEqual(cache.list(), [])
        v = StoredVoucher(jti="v_1", sellerId="s", token="t.p.s", scope=["/search"], calls=2, expiresAt=2_000_000_000, sub="k", taskUrl="http://x/tasks")
        cache.put(v)
        with open(cache.file) as f:
            data = json.load(f)
        self.assertEqual(data["version"], 1)
        self.assertEqual(data["vouchers"], [v.to_dict()])
        self.assertEqual(set(data["vouchers"][0]), {"jti", "sellerId", "token", "scope", "calls", "expiresAt", "sub", "taskUrl"})
        self.assertEqual(stat.S_IMODE(os.stat(cache.file).st_mode), 0o600)
        self.assertIsNotNone(cache.find("s", "/search?x", 1_000))
        self.assertIsNone(cache.find("s", "/other", 1_000))
        self.assertIsNone(cache.find("other", "/search", 1_000))
        self.assertIsNone(cache.find("s", "/search", 2_000_000_001))
        cache.set_calls("v_1", 0)
        self.assertIsNone(cache.find("s", "/search", 1_000))
        cache.set_calls("v_1", 5)
        self.assertEqual(cache.find("s", "/search", 1_000).calls, 5)
        # prefer the voucher that expires soonest
        cache.put(StoredVoucher(jti="v_2", sellerId="s", token="t", scope=["/search"], calls=1, expiresAt=1_500_000_000, sub="k", taskUrl="u"))
        self.assertEqual(cache.find("s", "/search", 1_000).jti, "v_2")
        cache.remove("v_2")
        self.assertEqual([x.jti for x in cache.list()], ["v_1"])
        # a .json path works too, and a garbage file reads as empty
        other = FileVoucherCache(os.path.join(self.tmp, "c.json"))
        with open(other.file, "w") as f:
            f.write("not json")
        self.assertEqual(other.list(), [])
        mem = MemoryVoucherCache()
        mem.put(v)
        self.assertEqual(mem.find("s", "/search", 1).jti, "v_1")

    def test_offer_helpers(self):
        self.assertTrue(scope_matches(["/a", "/search"], "/search/x"))
        self.assertFalse(scope_matches(["/search"], "/sea"))
        accept = {"scheme": "d402", "sellerId": "s", "taskUrl": "http://x/t", "scope": ["/s"], "tiers": [{"id": "m", "items": 25}, {"id": "s", "items": 5}]}
        self.assertEqual(smallest_tier(accept), "s")
        offer = {"d402": "1", "accepts": [{"scheme": "exact", "network": "base"}, accept]}
        self.assertIs(find_d402_accept(offer), accept)
        self.assertIsNone(find_d402_accept({"d402": "1", "accepts": [{"scheme": "exact"}]}))
        self.assertIsNone(find_d402_accept({"error": "x"}))


class SolverTests(unittest.TestCase):
    def test_classify_prompt_matches_ts(self):
        self.assertEqual(build_classify_prompt(VEC_BUNDLE), VEC_PROMPT)

    def test_parse_classify_answers_is_tolerant(self):
        b = VEC_BUNDLE
        self.assertEqual(parse_classify_answers('{"i_1":"tech","i_2":"sports","i_3":"world"}', b), {"i_1": "tech", "i_2": "sports", "i_3": "world"})
        fenced = 'Sure, here you go:\n```json\n{"i_1": "Tech", "i_2": " SPORTS ", "i_3": "world"}\n```\nDone.'
        self.assertEqual(parse_classify_answers(fenced, b)["i_1"], "tech")
        self.assertEqual(parse_classify_answers(fenced, b)["i_2"], "sports")
        prose = 'Labels: {not json} ... {"i_1":"tech","i_2":"sports","i_3":"world","extra":"ignored"} there.'
        self.assertEqual(len(parse_classify_answers(prose, b)), 3)
        with self.assertRaises(D402Error) as ctx:
            parse_classify_answers('{"i_1":"tech","i_2":"sports"}', b)
        self.assertEqual(ctx.exception.code, "solver_bad_output")
        self.assertIn("missing answers for: i_3", ctx.exception.message)
        with self.assertRaises(D402Error) as ctx:
            parse_classify_answers('{"i_1":"tech","i_2":"sports","i_3":"politics"}', b)
        self.assertIn("answers not in labels", ctx.exception.message)
        with self.assertRaises(D402Error):
            parse_classify_answers("no json here", b)

    def test_llm_solver_retries_with_correction(self):
        prompts: List[str] = []

        def complete(prompt: str) -> str:
            prompts.append(prompt)
            if len(prompts) == 1:
                return "I think i_1 is tech"
            return '{"i_1":"tech","i_2":"sports","i_3":"world"}'

        answers = llm_solver(complete)(VEC_BUNDLE)
        self.assertEqual(answers["i_2"], "sports")
        self.assertEqual(len(prompts), 2)
        self.assertTrue(prompts[0] == VEC_PROMPT)
        self.assertIn("Your previous reply could not be used", prompts[1])
        with self.assertRaises(D402Error) as ctx:
            llm_solver(lambda p: "nope", max_retries=1)(VEC_BUNDLE)
        self.assertIn("after 2 attempts", ctx.exception.message)

    def test_lookup_solver(self):
        self.assertEqual(lookup_solver({"i_1": "tech", "i_2": "sports", "i_3": "world"})(VEC_BUNDLE)["i_3"], "world")
        self.assertEqual(lookup_solver(lambda item, bundle: bundle["labels"][0])(VEC_BUNDLE)["i_3"], "sports")
        with self.assertRaises(D402Error) as ctx:
            lookup_solver({"i_1": "tech"})(VEC_BUNDLE)
        self.assertEqual(ctx.exception.code, "solver_missing_answer")


# --- integration: the example seller as a subprocess ---------------------------

SERVER_TS = os.path.join(REPO_ROOT, "examples", "search-proxy", "src", "server.ts")
ANSWER_KEY = os.path.join(REPO_ROOT, "examples", "search-proxy", "answer-key.json")
HAVE_REPO = os.path.exists(SERVER_TS) and os.path.exists(ANSWER_KEY) and shutil.which("node") is not None


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _node_tsx(script: str, *args: str) -> str:
    """Run a TypeScript snippet with the repo's tsx; returns stdout."""
    fd, path = tempfile.mkstemp(suffix=".mts", prefix="d402py-", dir=tempfile.gettempdir())
    with os.fdopen(fd, "w") as f:
        f.write(script)
    try:
        out = subprocess.run(
            ["node", "--import", "tsx", path, *args], cwd=REPO_ROOT, capture_output=True, text=True, timeout=120
        )
    finally:
        os.unlink(path)
    if out.returncode != 0:
        raise RuntimeError(f"node failed ({out.returncode}): {out.stderr}")
    return out.stdout


@unittest.skipUnless(HAVE_REPO, "needs the d402 repo with node_modules and node on PATH")
class IntegrationTests(unittest.TestCase):
    proc: subprocess.Popen
    base: str

    @classmethod
    def setUpClass(cls):
        cls.port = _free_port()
        # the seller builds its taskUrl with "localhost", and the client keys sellers by origin
        cls.base = f"http://localhost:{cls.port}"
        env = dict(os.environ, PORT=str(cls.port), D402_SECRET="test-secret", NODE_NO_WARNINGS="1")
        cls.log = tempfile.TemporaryFile(mode="w+")
        cls.proc = subprocess.Popen(
            ["node", "--import", "tsx", SERVER_TS], cwd=REPO_ROOT, env=env, stdout=cls.log, stderr=subprocess.STDOUT
        )
        deadline = time.time() + 60
        while time.time() < deadline:
            if cls.proc.poll() is not None:
                cls.log.seek(0)
                raise RuntimeError("server exited early:\n" + cls.log.read())
            try:
                with urllib.request.urlopen(cls.base + "/health", timeout=1) as r:
                    if r.status == 200:
                        break
            except Exception:  # noqa: BLE001
                time.sleep(0.2)
        else:
            cls.proc.kill()
            raise RuntimeError("server did not come up")
        with open(ANSWER_KEY) as f:
            cls.answer_key: Dict[str, str] = json.load(f)
        cls.tmp = tempfile.mkdtemp(prefix="d402py-int-")

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        try:
            cls.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            cls.proc.kill()
        cls.log.close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _good_solver(self):
        return lookup_solver(lambda item, bundle: self.answer_key.get(item["id"], "world"))

    def _client(self, keypair=None, cache_dir=None, solver=None, **kw) -> D402Client:
        return D402Client(
            keypair or Keypair.generate(),
            solver=solver if solver is not None else self._good_solver(),
            model="python-test",
            tier="s",
            cache_path=cache_dir,
            **kw,
        )

    def test_01_discover(self):
        client = self._client()
        offer = client.discover(self.base)
        self.assertEqual(offer["d402"], "1")
        accept = find_d402_accept(offer)
        self.assertEqual(accept["sellerId"], "d402-example-search-proxy")
        self.assertEqual(accept["taskUrl"], f"{self.base}/.well-known/d402/tasks")
        self.assertEqual(accept["scope"], ["/search"])
        self.assertEqual({t["id"] for t in accept["tiers"]}, {"s", "m", "l"})
        # a full well-known URL and a trailing slash are accepted as is
        self.assertEqual(client.discover(self.base + "/.well-known/d402")["d402"], "1")
        self.assertEqual(client.discover(self.base + "/")["d402"], "1")
        with self.assertRaises(D402Error) as ctx:
            client.discover(self.base + "/nope")
        self.assertEqual(ctx.exception.code, "bad_offer")

    def test_02_fetch_earns_on_402_then_spends_from_cache(self):
        cache_dir = os.path.join(self.tmp, "cache-a")
        client = self._client(cache_dir=cache_dir)
        self.assertEqual(client.status(), [])

        res = client.fetch(f"{self.base}/search?q=tech")
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.headers["D402-Calls-Remaining"], "9")
        self.assertIn("hits", res.json())

        res2 = client.fetch(f"{self.base}/search?q=ceasefire")
        self.assertEqual(res2.status_code, 200)
        self.assertEqual(res2.headers["D402-Calls-Remaining"], "8")

        vouchers = client.status()
        self.assertEqual(len(vouchers), 1)
        v = vouchers[0]
        self.assertEqual(v.sellerId, "d402-example-search-proxy")
        self.assertEqual(v.calls, 8)
        self.assertEqual(v.scope, ["/search"])
        self.assertEqual(v.sub, client.keypair.publicKey)
        self.assertEqual(v.taskUrl, f"{self.base}/.well-known/d402/tasks")
        self.assertEqual(v.token.count("."), 2)
        self.assertGreater(v.expiresAt, int(time.time()))

        # A new client (same key, same cache dir) spends without earning.
        def no_solver(bundle):
            raise AssertionError("solver must not be called when a cached voucher exists")

        client2 = self._client(keypair=client.keypair, cache_dir=cache_dir, solver=no_solver)
        client2.discover(self.base)  # learn the seller so the cached voucher is attached on the first request
        res3 = client2.fetch(f"{self.base}/search?q=gpu")
        self.assertEqual(res3.status_code, 200, res3.text)
        self.assertEqual(res3.headers["D402-Calls-Remaining"], "7")
        self.assertEqual(client2.status()[0].calls, 7)

        # A cold client that never called discover() learns the seller from the 402 and
        # still uses the cached voucher instead of earning.
        client3 = self._client(keypair=client.keypair, cache_dir=cache_dir, solver=no_solver)
        res4 = client3.fetch(f"{self.base}/search?q=bank")
        self.assertEqual(res4.status_code, 200, res4.text)
        self.assertEqual(res4.headers["D402-Calls-Remaining"], "6")

        # The TS FileVoucherCache reads the same file.
        out = _node_tsx(
            'import { FileVoucherCache } from "%s/packages/client/src/index.ts";\n'
            "const c = new FileVoucherCache(process.argv[2]);\n"
            "console.log(JSON.stringify(await c.list()));\n" % REPO_ROOT,
            cache_dir,
        )
        ts_list = json.loads(out)
        self.assertEqual(ts_list, [client3.status()[0].to_dict()])
        self.assertEqual(ts_list[0]["calls"], 6)

    def test_03_manual_earn_then_spend_and_exhaustion(self):
        client = self._client()
        accept = find_d402_accept(client.discover(self.base))
        bundle = client.get_bundle(accept["taskUrl"], "s")
        self.assertEqual(bundle["tier"], "s")
        self.assertEqual(len(bundle["items"]), 5)
        self.assertEqual(bundle["labels"], ["sports", "business", "tech", "world"])
        answers = self._good_solver()(bundle)
        voucher = client.submit(accept["taskUrl"], bundle, answers, accept)
        self.assertEqual(voucher.calls, 10)
        # resubmitting the same bundle is refused
        with self.assertRaises(D402Error) as ctx:
            client.submit(accept["taskUrl"], bundle, answers, accept)
        self.assertEqual(ctx.exception.code, "already_submitted")
        self.assertGreaterEqual(ctx.exception.status, 400)
        # earn() picks the configured tier
        v2 = client.earn(accept)
        self.assertEqual(v2.calls, 10)
        self.assertEqual(len(client.status()), 2)
        # spend the first voucher down to zero; the cache tracks the counter and then evicts it
        remaining = None
        for _ in range(10):
            res = client.fetch(f"{self.base}/search?q=bank")
            self.assertEqual(res.status_code, 200)
            remaining = int(res.headers["D402-Calls-Remaining"])
        self.assertEqual(remaining, 0)
        self.assertEqual(sorted(v.calls for v in client.status()), [0, 10])
        # a non-402, non-2xx from the gated route is returned as is (and still costs a call)
        res = client.fetch(f"{self.base}/search?q=")
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json()["error"], "bad_request")

    def test_04_wrong_answers_raise_after_max_attempts(self):
        calls = {"n": 0}

        def wrong(item, bundle):
            calls["n"] += 1
            right = self.answer_key.get(item["id"])
            return next(label for label in bundle["labels"] if label != right)

        client = self._client(solver=lookup_solver(wrong), max_earn_attempts=3)
        with self.assertRaises(D402Error) as ctx:
            client.fetch(f"{self.base}/search?q=tech")
        self.assertEqual(ctx.exception.code, "earn_failed")
        self.assertEqual(ctx.exception.status, 422)
        self.assertEqual(ctx.exception.body["error"], "quality")
        self.assertIn("3 bundle(s)", ctx.exception.message)
        self.assertEqual(calls["n"], 15)
        self.assertEqual(client.status(), [])

    def test_05_bad_tier_and_no_solver(self):
        client = self._client(solver=None)
        client.solver = None
        accept = find_d402_accept(client.discover(self.base))
        with self.assertRaises(D402Error) as ctx:
            client.earn(accept)
        self.assertEqual(ctx.exception.code, "no_solver")
        client.solver = self._good_solver()
        with self.assertRaises(D402Error) as ctx:
            client.earn(accept, "xl")
        self.assertEqual(ctx.exception.code, "bad_tier")
        self.assertGreaterEqual(ctx.exception.status, 400)
        client.tier = "xl"
        with self.assertRaises(D402Error) as ctx:
            client.earn(accept)
        self.assertEqual(ctx.exception.code, "bad_tier")
        self.assertEqual(ctx.exception.status, 0)

    def test_06_evicts_voucher_the_seller_rejects(self):
        cache_dir = os.path.join(self.tmp, "cache-b")
        client = self._client(cache_dir=cache_dir)
        client.fetch(f"{self.base}/search?q=tech")
        v = client.status()[0]
        # Corrupt the cached token: the seller answers 402 voucher_invalid, the client evicts and earns again.
        client.cache.put(StoredVoucher(**{**v.to_dict(), "token": v.token[:-4] + "AAAA"}))
        res = client.fetch(f"{self.base}/search?q=tech")
        self.assertEqual(res.status_code, 200)
        vouchers = client.status()
        self.assertEqual(len(vouchers), 1)
        self.assertNotEqual(vouchers[0].jti, v.jti)
        self.assertEqual(vouchers[0].calls, 9)

    def test_07_identity_shared_with_ts_client(self):
        path = os.path.join(self.tmp, "ident", "keypair.json")
        kp = Keypair.load_or_create(path)
        out = _node_tsx(
            'import { loadOrCreateKeypair } from "%s/packages/client/src/index.ts";\n'
            'import { signSubmit, verifySubmit } from "%s/packages/spec/src/index.ts";\n'
            "const kp = loadOrCreateKeypair(process.argv[2]);\n"
            'const sig = signSubmit(kp.privateKey, "b_shared", { i_1: "tech", i_2: "world" });\n'
            'const ok = verifySubmit(kp.publicKey, "b_shared", { i_1: "tech", i_2: "world" }, process.argv[3]);\n'
            "console.log(JSON.stringify({ publicKey: kp.publicKey, sig, ok }));\n" % (REPO_ROOT, REPO_ROOT),
            path,
            sign_submit(kp.privateKey, "b_shared", {"i_2": "world", "i_1": "tech"}),
        )
        ts = json.loads(out)
        self.assertEqual(ts["publicKey"], kp.publicKey)
        self.assertEqual(ts["sig"], sign_submit(kp.privateKey, "b_shared", {"i_1": "tech", "i_2": "world"}))
        self.assertTrue(ts["ok"])
        self.assertTrue(verify_submit(kp.publicKey, "b_shared", {"i_1": "tech", "i_2": "world"}, ts["sig"]))
        # and the other way round: a keypair written by the TS client loads here
        ts_path = os.path.join(self.tmp, "ident", "ts-keypair.json")
        out = _node_tsx(
            'import { loadOrCreateKeypair } from "%s/packages/client/src/index.ts";\n'
            "console.log(loadOrCreateKeypair(process.argv[2]).publicKey);\n" % REPO_ROOT,
            ts_path,
        )
        self.assertEqual(Keypair.load_or_create(ts_path).publicKey, out.strip())

    def test_08_cli_round_trip(self):
        home = os.path.join(self.tmp, "home")
        env = dict(os.environ, D402_HOME=home, PYTHONPATH=PKG_ROOT)

        def cli(*args: str) -> subprocess.CompletedProcess:
            return subprocess.run([sys.executable, "-m", "d402", *args], cwd=PKG_ROOT, env=env, capture_output=True, text=True, timeout=120)

        r = cli("keygen")
        self.assertEqual(r.returncode, 0, r.stderr)
        pub = r.stdout.strip()
        self.assertEqual(len(from_b64u(pub)), 32)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(home, "keypair.json")).st_mode), 0o600)
        r = cli("discover", self.base)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["d402"], "1")
        r = cli("earn", self.base, "--tier", "s", "--answers", ANSWER_KEY, "--model", "cli-test")
        self.assertEqual(r.returncode, 0, r.stderr)
        voucher = json.loads(r.stdout)
        self.assertEqual(voucher["calls"], 10)
        self.assertEqual(voucher["sub"], pub)
        r = cli("fetch", f"{self.base}/search?q=gpu")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("D402-Calls-Remaining: 9", r.stderr)
        self.assertIn("hits", json.loads(r.stdout))
        r = cli("status")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)[0]["calls"], 9)
        r = cli("earn", self.base, "--tier", "xl", "--answers", ANSWER_KEY)
        self.assertEqual(r.returncode, 1)
        self.assertIn("bad_tier", r.stderr)

    def test_09_bound_spend_with_nonce_against_a_binding_seller(self):
        """SPEC 7.1 + 7.2 against a seller with bindVouchers and requireSpendNonce on."""
        import requests

        port = _free_port()
        base = f"http://localhost:{port}"
        script = (
            'import { createRequire } from "node:module";\n'
            'import { createD402 } from "%s/packages/server/src/index.ts";\n'
            'const require = createRequire("%s/examples/search-proxy/package.json");\n'
            'const { Hono } = require("hono");\n'
            'const { serve } = require("@hono/node-server");\n'
            "const port = Number(process.argv[2]);\n"
            'const d402 = createD402({ sellerId: "bound-seller", taskUrl: `http://localhost:${port}/.well-known/d402/tasks`,\n'
            '  scope: ["/search"], tiers: [{ id: "s", items: 5, est_tokens: 1000, reward: { calls: 10 } }],\n'
            '  secret: "bound-secret", labels: ["sports", "business", "tech", "world"], bindVouchers: true, requireSpendNonce: true });\n'
            'd402.tasks.loadFile("%s/examples/search-proxy/tasks.jsonl");\n'
            "const app = new Hono();\n"
            'app.get("/health", (c) => c.json({ ok: true }));\n'
            'app.route("/", d402.routes);\n'
            'app.use("/search", d402.gate);\n'
            'app.get("/search", (c) => c.json({ ok: true, q: c.req.query("q") }));\n'
            "serve({ fetch: app.fetch, port });\n" % (REPO_ROOT, REPO_ROOT, REPO_ROOT)
        )
        fd, path = tempfile.mkstemp(suffix=".mts", prefix="d402py-bound-")
        with os.fdopen(fd, "w") as f:
            f.write(script)
        log = tempfile.TemporaryFile(mode="w+")
        proc = subprocess.Popen(
            ["node", "--import", "tsx", path, str(port)], cwd=REPO_ROOT, stdout=log, stderr=subprocess.STDOUT,
            env=dict(os.environ, NODE_NO_WARNINGS="1"),
        )
        try:
            deadline = time.time() + 60
            while time.time() < deadline:
                if proc.poll() is not None:
                    log.seek(0)
                    raise RuntimeError("bound seller exited early:\n" + log.read())
                try:
                    with urllib.request.urlopen(base + "/health", timeout=1) as r:
                        if r.status == 200:
                            break
                except Exception:  # noqa: BLE001
                    time.sleep(0.2)
            else:
                raise RuntimeError("bound seller did not come up")

            # Default client: signed spend with a nonce -> 200.
            client = self._client()
            res = client.fetch(f"{base}/search?q=a")
            self.assertEqual(res.status_code, 200, res.text)
            self.assertEqual(res.headers["D402-Calls-Remaining"], "9")
            res = client.fetch(f"{base}/search?q=b")
            self.assertEqual(res.headers["D402-Calls-Remaining"], "8")

            # Replaying a captured bound spend (same nonce) is refused and costs nothing.
            v = client.status()[0]
            ts = int(time.time())
            nonce = new_nonce()
            headers = {
                "D402-Voucher": v.token,
                "D402-Key": client.keypair.publicKey,
                "D402-Timestamp": str(ts),
                "D402-Nonce": nonce,
                "D402-Sig": sign_spend(client.keypair.privateKey, "GET", "/search", v.jti, ts, nonce),
            }
            first = requests.get(f"{base}/search?q=c", headers=headers, timeout=10)
            self.assertEqual(first.status_code, 200, first.text)
            self.assertEqual(first.headers["D402-Calls-Remaining"], "7")
            replay = requests.get(f"{base}/search?q=c", headers=headers, timeout=10)
            self.assertEqual(replay.status_code, 402)
            self.assertEqual(replay.json()["error"], "replayed_spend")

            # The 5-line form (no nonce) is refused by this seller; the client returns the 402.
            old_style = self._client(keypair=client.keypair, spend_nonce=False)
            old_style.cache.put(v)
            old_style.discover(base)
            res = old_style.fetch(f"{base}/search?q=d")
            self.assertEqual(res.status_code, 402)
            self.assertEqual(res.json()["error"], "bad_signature")

            # No signature at all: bad_key, and the voucher is kept (not an evict error).
            unsigned = self._client(keypair=client.keypair, sign_spends=False)
            unsigned.cache.put(v)
            unsigned.discover(base)
            res = unsigned.fetch(f"{base}/search?q=e")
            self.assertEqual(res.status_code, 402)
            self.assertEqual(res.json()["error"], "bad_key")
            self.assertEqual([x.jti for x in unsigned.status()][:1], [v.jti])

            # A stale timestamp is refused.
            stale = self._client(keypair=client.keypair, now=lambda: int(time.time()) - 1000)
            stale.cache.put(v)
            stale.discover(base)
            res = stale.fetch(f"{base}/search?q=f")
            self.assertEqual(res.status_code, 402)
            self.assertEqual(res.json()["error"], "stale_timestamp")
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
            log.close()
            os.unlink(path)


if __name__ == "__main__":
    unittest.main()
