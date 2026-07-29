import importlib.util
import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("fetch_sidecar", ROOT / "fetch_sidecar.py")
SIDECAR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SIDECAR)


class UnwrapJsonTests(unittest.TestCase):
    def test_unwraps_browser_paragraph_wrapper(self):
        wrapped = '<html><body><p>{"rankers":{"11":[{"userid":"u1"}]}}</p></body></html>'
        self.assertEqual(
            SIDECAR.unwrap_json(wrapped),
            '{"rankers":{"11":[{"userid":"u1"}]}}',
        )

    def test_leaves_real_html_unchanged(self):
        page = '<html><body><h1>MLB</h1></body></html>'
        self.assertEqual(SIDECAR.unwrap_json(page), page)


class FallbackFlowTests(unittest.TestCase):
    def fetch(self, **kwargs):
        self.assertTrue(
            hasattr(SIDECAR, "fetch_with_fallback"),
            "fetch_sidecar must expose the production fallback controller",
        )
        return SIDECAR.fetch_with_fallback(**kwargs)

    def test_json_uses_page_xhr_when_http_body_is_not_valid_json(self):
        calls = []
        status, body, layer = self.fetch(
            url="https://www.playsport.cc/api",
            headers={"Accept": "application/json"},
            timeout_ms=20000,
            http_get=lambda *_: (200, "{broken"),
            browser_fetch=lambda *_: self.fail("HTML browser path must not run for JSON"),
            xhr_fetch=lambda *_: (calls.append("xhr") or (200, '{"rankers":{}}')),
            solve_fetch=lambda *_: self.fail("Cloudflare solver must not run for JSON"),
        )
        self.assertEqual((status, body, layer), (200, '{"rankers":{}}', "page-xhr"))
        self.assertEqual(calls, ["xhr"])

    def test_html_uses_cloudflare_solver_when_the_first_browser_gets_a_challenge(self):
        calls = []
        status, body, layer = self.fetch(
            url="https://www.playsport.cc/member/u1",
            headers={},
            timeout_ms=60000,
            http_get=lambda *_: self.fail("HTTP JSON path must not run for HTML"),
            browser_fetch=lambda *_: (503, "<title>Just a moment...</title>"),
            xhr_fetch=lambda *_: self.fail("XHR JSON path must not run for HTML"),
            solve_fetch=lambda *_: (calls.append("solve") or (200, "<html>real member page</html>")),
        )
        self.assertEqual((status, body, layer), (200, "<html>real member page</html>", "solve-cloudflare"))
        self.assertEqual(calls, ["solve"])

    def test_fallback_raises_when_the_last_layer_is_still_a_challenge(self):
        with self.assertRaisesRegex(RuntimeError, "challenge"):
            self.fetch(
                url="https://www.playsport.cc/member/u1",
                headers={},
                timeout_ms=60000,
                http_get=lambda *_: self.fail("HTTP JSON path must not run for HTML"),
                browser_fetch=lambda *_: (200, "<title>Just a moment...</title>"),
                xhr_fetch=lambda *_: self.fail("XHR JSON path must not run for HTML"),
                solve_fetch=lambda *_: (200, '<script src="challenges.cloudflare.com/x"></script>'),
            )


if __name__ == "__main__":
    unittest.main()
