/**
 * 夏合宿 競馬企画 — スクリーン・プロジェクター用オッズモニター
 *
 * /api/state を2.5秒ごとにポーリングし、大画面向けに最適化されたオッズを表示します。
 * 計算にはサーバと共通の engine.js を使用します。
 */
'use strict';

(function () {
  var S = null;              // 最新状態
  var prevOddsMap = {};      // 前回のオッズ値（変動検出用）
  var timer = null;
  var isFetching = false;

  var $ = function (id) { return document.getElementById(id); };

  // 枠番クラス（1〜8番、それ以降はループ）
  var WAKU_CLASSES = ['waku-1', 'waku-2', 'waku-3', 'waku-4', 'waku-5', 'waku-6', 'waku-7', 'waku-8'];

  /* ============================================================
   *  初期起動
   * ============================================================ */
  document.addEventListener('DOMContentLoaded', boot);

  function boot() {
    // フルスクリーンボタン
    var fsBtn = $('btnFullscreen');
    if (fsBtn) {
      fsBtn.onclick = toggleFullscreen;
    }

    refresh();
    timer = setInterval(function () {
      if (!isFetching) refresh();
    }, 2500);
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(function (e) {
        console.warn('全画面表示に失敗しました:', e);
      });
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
  }

  /* ============================================================
   *  データ取得（ポーリング）
   * ============================================================ */
  function refresh() {
    isFetching = true;
    fetch('/api/state')
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (state) {
        isFetching = false;
        S = state;
        $('connStatus').textContent = '正常接続';
        $('connStatus').style.color = 'var(--dim)';
        render();
      })
      .catch(function (err) {
        isFetching = false;
        $('connStatus').textContent = '⚠ 接続エラー（再試行中…）';
        $('connStatus').style.color = 'var(--bad)';
      });
  }

  /* ============================================================
   *  画面全体の描画
   * ============================================================ */
  function render() {
    if (!S) return;

    renderHeader();
    renderResultBanner();
    renderOddsBoard();
    renderRankings();
    renderFooter();
  }

  /* ---------- ヘッダーの描画 ---------- */
  function renderHeader() {
    var title = S.raceName || ('第' + (S.raceNo || 1) + 'レース');
    if (S.raceNo && title.indexOf('第' + S.raceNo) < 0 && !title.startsWith('第')) {
      title = '第' + S.raceNo + 'レース　' + title;
    }
    $('raceTitle').textContent = title;

    // ステータスバッジ
    var badge = $('statusBadge');
    if (S.resultReady) {
      badge.textContent = '🏁 レース確定';
      badge.className = 'status-badge ready';
      $('oddsStateText').textContent = '確定オッズ';
    } else if (S.open) {
      badge.innerHTML = '<span style="display:inline-block;width:8px;height:8px;background:#fff;border-radius:50%;margin-right:2px"></span> 投票受付中';
      badge.className = 'status-badge open';
      $('oddsStateText').textContent = 'リアルタイム更新中（受付中）';
    } else {
      badge.textContent = '⏹ 受付締切（オッズ確定）';
      badge.className = 'status-badge closed';
      $('oddsStateText').textContent = '確定オッズ（締切済）';
    }

    // KPIチップ
    var sumA = S.totals ? (S.totals.sumA || 0) : 0;
    var betCount = S.betCount !== undefined ? S.betCount : 0;
    $('totalPool').innerHTML = fmt(sumA) + ' <small style="font-size:12px;font-weight:normal;color:var(--dim)">pt</small>';
    $('betCount').innerHTML = fmt(betCount) + ' <small style="font-size:12px;font-weight:normal;color:var(--dim)">点</small>';
  }

  /* ---------- 確定結果バナー ---------- */
  function renderResultBanner() {
    var banner = $('resultBanner');
    if (!S.resultReady || !S.result || S.result.filter(Boolean).length < 3) {
      banner.classList.add('hide');
      return;
    }

    banner.classList.remove('hide');
    var p1 = S.result[0];
    var p2 = S.result[1];
    var p3 = S.result[2];

    var table = { horses: S.horses || [] };
    var oddsWin = Engine.oddsForBet('単勝', [p1], table, S.settings);
    var oddsPl1 = Engine.oddsForBet('複勝', [p1], table, S.settings);
    var oddsPl2 = Engine.oddsForBet('複勝', [p2], table, S.settings);
    var oddsPl3 = Engine.oddsForBet('複勝', [p3], table, S.settings);
    var oddsTri = Engine.oddsForBet('三連単', [p1, p2, p3], table, S.settings);
    var oddsTrio = Engine.oddsForBet('三連複', [p1, p2, p3], table, S.settings);

    $('resultDetails').innerHTML =
      '<span>三連単 <b>' + esc(p1) + ' → ' + esc(p2) + ' → ' + esc(p3) + '</b> (' + o(oddsTri) + '倍)</span>' +
      '<span style="color:var(--line)">|</span>' +
      '<span>三連複 <b>' + esc(p1) + ' - ' + esc(p2) + ' - ' + esc(p3) + '</b> (' + o(oddsTrio) + '倍)</span>';

    $('resultPlaces').innerHTML =
      '<div class="result-place-card p1">' +
        '<div class="place-badge">🥇</div>' +
        '<div class="place-info">' +
          '<div class="place-name">' + esc(p1) + '</div>' +
          '<div class="place-payout">単勝 ' + o(oddsWin) + '倍 / 複勝 ' + o(oddsPl1) + '倍</div>' +
        '</div>' +
      '</div>' +
      '<div class="result-place-card p2">' +
        '<div class="place-badge">🥈</div>' +
        '<div class="place-info">' +
          '<div class="place-name">' + esc(p2) + '</div>' +
          '<div class="place-payout">複勝 ' + o(oddsPl2) + '倍</div>' +
        '</div>' +
      '</div>' +
      '<div class="result-place-card p3">' +
        '<div class="place-badge">🥉</div>' +
        '<div class="place-info">' +
          '<div class="place-name">' + esc(p3) + '</div>' +
          '<div class="place-payout">複勝 ' + o(oddsPl3) + '倍</div>' +
        '</div>' +
      '</div>';
  }

  /* ---------- 単勝・複勝オッズボード ---------- */
  function renderOddsBoard() {
    var tbody = $('oddsBody');
    var horses = S.horses || [];

    if (!horses.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:30px;color:var(--dim)">出走馬が登録されていません</td></tr>';
      return;
    }

    // 単勝オッズが有効な馬の中で最小のオッズ（1番人気）を特定
    var minWinOdds = Infinity;
    var favHorseName = null;
    if (!S.totals.empty) {
      horses.forEach(function (h) {
        if (h.win !== null && h.win < minWinOdds) {
          minWinOdds = h.win;
          favHorseName = h.name;
        }
      });
    }

    var html = horses.map(function (h, idx) {
      var wakuIdx = (h.no ? (h.no - 1) : idx) % WAKU_CLASSES.length;
      var wakuCls = WAKU_CLASSES[wakuIdx];

      // 着順確定時のマーク・ハイライト
      var rowCls = 'odds-row';
      var mark = '';
      if (S.resultReady && S.result) {
        var rIdx = S.result.indexOf(h.name);
        if (rIdx === 0) { rowCls += ' winner-1'; mark = ' 🥇'; }
        else if (rIdx === 1) { rowCls += ' winner-2'; mark = ' 🥈'; }
        else if (rIdx === 2) { rowCls += ' winner-3'; mark = ' 🥉'; }
      }

      var isFav = (h.name === favHorseName && !S.totals.empty);
      if (isFav && !S.resultReady) {
        rowCls += ' rank-1';
      }

      var winStr = (h.win === null) ? '<span class="odds-empty">—</span>' : '<span class="val-odds-win">' + h.win.toFixed(2) + '</span><small style="font-size:12px;color:var(--dim)">倍</small>';
      var placeStr = (h.place === null) ? '<span class="odds-empty">—</span>' : '<span class="val-odds-place">' + h.place.toFixed(2) + '</span><small style="font-size:11px;color:var(--dim)">倍</small>';

      var pPercent = (h.p === null) ? '—' : ((h.p * 100).toFixed(1) + '%');
      var pWidth = (h.p === null) ? 0 : Math.min(100, Math.max(0, h.p * 100));

      return '<tr class="' + rowCls + '">' +
        '<td><span class="horse-num ' + wakuCls + '">' + (h.no || (idx + 1)) + '</span></td>' +
        '<td>' +
          '<div class="horse-cell">' +
            '<div class="horse-name-wrap">' +
              '<span class="horse-name">' + esc(h.name) + mark + '</span>' +
              (isFav ? '<span class="fav-badge">1番人気</span>' : '') +
            '</div>' +
            (h.comment ? '<div class="horse-comment">' + esc(h.comment) + '</div>' : '') +
          '</div>' +
        '</td>' +
        '<td>' + winStr + '</td>' +
        '<td>' + placeStr + '</td>' +
        '<td>' +
          '<div class="pop-cell">' +
            '<span class="pop-text">' + pPercent + '</span>' +
            '<div class="pop-bar-bg"><div class="pop-bar-fill" style="width:' + pWidth + '%"></div></div>' +
          '</div>' +
        '</td>' +
        '<td><span class="pool-val">' + fmt(h.pool) + ' pt</span></td>' +
      '</tr>';
    }).join('');

    tbody.innerHTML = html;
  }

  /* ---------- 三連系ランキング（三連単・三連複） ---------- */
  function renderRankings() {
    var horses = S.horses || [];
    var triListEl = $('trifectaList');
    var trioListEl = $('trioList');

    if (horses.length < 3 || S.totals.empty) {
      var emptyMsg = '<div class="empty-ranking">投票が入るとここに上位人気が表示されます</div>';
      triListEl.innerHTML = emptyMsg;
      trioListEl.innerHTML = emptyMsg;
      return;
    }

    var table = { horses: horses };
    var n = horses.length;

    // --- 三連単の全組み合わせとオッズ計算 ---
    var trifectaCombinations = [];
    for (var i = 0; i < n; i++) {
      for (var j = 0; j < n; j++) {
        if (j === i) continue;
        for (var k = 0; k < n; k++) {
          if (k === i || k === j) continue;
          var picks = [horses[i].name, horses[j].name, horses[k].name];
          var odds = Engine.oddsForBet('三連単', picks, table, S.settings);
          if (odds !== null) {
            trifectaCombinations.push({
              picks: picks,
              odds: odds,
            });
          }
        }
      }
    }

    // オッズ昇順（人気順）にソート
    trifectaCombinations.sort(function (a, b) { return a.odds - b.odds; });
    var topTrifecta = trifectaCombinations.slice(0, 6);

    if (!topTrifecta.length) {
      triListEl.innerHTML = '<div class="empty-ranking">オッズ算出中…</div>';
    } else {
      triListEl.innerHTML = topTrifecta.map(function (item, idx) {
        return '<div class="ranking-item">' +
          '<span class="rank-num">' + (idx + 1) + '</span>' +
          '<div class="rank-picks">' +
            '<span class="rank-pick-name">' + esc(item.picks[0]) + '</span>' +
            '<span class="arrow-icon">▶</span>' +
            '<span class="rank-pick-name">' + esc(item.picks[1]) + '</span>' +
            '<span class="arrow-icon">▶</span>' +
            '<span class="rank-pick-name">' + esc(item.picks[2]) + '</span>' +
          '</div>' +
          '<span class="rank-odds">' + item.odds.toFixed(1) + '<small style="font-size:10px;color:var(--dim)">倍</small></span>' +
        '</div>';
      }).join('');
    }

    // --- 三連複の全組み合わせとオッズ計算 ---
    var trioCombinations = [];
    for (var a = 0; a < n; a++) {
      for (var b = a + 1; b < n; b++) {
        for (var c = b + 1; c < n; c++) {
          var trioPicks = [horses[a].name, horses[b].name, horses[c].name];
          var trioOdds = Engine.oddsForBet('三連複', trioPicks, table, S.settings);
          if (trioOdds !== null) {
            trioCombinations.push({
              picks: trioPicks,
              odds: trioOdds,
            });
          }
        }
      }
    }

    // オッズ昇順（人気順）にソート
    trioCombinations.sort(function (x, y) { return x.odds - y.odds; });
    var topTrio = trioCombinations.slice(0, 5);

    if (!topTrio.length) {
      trioListEl.innerHTML = '<div class="empty-ranking">オッズ算出中…</div>';
    } else {
      trioListEl.innerHTML = topTrio.map(function (item, idx) {
        return '<div class="ranking-item">' +
          '<span class="rank-num">' + (idx + 1) + '</span>' +
          '<div class="rank-picks">' +
            '<span class="rank-pick-name">' + esc(item.picks[0]) + '</span>' +
            '<span class="arrow-icon">-</span>' +
            '<span class="rank-pick-name">' + esc(item.picks[1]) + '</span>' +
            '<span class="arrow-icon">-</span>' +
            '<span class="rank-pick-name">' + esc(item.picks[2]) + '</span>' +
          '</div>' +
          '<span class="rank-odds">' + item.odds.toFixed(1) + '<small style="font-size:10px;color:var(--dim)">倍</small></span>' +
        '</div>';
      }).join('');
    }
  }

  /* ---------- フッターの描画 ---------- */
  function renderFooter() {
    var now = new Date();
    var timeStr = ('0' + now.getHours()).slice(-2) + ':' +
                  ('0' + now.getMinutes()).slice(-2) + ':' +
                  ('0' + now.getSeconds()).slice(-2);
    $('updateTime').textContent = '最終更新: ' + timeStr;
  }

  /* ============================================================
   *  小道具
   * ============================================================ */
  function fmt(n) {
    return Number(n || 0).toLocaleString('ja-JP');
  }

  function o(v) {
    return (v === null || v === undefined) ? '—' : Number(v).toFixed(2);
  }

  function esc(s) {
    return String(s || '').replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

})();
