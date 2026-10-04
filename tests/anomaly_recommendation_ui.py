import json
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "test-results"
BASE_URL = (ROOT / "index.html").as_uri()
DATE = "2026-10-04"
OFFICIAL_ID = "MLB_20261004_TEST_AWAY@TEST_HOME_0100"


def settled_games():
    games = []
    for index in range(60):
        favorite_won = index < 39
        games.append({
            "sid": f"history-{index}",
            "league": "mlb",
            "date": f"2026-09-{index % 28 + 1:02d}",
            "flipState": "flipped",
            "awayTeam": "測試客隊",
            "homeTeam": "測試主隊",
            "awayScore": 4 if favorite_won else 2,
            "homeScore": 2 if favorite_won else 4,
            "closeOddsAway": 1.60,
            "closeOddsHome": 2.20,
            "hdFav": "away",
            "hdResult": "fav_cover" if index < 21 else "fav_nocover",
            "totResult": "over" if index < 21 else "under",
            "nrfiStatus": "nrfi" if index < 39 else "yrfi",
            "awayFirst": 0 if index < 39 else 1,
            "homeFirst": 0,
            "preGameSwap": False,
        })
    return games


def seven_class_history():
    rows = []
    for index in range(60):
        rows.append({
            "alertKey": f"seven-{index}",
            "league": "mlb",
            "date": f"2026-08-{index % 28 + 1:02d}",
            "away": "測試客隊",
            "home": "測試主隊",
            "relation": "顛倒",
            "swapCombo": "neither",
            "mlFavoriteWin": index < 39,
            "handicapResult": "cover" if index < 21 else "nocover",
            "totalResult": "over" if index < 21 else "under",
            "nrfi": index < 39,
        })
    return {"stakeBySid": {}, "bet365Taiwan": rows}


def board_document():
    card = {
        "id": 9701,
        "type": "match",
        "officialId": OFFICIAL_ID,
        "league": "mlb",
        "away": "測試客隊",
        "home": "測試主隊",
        "gameTime": "01:00",
        "hdFav": "away",
        "hdVal": 1.5,
        "totVal": 7.5,
        "platformFlip": True,
        "flipVanished": False,
        "preGameSwap": False,
        "mlAway": {"lights": 0},
        "mlHome": {"lights": 0},
        "hdGive": {"lights": 0},
        "hdRecv": {"lights": 0},
        "over": {"lights": 0},
        "under": {"lights": 0},
        "collapsed": False,
    }
    return {
        "version": 2,
        "activeDate": DATE,
        "boards": {DATE: {"items": [card], "summaryPos": None}},
        "games": settled_games(),
        "stats": {},
        "recent": [],
    }


def stake_feed():
    return {
        "schemaVersion": 1,
        "provider": "stake-official",
        "generatedAt": "2026-10-04T00:00:00.000Z",
        "leagues": {},
        "matches": {
            OFFICIAL_ID: {
                "officialId": OFFICIAL_ID,
                "league": "MLB",
                "scheduledStart": "2026-10-03T17:00:00.000Z",
                "away": "測試客隊",
                "home": "測試主隊",
                "favorite": "away",
                "canonicalLine": 1.5,
                "moneyline": {"away": 1.95, "home": 2.05},
                "handicapOdds": {"away": 2.25, "home": 1.90},
                "total": {"line": 7.5, "over": 1.72, "under": 1.92},
                "observedAt": "2026-10-03T16:50:00.000Z",
                "frozenAt": None,
                "favoriteFlipCount": 0,
                "favoriteTransitions": [],
                "sources": {
                    "direction": "stake-official",
                    "handicapOdds": "stake-official",
                    "moneyline": "stake-official",
                    "total": "stake-official",
                },
            }
        },
    }


def run_viewport(page, width, height, screenshot_name, document, history, monitored):
    page.set_viewport_size({"width": width, "height": height})
    page.goto(BASE_URL, wait_until="load")
    page.wait_for_function("typeof window.buildAnomalyRecommendation === 'function'")
    page.wait_for_timeout(1500)
    mounted = page.evaluate(
        """([board, anomalyHistory, stakeGame]) => {
          doc = board;
          loadActiveBoard();
          __ctMemo=null; __ctMemoAt=0;
          window.anomalyNrfiHistory = anomalyHistory;
          const card=state.items[0];
          const intlKey=`mlb|2026-10-04|${card.away}|${card.home}|01:00`;
          __intl = {games:{[intlKey]:{
            is:'away',il:1.5,sw:0,ls:'home',ll:1.5,lsw:0,v:'flip',u:'2026-10-03T16:50:00.000Z'
          }}};
          const fixedIntl=__intl.games[intlKey];
          intlFor=() => fixedIntl;
          intlVerdict=() => ({be:null,side:'away',line:1.5,v:'flip',lag:false,dv:false});
          window.__baseballBet365Integration = {gameFor:() => null};
          window.__oddsPortalIntegration = {gameFor:() => null};
          window.__baseballStakeIntegration = {gameFor:() => stakeGame};
          render();
          return !!document.querySelector('.anom-decision');
        }""",
        [document, history, monitored],
    )
    assert mounted
    strip = page.locator(".anom-decision").first
    strip.wait_for(state="visible", timeout=10_000)
    assert strip.locator(".anom-pick").count() == 2
    assert "異常決策" in strip.inner_text()
    if "兩套共識" not in strip.inner_text():
        diagnostics = page.evaluate(
            """() => {
              const card=state.items[0], ist=intlFor(card), iv=intlVerdict(card,ist);
              const snap=(ist&&iv&&window.buildBet365TaiwanSnapshot)?window.buildBet365TaiwanSnapshot(ist,iv):null;
              const all=window.collectBet365Taiwan?window.collectBet365Taiwan('all',doc.games):null;
              return {card,ist,iv,snap,total:all&&all.total,
                bucket:snap&&all&&all.groups[snap.relation==='顛倒'?'inverted':'converged'][snap.swapCombo]};
            }"""
        )
        raise AssertionError({"text": strip.inner_text(), "diagnostics": diagnostics})
    assert "Stake" in strip.inner_text()

    sizes = strip.evaluate(
        """element => ({
          stripWidth: element.getBoundingClientRect().width,
          cardWidth: element.closest('.bcard').getBoundingClientRect().width,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth
        })"""
    )
    assert sizes["stripWidth"] <= sizes["cardWidth"] + 1, sizes
    assert sizes["scrollWidth"] <= sizes["clientWidth"] + 1, sizes

    strip.locator(".anom-decision-toggle").evaluate("element => element.click()")
    assert strip.locator(".anom-detail-row").count() == 4
    assert strip.locator(".anom-decision-detail").is_visible()
    nrfi = strip.locator('[data-market="nrfi"]').last.inner_text()
    assert "NRFI" in nrfi
    assert "只看方向" in nrfi
    assert "Stake" not in nrfi

    page.screenshot(path=str(RESULTS / screenshot_name), full_page=True)


def main():
    RESULTS.mkdir(exist_ok=True)
    document = board_document()
    history = seven_class_history()
    feed = stake_feed()
    monitored = feed["matches"][OFFICIAL_ID]
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        console_errors = []
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        run_viewport(page, 1440, 1000, "anomaly-recommendation-desktop.png", document, history, monitored)
        run_viewport(page, 390, 844, "anomaly-recommendation-mobile.png", document, history, monitored)
        relevant_errors = [
            line for line in console_errors
            if "Failed to load resource" not in line
            and "ERR_FAILED" not in line
            and "URL scheme \"file\" is not supported" not in line
            and "[divination-addon]" not in line
        ]
        assert not relevant_errors, relevant_errors
        browser.close()
    print("anomaly recommendation UI: desktop/mobile verified")


if __name__ == "__main__":
    main()
