import json
import os

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("SBP_TEST_BASE_URL", "http://127.0.0.1:8765")


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(accept_downloads=True)
        dialogs = []
        page.on("dialog", lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))
        page.goto(f"{BASE_URL}/index.html", wait_until="domcontentloaded")
        page.wait_for_selector("#exportDataBtn", state="attached")
        page.evaluate(
            """
            (() => {
              window.__largeStorage.readJSON = async () => {
                throw new DOMException('Internal error.', 'UnknownError');
              };
              window.__dvSync.fetchCloudCasts = async () => ([
                { ts: '2026-10-06T08:00:00Z', officialId: 'cloud-rescue' }
              ]);
              return true;
            })()
            """
        )

        with page.expect_download(timeout=15000) as download_info:
            page.locator("#exportDataBtn").evaluate("el => el.click()")
        download = download_info.value
        path = download.path()
        with open(path, "r", encoding="utf-8") as backup_file:
            payload = json.load(backup_file)

        assert payload["dvManualCasts"][0]["officialId"] == "cloud-rescue"
        assert payload["dvManualCastsWnba"] == []
        assert len(payload["__backupWarnings"]) >= 1
        assert any("備份已下載" in message for message in dialogs), dialogs
        assert not any("備份失敗" in message for message in dialogs), dialogs
        page.close()

        page = browser.new_page(accept_downloads=True)
        dialogs = []
        page.on("dialog", lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))
        page.goto(f"{BASE_URL}/nba.html", wait_until="domcontentloaded")
        page.wait_for_selector("#exportDataBtn", state="attached")
        page.evaluate(
            """
            (() => {
              window.__largeStorage.readJSON = async () => {
                throw new DOMException('Internal error.', 'UnknownError');
              };
              return true;
            })()
            """
        )
        with page.expect_download(timeout=15000) as download_info:
            page.locator("#exportDataBtn").evaluate("el => el.click()")
        download = download_info.value
        with open(download.path(), "r", encoding="utf-8") as backup_file:
            payload = json.load(backup_file)
        assert payload["nbaDoc"]["boards"] is not None
        assert payload["dvManualCastsWnba"] == []
        assert len(payload["__backupWarnings"]) == 1
        assert any("備份已下載" in message for message in dialogs), dialogs
        assert not any("備份失敗" in message for message in dialogs), dialogs
        browser.close()

    print("persistent IndexedDB failure: baseball and basketball backups still download")


if __name__ == "__main__":
    main()
