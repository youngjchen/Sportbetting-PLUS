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


if __name__ == "__main__":
    unittest.main()
