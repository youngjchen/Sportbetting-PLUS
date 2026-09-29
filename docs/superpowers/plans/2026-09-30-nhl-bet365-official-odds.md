# NHL Bet365 Official Odds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立每 5 分鐘抓取 Bet365 官方 NHL 獨贏與讓分賠率的獨立管線，並把正確的讓分方、盤口與賠率接到 NHL 卡片。

**Architecture:** `nhl_bet365_core.js` 放 Node 與瀏覽器共用的隊名、配對及歷史合併純函式；`nhl_bet365_odds.js` 專責官方頁解析、驗證與原子寫檔；`nhl.html` 只載入產物並渲染。獨立 GitHub Actions 長迴圈每 5 分鐘執行，不碰棒球或 Stake 實驗檔。

**Tech Stack:** Node.js 20、Cheerio、現有 Scrapling sidecar、GitHub Actions、原生瀏覽器 JavaScript、Node test runner。

**Spec:** `docs/superpowers/specs/2026-09-30-nhl-bet365-official-odds-design.md`

## Global Constraints

- 唯一賠率來源是 Bet365 官方 NHL hub；不混入台彩、Stake 或其他莊家。
- 只把 Money Line 與 Puck Line 當成 Bet365 有效市場；大小分維持可編輯、預設 6.5。
- Puck Line 的負數選項是讓分方，禁止用賠率高低猜讓分方。
- 無效、挑戰或不完整頁面不得覆蓋上一份有效 JSON。
- 新增獨立 `data/nhl_bet365_odds.json` 與獨立 workflow；不改棒球 workflow。
- 手動 `hdFavOverride` 優先於 Bet365 自動讓分方。
- workflow YAML 必須是無 BOM UTF-8。

---

### Task 1: 共用 NHL Bet365 資料模型

**Files:**
- Create: `nhl_bet365_core.js`
- Test: `tests/nhl_bet365_core.test.js`

**Interfaces:**
- Produces: `TEAM_ZH`, `translateTeam(name)`, `stableGameKey(game)`, `mergeBet365Game(previous, current, observedAt)`, `findBet365Game(feed, pregame, toleranceMs)`。
- `findBet365Game` 回傳 `{ game, latest, open, ml, hd, changes }` 或 `null`。

- [ ] **Step 1: Write the failing tests**

```js
test('maps all 32 NHL teams and rejects an unknown name', () => {
  assert.equal(Object.keys(TEAM_ZH).length, 32);
  assert.equal(translateTeam('FLA Panthers'), '佛羅里');
  assert.throws(() => translateTeam('Unknown Club'), /未知/);
});

test('history changes only when a normalized market changes', () => {
  const first = mergeBet365Game(null, game, '2026-09-30T00:00:00Z');
  const same = mergeBet365Game(first, game, '2026-09-30T00:05:00Z');
  assert.equal(same.history.length, 1);
  const changed = mergeBet365Game(same, { ...game, ml: { ...game.ml, outcomes: [{ side:'away', odds:2.1 }, { side:'home', odds:1.7 }] } }, '2026-09-30T00:10:00Z');
  assert.equal(changed.history.length, 2);
});

test('matches teams and nearest start time within twelve hours', () => {
  const match = findBet365Game(feed, { away:'佛羅里', home:'颶風', date:'2026-09-30', time:'07:00' });
  assert.equal(match.game.awayZh, '佛羅里');
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `node --test tests/nhl_bet365_core.test.js`

Expected: FAIL because `nhl_bet365_core.js` does not exist.

- [ ] **Step 3: Implement the UMD-style pure module**

```js
(function(root, factory){
  const api=factory();
  if(typeof module==='object' && module.exports) module.exports=api;
  if(root) root.NhlBet365=api;
})(typeof globalThis!=='undefined'?globalThis:this, function(){
  const TEAM_ZH = Object.freeze({
    Ducks:'巨鴨', Bruins:'棕熊', Sabres:'軍刀', Flames:'火焰', Hurricanes:'颶風',
    Blackhawks:'黑鷹', Avalanche:'雪崩', 'Blue Jackets':'藍衣', Stars:'達拉斯',
    'Red Wings':'紅翼', Oilers:'油人', Panthers:'佛羅里', Kings:'國王', Wild:'荒野',
    Canadiens:'加拿大', Predators:'掠奪者', Devils:'魔鬼', Islanders:'島人', Rangers:'遊騎兵',
    Senators:'參議員', Flyers:'飛人', Penguins:'企鵝', Sharks:'鯊魚', Kraken:'海怪',
    Blues:'藍調', Lightning:'閃電', 'Maple Leafs':'楓葉', Mammoth:'猛瑪象', Canucks:'加人',
    'Golden Knights':'騎士', Capitals:'首都', Jets:'噴射機'
  });
  function translateTeam(name){
    const text=String(name||'').trim();
    const key=Object.keys(TEAM_ZH).find(k=>text===k||text.endsWith(` ${k}`));
    const value=key&&TEAM_ZH[key];
    if(!value) throw new Error(`未知 NHL 隊名：${name}`);
    return value;
  }
  function stableGameKey(game){
    return `${Number(game.startTime)}|${game.away}|${game.home}`;
  }
  function marketSnapshot(game){ return { ml:game&&game.ml||null, hd:game&&game.hd||null }; }
  function mergeBet365Game(previous,current,observedAt){
    const history=Array.isArray(previous&&previous.history)?previous.history.slice():[];
    const snapshot={ at:observedAt, ...marketSnapshot(current) };
    if(!history[0]||JSON.stringify(marketSnapshot(history[0]))!==JSON.stringify(marketSnapshot(snapshot))) history.unshift(snapshot);
    return { ...(previous||{}), ...current, history:history.slice(0,240) };
  }
  function findBet365Game(feed,pregame,toleranceMs=12*3600000){
    const target=Date.parse(`${pregame.date}T${pregame.time}:00+08:00`);
    const rows=Object.values(feed&&feed.games||{}).filter(x=>x.awayZh===pregame.away&&x.homeZh===pregame.home);
    const timed=rows.filter(x=>Number.isFinite(Number(x.startTime))).sort((a,b)=>Math.abs(a.startTime-target)-Math.abs(b.startTime-target));
    if(!timed[0]||!Number.isFinite(target)||Math.abs(timed[0].startTime-target)>toleranceMs) return null;
    const history=timed[0].history||[], latest=history[0]||timed[0], open=history.at(-1)||timed[0];
    return { game:timed[0], latest, open, ml:latest.ml, hd:latest.hd, changes:Math.max(0,history.length-1) };
  }
  return { TEAM_ZH, translateTeam, stableGameKey, mergeBet365Game, findBet365Game };
});
```

- [ ] **Step 4: Run tests and confirm pass**

Run: `node --test tests/nhl_bet365_core.test.js`

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add nhl_bet365_core.js tests/nhl_bet365_core.test.js
git commit -m "feat: add NHL Bet365 odds model"
```

### Task 2: Bet365 官方頁解析與安全寫檔

**Files:**
- Create: `nhl_bet365_odds.js`
- Create: `tests/nhl_bet365_odds.test.js`
- Create: `tests/fixtures/nhl-bet365-hub.html`
- Create: `data/nhl_bet365_odds.json`

**Interfaces:**
- Consumes: `translateTeam`, `stableGameKey`, `mergeBet365Game` from `nhl_bet365_core.js`; `fetchText` from `sidecar_client.js`。
- Produces: `parseBet365NhlHub(html)`, `collectBet365NhlOdds(options)`, `saveAtomic(file, value)`, CLI `node nhl_bet365_odds.js`。

- [ ] **Step 1: Write parser and collector failure tests**

```js
test('parses decimal moneyline and signed puck-line without swapping teams', () => {
  const games=parseBet365NhlHub(fixtureHtml);
  assert.deepEqual(games[0].ml.outcomes.map(x=>x.odds), [2.05, 1.72]);
  assert.deepEqual(games[0].hd.outcomes.map(x=>x.line), [1.5, -1.5]);
  assert.equal(games[0].hd.favSide, 'home');
  assert.equal(games[0].hd.line, 1.5);
});

test('rejects challenge and incomplete pages', async () => {
  await assert.rejects(() => collectBet365NhlOdds({ fetchText:async()=>'<title>Just a moment</title>', previous:{games:{}} }), /無有效|挑戰/);
  await assert.rejects(() => collectBet365NhlOdds({ fetchText:async()=>moneylineOnly, previous:{games:{}} }), /不完整/);
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `node --test tests/nhl_bet365_odds.test.js`

Expected: FAIL because parser module does not exist.

- [ ] **Step 3: Implement exact parsing and validation**

```js
function firstNumber(text){
  const found=String(text||'').match(/[+-]?\d+(?:\.\d+)?/);
  return found?Number(found[0]):null;
}
function validTwoSides(outcomes){
  return outcomes['Away Win']&&outcomes['Home Win']&&
    Number.isFinite(outcomes['Away Win'].odds)&&Number.isFinite(outcomes['Home Win'].odds);
}
function moneyLineMarket(game,outcomes){
  return { market:'Money Line', outcomes:[
    { name:game.away, side:'away', odds:outcomes['Away Win'].odds },
    { name:game.home, side:'home', odds:outcomes['Home Win'].odds }
  ] };
}
function puckLineMarket(game,outcomes){
  const awayLine=outcomes['Away Win'].line, homeLine=outcomes['Home Win'].line;
  if(!Number.isFinite(awayLine)||!Number.isFinite(homeLine)||Math.sign(awayLine)===Math.sign(homeLine)) return null;
  return { market:'Puck Line', line:Math.abs(awayLine), favSide:awayLine<0?'away':'home', outcomes:[
    { name:game.away, side:'away', line:awayLine, odds:outcomes['Away Win'].odds },
    { name:game.home, side:'home', line:homeLine, odds:outcomes['Home Win'].odds }
  ] };
}
function parseBet365NhlHub(html) {
  const $=cheerio.load(String(html||''));
  const games=new Map();
  $('li[data-item-category2="NHL"][data-item-name]').each((_, element)=>{
    const [away,home]=String($(element).attr('data-item-name')||'').split(/\s+@\s+/);
    const startTime=Date.parse($(element).find('[data-utc]').first().attr('data-utc'));
    if(!away||!home||!Number.isFinite(startTime)) return;
    const key=`${startTime}|${away.trim()}|${home.trim()}`;
    const game=games.get(key)||{ startTime, away:away.trim(), home:home.trim(), awayZh:translateTeam(away), homeZh:translateTeam(home) };
    const outcomes={};
    $(element).find('[data-item-variant]').each((__,link)=>{
      outcomes[$(link).attr('data-item-variant')]={ odds:Number($(link).attr('data-item-odds')), line:firstNumber($(link).text()) };
    });
    const category=$(element).attr('data-item-category3');
    if(category==='Money Line'&&validTwoSides(outcomes)) game.ml=moneyLineMarket(game,outcomes);
    if(category==='Puck Line'&&validTwoSides(outcomes)){
      const hd=puckLineMarket(game,outcomes);
      if(hd) game.hd=hd;
    }
    games.set(key,game);
  });
  return [...games.values()].filter(game=>game.ml || game.hd);
}

async function collectBet365NhlOdds(options={}) {
  const html=await (options.fetchText||fetchOfficial)(HUB_URL);
  const parsed=parseBet365NhlHub(html);
  const complete=parsed.filter(game=>game.ml && game.hd);
  if(!complete.length) throw new Error('Bet365 NHL 頁面無有效完整市場');
  const now=Number.isFinite(Number(options.now))?Number(options.now):Date.now();
  const observedAt=new Date(now).toISOString();
  const previous=options.previous&&options.previous.games||{};
  const games={};
  for(const game of complete){
    const key=stableGameKey(game);
    games[key]=mergeBet365Game(previous[key],game,observedAt);
  }
  const cutoff=now-3*86400000;
  for(const [key,game] of Object.entries(previous)){
    if(!games[key]&&Number(game.startTime)>=cutoff) games[key]=game;
  }
  return { provider:'bet365-official', updated:observedAt, health:{status:'ok', gameCount:complete.length}, games };
}
```

- [ ] **Step 4: Run parser tests and confirm pass**

Run: `node --test tests/nhl_bet365_odds.test.js`

Expected: all tests PASS.

- [ ] **Step 5: Run against the live official page**

Run: `$env:EP_TRANSPORT='sidecar'; node nhl_bet365_odds.js`

Expected: exit 0, `data/nhl_bet365_odds.json` provider is `bet365-official`, and at least one game has both `ml` and `hd`.

- [ ] **Step 6: Commit**

```bash
git add nhl_bet365_odds.js tests/nhl_bet365_odds.test.js tests/fixtures/nhl-bet365-hub.html data/nhl_bet365_odds.json
git commit -m "feat: collect official Bet365 NHL odds"
```

### Task 3: NHL 卡片接入 Bet365

**Files:**
- Modify: `nhl.html:513-856`
- Modify: `nhl.html:1725-1970`
- Modify: `nhl.html:2027-2050`
- Test: `tests/nhl_bet365_frontend.test.js`

**Interfaces:**
- Consumes: browser global `window.NhlBet365.findBet365Game` and `data/nhl_bet365_odds.json`。
- Produces: `bet365OddsFor(g)`, model fields `bet365`, `hdFav`, `hdVal`, `hdSrc:'BET365'`。

- [ ] **Step 1: Write frontend contract tests**

```js
test('NHL page loads Bet365 feed and no longer loads Stake as active card source', () => {
  assert.match(html, /data\/nhl_bet365_odds\.json/);
  assert.doesNotMatch(html, /fetch\(`data\/stake_api_odds\.json/);
});

test('manual favorite override remains above Bet365 favorite', () => {
  assert.match(html, /hdFavFor\([^)]*bet365Fav/);
  assert.match(html, /hdFavOverride/);
});

test('total fallback remains exactly 6.5', () => {
  assert.match(html, /DEFAULT_NHL_TOTAL_LINE\s*=\s*6\.5/);
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `node --test tests/nhl_bet365_frontend.test.js`

Expected: FAIL because the page still fetches Stake data.

- [ ] **Step 3: Load the shared browser module and official JSON**

```html
<script src="./nhl_bet365_core.js?v=20260930b3651"></script>
```

```js
const r2=await fetch(`data/nhl_bet365_odds.json?t=${Date.now()}`);
if(r2.ok){
  const j2=await r2.json();
  if(j2 && j2.provider==='bet365-official' && j2.games) oddsCache=j2;
}
```

- [ ] **Step 4: Apply Bet365 line before rendering while preserving manual override**

```js
function hdFavFor(g, it, bet365Fav){
  if(it.hdFavOverride==='away'||it.hdFavOverride==='home') return it.hdFavOverride;
  return bet365Fav==='away'||bet365Fav==='home' ? bet365Fav :
    ((g.hdFav==='away'||g.hdFav==='home') ? g.hdFav : DEFAULT_NHL_HD_FAV);
}

function modelFromPregame(g){
  const it=ensureItem(g.date,g.officialId);
  const bet365=bet365OddsFor(g);
  const hdVal=bet365&&bet365.hd ? Math.abs(Number(bet365.hd.line)) : g.hdVal;
  const hdFav=hdFavFor(g,it,bet365&&bet365.hd&&bet365.hd.favSide);
  return { ...g, hdFav, hdVal, hdSrc:bet365&&bet365.hd?'BET365':g.hdSrc, bet365, _item:it };
}
```

- [ ] **Step 5: Replace active Stake labels with Bet365 prices and trend**

The ML rows show `BET365 2.05` / `BET365 1.72`; puck rows show each team's signed line and decimal odds. The detail strip shows opening to latest Bet365 price/line and never claims a Bet365 total.

- [ ] **Step 6: Run frontend contract tests**

Run: `node --test tests/nhl_bet365_frontend.test.js`

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add nhl.html tests/nhl_bet365_frontend.test.js
git commit -m "feat: show Bet365 odds on NHL cards"
```

### Task 4: Five-minute GitHub Actions pipeline

**Files:**
- Create: `.github/workflows/nhl-bet365-odds.yml`
- Test: `tests/nhl_bet365_workflow.test.js`

**Interfaces:**
- Consumes: `node nhl_bet365_odds.js`, `WORKFLOW_PAT` secret, existing `requirements-scraping.txt` and Scrapling install commands。
- Produces: a `nhl-bet365-odds` concurrency group and self-handoff loop.

- [ ] **Step 1: Write workflow contract test**

```js
test('workflow loops every 300 seconds and commits only Bet365 NHL data', () => {
  assert.match(yaml, /SECONDS \+ 18600/);
  assert.match(yaml, /300 - EL/);
  assert.match(yaml, /node nhl_bet365_odds\.js/);
  assert.match(yaml, /git add data\/nhl_bet365_odds\.json/);
  assert.doesNotMatch(yaml, /stake_api_odds/);
});
```

- [ ] **Step 2: Run test and confirm failure**

Run: `node --test tests/nhl_bet365_workflow.test.js`

Expected: FAIL because workflow does not exist.

- [ ] **Step 3: Create dedicated long-running workflow**

The workflow checks out main, installs Node/Python dependencies and Scrapling browser, loops for 18,600 seconds, resets to current `origin/main` before each run, runs the scraper with a 240-second timeout, commits only `data/nhl_bet365_odds.json`, safely rebases on concurrent commits, waits until 300 seconds elapsed, and dispatches `nhl-bet365-odds.yml` using `WORKFLOW_PAT` after completion.

- [ ] **Step 4: Verify YAML and BOM**

Run: `node --test tests/nhl_bet365_workflow.test.js`

Run: `$b=[IO.File]::ReadAllBytes('.github/workflows/nhl-bet365-odds.yml'); if($b[0]-eq239 -and $b[1]-eq187 -and $b[2]-eq191){ throw 'BOM' }`

Expected: tests PASS and no `BOM` error.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/nhl-bet365-odds.yml tests/nhl_bet365_workflow.test.js
git commit -m "ci: refresh NHL Bet365 odds every five minutes"
```

### Task 5: Browser verification and regression suite

**Files:**
- Modify on regression failure: `nhl.html`
- Modify on regression failure: `nhl_bet365_core.js`
- Modify on regression failure: `nhl_bet365_odds.js`

**Interfaces:**
- Validates all earlier deliverables together.

- [ ] **Step 1: Run focused and existing NHL tests**

Run: `node --test tests/nhl_bet365_core.test.js tests/nhl_bet365_odds.test.js tests/nhl_bet365_frontend.test.js tests/nhl_bet365_workflow.test.js tests/bet365_fallback.test.js`

Expected: all tests PASS.

- [ ] **Step 2: Validate generated JSON**

Run: `node -e "const x=require('./data/nhl_bet365_odds.json'); const g=Object.values(x.games); if(x.provider!=='bet365-official'||!g.length||g.some(v=>!v.ml||!v.hd)) process.exit(1); console.log(g.length)"`

Expected: positive game count, exit 0.

- [ ] **Step 3: Serve and inspect desktop card**

Run: `python -m http.server 8765`

Open `http://127.0.0.1:8765/nhl.html`; verify the visible game's negative Puck Line team is the card's `讓` team, both Money Line prices appear, and the total input is 6.5.

- [ ] **Step 4: Inspect mobile and manual swap**

At a mobile viewport, click `⇄`; verify the `讓` and `受讓` team names swap without layout movement and remain swapped after refresh.

- [ ] **Step 5: Review the diff**

Run: `git diff --check origin/main...HEAD`

Run: `git status --short`

Expected: no whitespace errors; only intended files are tracked, while existing root `test_*.js` and `test-results/` remain untracked.

### Task 6: Rebase, deploy, and verify production

**Files:**
- No new files.

**Interfaces:**
- Produces deployed GitHub Pages assets and active scheduled workflow.

- [ ] **Step 1: Rebase on live main**

Run: `git pull --rebase origin main`

Expected: successful rebase; resolve only intended file conflicts without staging crawler-generated unrelated data.

- [ ] **Step 2: Re-run focused tests after rebase**

Run: `node --test tests/nhl_bet365_core.test.js tests/nhl_bet365_odds.test.js tests/nhl_bet365_frontend.test.js tests/nhl_bet365_workflow.test.js`

Expected: all tests PASS.

- [ ] **Step 3: Inspect commit contents**

Run: `git status --short`

Run: `git show --stat --oneline HEAD`

Expected: no accidental root tests or unrelated data in commits.

- [ ] **Step 4: Push to main**

Run: `git push origin HEAD:main`

Expected: command exit 0 and output contains `HEAD -> main`.

- [ ] **Step 5: Verify production**

Confirm GitHub Pages serves the new `nhl_bet365_core.js`, `nhl_bet365_odds.json` reports `bet365-official`, and `nhl.html` loads without console errors. Do not cancel any running workflow.
