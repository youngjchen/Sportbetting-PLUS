import json
import os
import tempfile

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("SBP_TEST_BASE_URL", "http://127.0.0.1:8765")
DATE = "2026-10-06"


def board_doc(label):
    return {
        "activeDate": DATE,
        "boards": {DATE: {"label": label, "items": []}},
        "games": [],
        "recent": [],
        "stats": {},
    }


def seed_all(page):
    documents = {
        "sportbetting_plus_doc_v2": board_doc("baseball"),
        "sportbetting_nba_doc_v1": board_doc("basketball"),
        "sportbetting_nhl_doc_v1": board_doc("hockey"),
    }
    page.evaluate(
        """documents => {
          for (const [key, value] of Object.entries(documents)) {
            localStorage.setItem(key, JSON.stringify(value));
          }
        }""",
        documents,
    )
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("#exportDataBtn", state="attached")
    page.evaluate(
        """async () => {
          await window.__largeStorage.writeJSON('baseball-casts', [{ts:'2026-10-06T01:00:00Z',officialId:'B'}], 'dvManualCasts');
          await window.__largeStorage.writeJSON('wnba-casts', [{ts:'2026-10-06T02:00:00Z',officialId:'W'}], 'dvManualCastsWnba');
          await window.__largeStorage.writeJSON('nhl-casts', [{ts:'2026-10-06T03:00:00Z',officialId:'H'}], 'dvManualCastsNhl');
        }"""
    )


def assert_unified_download(browser, path):
    context = browser.new_context(accept_downloads=True)
    page = context.new_page()
    page.on("dialog", lambda dialog: dialog.dismiss())
    page.goto(f"{BASE_URL}/{path}", wait_until="domcontentloaded")
    seed_all(page)
    with page.expect_download(timeout=15000) as download_info:
        page.locator("#exportDataBtn").evaluate("element => element.click()")
    download = download_info.value
    assert download.suggested_filename == f"全運動排盤備份_{DATE}.json", repr(download.suggested_filename)
    with open(download.path(), "r", encoding="utf-8") as backup_file:
        payload = json.load(backup_file)
    assert payload["__envelope"] == "sbplus-all-sports-backup-v3"
    assert set(payload["documents"]) >= {"baseball", "basketball", "hockey"}
    assert set(payload["ledgers"]) >= {"baseball", "wnba", "nhl"}
    assert all(payload["documents"][sport]["boards"] for sport in ("baseball", "basketball", "hockey"))
    assert payload["ledgers"]["baseball"][0]["officialId"] == "B"
    assert payload["ledgers"]["wnba"][0]["officialId"] == "W"
    assert payload["ledgers"]["nhl"][0]["officialId"] == "H"
    context.close()


def assert_unified_import(browser):
    payload = {
        "__envelope": "sbplus-all-sports-backup-v3",
        "createdAt": "2026-10-06T00:00:00.000Z",
        "documents": {
            "baseball": board_doc("restored-baseball"),
            "basketball": board_doc("restored-basketball"),
            "hockey": board_doc("restored-hockey"),
        },
        "ledgers": {
            "baseball": [{"ts": "2026-10-06T04:00:00Z", "officialId": "RB"}],
            "wnba": [{"ts": "2026-10-06T05:00:00Z", "officialId": "RW"}],
            "nhl": [{"ts": "2026-10-06T06:00:00Z", "officialId": "RH"}],
        },
    }
    with tempfile.NamedTemporaryFile("w", suffix=".json", encoding="utf-8", delete=False) as handle:
        json.dump(payload, handle, ensure_ascii=False)
        import_path = handle.name
    try:
        context = browser.new_context()
        page = context.new_page()
        dialogs = []
        page.on("dialog", lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))
        page.goto(f"{BASE_URL}/nba.html", wait_until="domcontentloaded")
        seed_all(page)
        page.set_input_files("#importFile", import_path)
        page.wait_for_timeout(800)
        restored = page.evaluate(
            """async () => ({
              baseball: JSON.parse(localStorage.getItem('sportbetting_plus_doc_v2')),
              basketball: JSON.parse(localStorage.getItem('sportbetting_nba_doc_v1')),
              hockey: JSON.parse(localStorage.getItem('sportbetting_nhl_doc_v1')),
              baseballLedger: await window.__largeStorage.readJSON('baseball-casts','dvManualCasts'),
              wnbaLedger: await window.__largeStorage.readJSON('wnba-casts','dvManualCastsWnba'),
              nhlLedger: await window.__largeStorage.readJSON('nhl-casts','dvManualCastsNhl')
            })"""
        )
        assert restored["baseball"]["boards"][DATE]["label"] == "restored-baseball"
        assert restored["basketball"]["boards"][DATE]["label"] == "restored-basketball"
        assert restored["hockey"]["boards"][DATE]["label"] == "restored-hockey"
        assert any(row["officialId"] == "RB" for row in restored["baseballLedger"])
        assert any(row["officialId"] == "RW" for row in restored["wnbaLedger"])
        assert any(row["officialId"] == "RH" for row in restored["nhlLedger"])
        assert any("匯入完成" in message or "已匯入" in message for message in dialogs), dialogs
        context.close()
    finally:
        os.unlink(import_path)


def assert_baseball_import_recovers_corrupt_primary(browser):
    payload = {
        "__envelope": "sbplus-all-sports-backup-v3",
        "documents": {"baseball": board_doc("recovered-after-corruption")},
        "ledgers": {},
    }
    with tempfile.NamedTemporaryFile("w", suffix=".json", encoding="utf-8", delete=False) as handle:
        json.dump(payload, handle, ensure_ascii=False)
        import_path = handle.name
    try:
        context = browser.new_context()
        page = context.new_page()
        page.on("dialog", lambda dialog: dialog.dismiss())
        page.goto(f"{BASE_URL}/index.html", wait_until="domcontentloaded")
        page.evaluate("localStorage.setItem('sportbetting_plus_doc_v2', '{broken')")
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector("#importDataBtn", state="attached")
        with page.expect_file_chooser() as chooser_info:
            page.locator("#importDataBtn").evaluate("element => element.click()")
        chooser_info.value.set_files(import_path)
        page.wait_for_timeout(800)
        restored = page.evaluate(
            """async () => {
              const raw=localStorage.getItem('sportbetting_plus_doc_v2');
              try { return await window.__storagePressure.decodeLegacyPayload(raw); }
              catch (_) { return null; }
            }"""
        )
        assert restored is not None
        assert restored["boards"][DATE]["label"] == "recovered-after-corruption"
        context.close()
    finally:
        os.unlink(import_path)


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for page_name in ("index.html", "nba.html", "nhl.html"):
            assert_unified_download(browser, page_name)
        assert_unified_import(browser)
        assert_baseball_import_recovers_corrupt_primary(browser)
        browser.close()
    print("all sports pages export and import one unified backup")


if __name__ == "__main__":
    main()
