(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else api.install(root);
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const EMPTY_HISTORY = Object.freeze({ stakeBySid: {}, bet365Taiwan: [] });

  function lookupStakeNrfi(history, sid) {
    if (!sid || !history || !history.stakeBySid) return null;
    return history.stakeBySid[sid] || null;
  }

  function bucket() {
    return { n: 0, fw: 0, fwN: 0, cov: 0, covN: 0, ov: 0, ovN: 0, nr: 0, nrN: 0, games: [] };
  }

  function relationKey(value) {
    return value === '顛倒' ? 'inverted' : value === '收斂' ? 'converged' : null;
  }

  function addGame(target, game) {
    target.n += 1;
    target.games.push(game);
    if (typeof game.mlFavoriteWin === 'boolean') {
      target.fwN += 1;
      if (game.mlFavoriteWin) target.fw += 1;
    }
    if (game.handicapResult === 'cover') {
      target.covN += 1;
      target.cov += 1;
    } else if (game.handicapResult === 'nocover') target.covN += 1;
    if (game.totalResult === 'over') {
      target.ovN += 1;
      target.ov += 1;
    } else if (game.totalResult === 'under') target.ovN += 1;
    if (typeof game.nrfi === 'boolean') {
      target.nrN += 1;
      if (game.nrfi) target.nr += 1;
    }
  }

  function makeGroups() {
    return {
      inverted: { all: bucket(), neither: bucket(), taiwan_only: bucket(), bet365_only: bucket(), both: bucket() },
      converged: { all: bucket(), taiwan_only: bucket(), bet365_only: bucket(), both: bucket() },
    };
  }

  function collectBet365Taiwan(history, leagueFilter) {
    const groups = makeGroups();
    const rows = history && Array.isArray(history.bet365Taiwan) ? history.bet365Taiwan : [];
    let total = 0;
    rows.forEach((game) => {
      if (leagueFilter && leagueFilter !== 'all' && game.league !== leagueFilter) return;
      const rel = relationKey(game.relation);
      if (!rel || !Object.prototype.hasOwnProperty.call(groups[rel], game.swapCombo)) return;
      total += 1;
      addGame(groups[rel].all, game);
      addGame(groups[rel][game.swapCombo], game);
    });
    return { groups, total };
  }

  function pc(hit, total) {
    return total ? `${Math.round((100 * hit) / total)}%` : '—';
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function detailRole(game) {
    const hot = game.mlFavoriteWin === true ? '<b>熱門勝</b>' : game.mlFavoriteWin === false ? '冷門勝' : '熱門不明';
    const hd = game.handicapResult === 'cover' ? '<span class="dr-hit">過盤</span>'
      : game.handicapResult === 'nocover' ? '<span class="dr-miss">沒過</span>' : '—';
    const total = game.totalResult === 'over' ? '大' : game.totalResult === 'under' ? '小' : '—';
    let first = '首局—';
    if (game.eventStatus === 'canceled') {
      first = `官方取消（${esc(game.officialSourceLabel || '官網')}確認，NRFI 不計）`;
    } else if (game.awayFirst != null && game.homeFirst != null) {
      const official = game.officialSourceLabel ? `・${esc(game.officialSourceLabel)}補` : '';
      first = `${game.nrfi ? 'NRFI' : 'YRFI'}（首局 ${esc(game.awayFirst)}-${esc(game.homeFirst)}）${official}`;
    }
    return `${hot}・讓分${hd}・開${total}・${first}`;
  }

  function renderBet365TaiwanSection(leagueFilter, history, helpers) {
    const opts = helpers || {};
    const drillBlock = typeof opts.drillBlock === 'function' ? opts.drillBlock : () => ({ id: '', html: '' });
    const today = opts.today || '';
    const collected = collectBet365Taiwan(history, leagueFilter || 'all');
    const groups = collected.groups;

    function row(label, item) {
      if (!item.n) {
        return `<tr class="rv-row"><td class="lbl" style="color:var(--ink-dim)">${label}</td><td>0</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>`;
      }
      const detail = drillBlock(item.games, detailRole);
      const hasToday = item.games.some((game) => game.date === today);
      let html = `<tr class="rv-row drill-toggle"${detail.id ? ` onclick="toggleDrillById('${detail.id}',this)" style="cursor:pointer"` : ''}>`
        + `<td class="lbl">${label}${hasToday ? ' <span class="rv-alert-mk">❗</span>' : ''}</td><td>${item.n}</td>`
        + `<td>${pc(item.fw, item.fwN)} <span class="rv-samp">${item.fw}/${item.fwN}</span></td>`
        + `<td>${pc(item.cov, item.covN)} <span class="rv-samp">${item.cov}/${item.covN}</span></td>`
        + `<td>${pc(item.ov, item.ovN)} <span class="rv-samp">${item.ov}/${item.ovN}</span></td>`
        + `<td>${pc(item.nr, item.nrN)} <span class="rv-samp">${item.nr}/${item.nrN}</span></td></tr>`;
      if (detail.id) html += `<tr class="drill-tr"><td colspan="6" style="padding:0">${detail.html}</td></tr>`;
      return html;
    }

    function groupTable(title, group, definitions) {
      const all = group.all;
      let html = `<div class="rv-head" style="font-size:14px;margin-top:14px">${title}　<span class="rv-sub">${all.n} 場　熱門勝 ${pc(all.fw, all.fwN)}・讓分過盤 ${pc(all.cov, all.covN)}・開大 ${pc(all.ov, all.ovN)}・NRFI ${pc(all.nr, all.nrN)}</span></div>`;
      html += '<table class="rv-table"><thead><tr><th class="lbl">組合</th><th>場數</th><th>熱門勝</th><th>讓分過盤</th><th>開大</th><th>NRFI</th></tr></thead><tbody>';
      definitions.forEach(([key, label]) => { html += row(label, group[key]); });
      return `${html}</tbody></table>`;
    }

    let html = '<div class="rv-section" id="bet365TaiwanAnomalyStats">'
      + '<div class="rv-head">◆ Bet365 × 台彩七類 <span class="rv-sub">顛倒／收斂 × Stake 三市場＋NRFI</span></div>'
      + '<div style="font-size:12px;color:var(--ink-dim);line-height:1.7;margin:6px 0 10px">熱門、讓分線、大小分線與賽果皆以 Stake 結算紀錄為準；NRFI＝兩隊首局皆未得分。點任一列可核對逐場分類與首局比分。</div>';
    if (!collected.total) {
      html += '<div class="rv-empty">這個聯盟目前沒有 Bet365 × 台彩異常歷史場。</div>';
    } else {
      html += groupTable('顛倒', groups.inverted, [
        ['neither', '雙方未對調'], ['taiwan_only', '台彩對調'], ['bet365_only', 'Bet365 對調'], ['both', '雙方都對調'],
      ]);
      html += groupTable('收斂', groups.converged, [
        ['taiwan_only', '台彩對調'], ['bet365_only', 'Bet365 對調'], ['both', '雙方都對調'],
      ]);
    }
    return `${html}</div>`;
  }

  function install(browser) {
    const target = browser || {};
    target.anomalyNrfiHistory = target.anomalyNrfiHistory || EMPTY_HISTORY;
    target.lookupStakeNrfi = (sid) => lookupStakeNrfi(target.anomalyNrfiHistory, sid);
    target.collectBet365Taiwan = (league) => collectBet365Taiwan(target.anomalyNrfiHistory, league);
    target.renderBet365TaiwanSection = (league, helpers) => renderBet365TaiwanSection(league, target.anomalyNrfiHistory, helpers);

    if (typeof target.fetch !== 'function') {
      target.ANOMALY_NRFI_READY = Promise.resolve(target.anomalyNrfiHistory);
      return target;
    }
    target.ANOMALY_NRFI_READY = target.fetch('./data/anomaly_nrfi_history.json?v=20260823nrfi2', { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((history) => {
        target.anomalyNrfiHistory = history;
        const page = target.document && target.document.getElementById('reviewpage');
        if (page && page.classList && page.classList.contains('show') && typeof target.renderReviewPage === 'function') target.renderReviewPage();
        return history;
      })
      .catch((error) => {
        if (target.console && typeof target.console.warn === 'function') target.console.warn('NRFI 歷史資料載入失敗', error);
        return target.anomalyNrfiHistory;
      });
    return target;
  }

  return { lookupStakeNrfi, collectBet365Taiwan, renderBet365TaiwanSection, install, detailRole };
});
