'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const anomaly = require('../anomaly-nrfi-addon.js');

function feature(name) {
  assert.equal(typeof anomaly[name], 'function', `${name} 尚未實作`);
  return anomaly[name];
}

function bucket({ n = 100, fw = 65, fwN = 100, cov = 35, covN = 100, ov = 35, ovN = 100, nr = 65, nrN = 100 } = {}) {
  return { n, fw, fwN, cov, covN, ov, ovN, nr, nrN, games: [] };
}

function game(overrides = {}) {
  return {
    away: '阪神', home: '橫濱', favorite: 'away', line: 1.5, totalLine: 7.5,
    moneyline: { away: 1.65, home: 2.25 },
    handicapOdds: { away: 2.30, home: 1.86 },
    total: { line: 7.5, over: 1.72, under: 1.90 },
    ...overrides,
  };
}

test('兩套異常統計同方向時，四個市場會轉成實際下注選項', () => {
  const build = feature('buildAnomalyRecommendation');
  const decision = build({
    game: game(),
    sources: [
      { id: 'stake-tw', label: '異常統計', bucket: bucket() },
      { id: 'b365-tw', label: 'BET365 × 台彩七類', bucket: bucket({ fw: 62, cov: 38, ov: 38, nr: 62 }) },
    ],
  });

  const markets = Object.fromEntries(decision.markets.map((market) => [market.market, market]));
  assert.equal(markets.ml.pickLabel, '阪神 獨贏');
  assert.equal(markets.ml.sourceMode, 'consensus');
  assert.equal(markets.hd.pickLabel, '橫濱 +1.5');
  assert.equal(markets.hd.currentOdds, 1.86);
  assert.equal(markets.ou.pickLabel, '小 7.5');
  assert.equal(markets.ou.currentOdds, 1.90);
  assert.equal(markets.nrfi.pickLabel, 'NRFI');
  assert.equal(markets.nrfi.currentOdds, null);
  assert.equal(markets.nrfi.status, 'direction');
});

test('正式建議以歷史命中率加 3% 安全邊際計算最低賠率，避免 Wilson 下界把門檻墊得過高', () => {
  const build = feature('buildAnomalyRecommendation');
  const decision = build({
    game: game({ moneyline: { away: 1.80, home: 2.05 } }),
    sources: [{ id: 'stake-tw', label: '異常統計', bucket: bucket() }],
  });
  const ml = decision.markets.find((market) => market.market === 'ml');

  assert.equal(ml.estimatedRate, 0.65);
  assert.equal(ml.minOdds, 1.59);
  assert.equal(ml.status, 'bet');
  assert.ok(ml.edgePct > 0);
});

test('39 勝 60 場的 65% 訊號門檻是 1.59，不再被重複保守化推到 1.76', () => {
  const build = feature('buildAnomalyRecommendation');
  const decision = build({
    game: game({ moneyline: { away: 1.70, home: 2.20 } }),
    sources: [{
      id: 'stake-tw', label: '異常統計', category: '顛倒＋對調', leagueLabel: '日職',
      bucket: bucket({ fw: 39, fwN: 60 }),
    }],
  });
  const ml = decision.markets.find((market) => market.market === 'ml');

  assert.equal(ml.estimatedRate, 0.65);
  assert.equal(ml.minOdds, 1.59);
});

test('15 到 29 場即使目前賠率很高，也只能顯示觀察而不能標成可下', () => {
  const build = feature('buildAnomalyRecommendation');
  const decision = build({
    game: game({ moneyline: { away: 3.00, home: 1.40 } }),
    sources: [{
      id: 'stake-tw', label: '異常統計',
      bucket: bucket({ fw: 13, fwN: 20, cov: 13, covN: 20, ov: 13, ovN: 20, nr: 13, nrN: 20 }),
    }],
  });

  assert.equal(decision.markets.find((market) => market.market === 'ml').status, 'observe');

  const render = feature('renderAnomalyRecommendation');
  const dom = new JSDOM('<!doctype html><body></body>');
  const element = render(decision, dom.window.document);
  assert.match(element.querySelector('[data-market="ml"] .anom-price').textContent, /^參考 /);
});

test('兩套達正式門檻但方向相反時，必須顯示分歧而不是硬選一邊', () => {
  const build = feature('buildAnomalyRecommendation');
  const decision = build({
    game: game(),
    sources: [
      { id: 'stake-tw', label: '異常統計', bucket: bucket({ fw: 65, fwN: 100 }) },
      { id: 'b365-tw', label: 'BET365 × 台彩七類', bucket: bucket({ fw: 35, fwN: 100 }) },
    ],
  });

  const ml = decision.markets.find((market) => market.market === 'ml');
  assert.equal(ml.status, 'conflict');
  assert.equal(ml.pickLabel, '兩套方向分歧');
  assert.equal(ml.minOdds, null);
});

test('不足 15 場的另一套資料不會推翻已滿 30 場的正式方向', () => {
  const build = feature('buildAnomalyRecommendation');
  const decision = build({
    game: game({ moneyline: { away: 1.90, home: 1.90 } }),
    sources: [
      { id: 'stake-tw', label: '異常統計', bucket: bucket({ fw: 39, fwN: 60 }) },
      { id: 'b365-tw', label: 'BET365 × 台彩七類', bucket: bucket({ fw: 3, fwN: 10 }) },
    ],
  });

  const ml = decision.markets.find((market) => market.market === 'ml');
  assert.equal(ml.status === 'bet' || ml.status === 'wait', true);
  assert.equal(ml.sourceMode, 'single');
  assert.deepEqual(ml.evidence.map((item) => item.label), ['異常統計']);
});

test('Stake 即時賠率暫缺時，獨贏方向仍沿用已知獨贏熱門而不誤拿讓分方', () => {
  const build = feature('buildAnomalyRecommendation');
  const decision = build({
    game: game({ favorite: 'away', moneylineFavorite: 'home', moneyline: null }),
    sources: [{ id: 'stake-tw', label: '異常統計', bucket: bucket() }],
  });
  const ml = decision.markets.find((market) => market.market === 'ml');

  assert.equal(ml.pickLabel, '橫濱 獨贏');
  assert.equal(ml.currentOdds, null);
  assert.equal(ml.status, 'direction');
});

test('獨贏熱門與讓分方背離時，兩個市場各自跟隨正確方向', () => {
  const build = feature('buildAnomalyRecommendation');
  const decision = build({
    game: game({
      favorite: 'away', moneylineFavorite: 'home',
      moneyline: { away: 2.10, home: 1.72 },
      handicapOdds: { away: 2.20, home: 1.65 },
    }),
    sources: [{ id: 'stake-tw', label: '異常統計', bucket: bucket({ cov: 65, covN: 100 }) }],
  });
  const markets = Object.fromEntries(decision.markets.map((market) => [market.market, market]));

  assert.equal(markets.ml.pickLabel, '橫濱 獨贏');
  assert.equal(markets.hd.pickLabel, '阪神 -1.5');
  assert.equal(markets.hd.currentOdds, 2.20);
});

test('卡片只露出兩個最重要選項，展開後可核對四個市場與兩套證據', () => {
  const build = feature('buildAnomalyRecommendation');
  const render = feature('renderAnomalyRecommendation');
  const decision = build({
    game: game(),
    sources: [
      { id: 'stake-tw', label: '異常統計', bucket: bucket() },
      { id: 'b365-tw', label: 'BET365 × 台彩七類', bucket: bucket({ fw: 62, cov: 38, ov: 38, nr: 62 }) },
    ],
  });
  const dom = new JSDOM('<!doctype html><body></body>');
  const element = render(decision, dom.window.document);

  assert.equal(element.querySelectorAll('.anom-pick').length, 2);
  assert.equal(element.querySelectorAll('.anom-detail-row').length, 4);
  assert.match(element.textContent, /異常投注參考/);
  assert.match(element.textContent, /兩套一致/);
  assert.match(element.textContent, /計算\d+%/);
  assert.match(element.textContent, /NRFI/);
  assert.equal(element.querySelector('[data-market="nrfi"] .anom-price').textContent, '');
  assert.doesNotMatch(
    element.querySelector('[data-market="nrfi"]').textContent,
    /Stake\s*\d|可下價|等待價/,
  );
  assert.equal(element.querySelector('[data-market="ml"] .anom-verdict').textContent, '未到價');

  const toggle = element.querySelector('.anom-decision-toggle');
  const detail = element.querySelector('.anom-decision-detail');
  assert.equal(detail.hidden, true);
  toggle.click();
  assert.equal(detail.hidden, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
});

test('決策面板直接標示聯盟、分類與正確樣本數，七類日職五場不混入其他聯盟', () => {
  const build = feature('buildAnomalyRecommendation');
  const render = feature('renderAnomalyRecommendation');
  const decision = build({
    game: game(),
    sources: [{
      id: 'b365-tw', label: 'BET365 × 台彩七類', leagueLabel: '日職',
      category: '顛倒－雙方都對調', bucket: bucket({ n: 5, fw: 3, fwN: 5, cov: 3, covN: 5, ov: 2, ovN: 5, nr: 4, nrN: 5 }),
    }],
  });
  const dom = new JSDOM('<!doctype html><body></body>');
  const element = render(decision, dom.window.document);

  assert.match(element.querySelector('.anom-context').textContent, /BET365 × 台彩七類/);
  assert.match(element.querySelector('.anom-context').textContent, /日職/);
  assert.match(element.querySelector('.anom-context').textContent, /顛倒－雙方都對調/);
  assert.match(element.querySelector('.anom-context').textContent, /5 場/);
});
