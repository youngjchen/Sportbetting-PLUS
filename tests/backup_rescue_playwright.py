import json
import os

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("SBP_TEST_BASE_URL", "http://127.0.0.1:8765")


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(accept_downloads=True)
        page.on("dialog", lambda dialog: dialog.dismiss())
        downloads = []
        page.on("download", lambda download: downloads.append(download))
        page.goto(
            f"{BASE_URL}/index.html?rescueBackup=1",
            wait_until="domcontentloaded",
        )
        page.wait_for_timeout(20000)

        assert len(downloads) == 1, downloads
        download = downloads[0]
        assert download.suggested_filename.startswith("排盤備份_")
        assert download.suggested_filename.endswith("_救援.json")
        with open(download.path(), "r", encoding="utf-8") as backup_file:
            payload = json.load(backup_file)

        assert payload["__envelope"] == "sbplus-backup-v2"
        assert payload["doc"]["boards"] is not None
        browser.close()

    print("rescue query downloads a validated backup")


if __name__ == "__main__":
    main()
