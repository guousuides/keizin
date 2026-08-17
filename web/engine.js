/**
 * ============================================================
 *  夏合宿 競馬企画 — 計算エンジン
 * ============================================================
 *  ★オッズと払戻の計算は、この1ファイルにしか書いていません。
 *
 *  サーバ（server.js）とブラウザ（app.js / admin.js）が
 *  両方このファイルを読み込みます。
 *  なので「画面に出てる想定オッズ」と「実際に精算される払戻」が
 *  食い違うことは原理的に起きません。
 *  式を変えたいときは、ここだけ直せば全部に反映されます。
 *
 *  用語（もらった手書きの式に合わせています）
 *    A_i … 馬 i に賭けられた総額（複勝は a 倍した額で算入）
 *    ΣA  … A_i の全頭ぶんの合計 ＝ 賭け金の総額
 *    T   … 払戻に回す総額 ＝ ΣA × (1 − 控除率)
 *    O_i … 素オッズ ＝ T ÷ A_i
 *    p_i … 想定1着率 ＝ A_i ÷ ΣA （6頭ぶん足すとちょうど 1）
 * ============================================================
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /** 券種。画面の並び順もこの順番。 */
  var TICKETS = ['単勝', '複勝', '三連単', '三連複'];

  /** 券種ごとに何人 指名させるか。 */
  var PICKS = { '単勝': 1, '複勝': 1, '三連単': 3, '三連複': 3 };

  /** 三連単・三連複のオッズの出し方。 */
  var MODE = {
    SIMPLE:   '単純積',        // もらった式そのまま： O_i × O_j × O_k
    HARVILLE: 'Harville補正',  // 着順の条件付き確率をきちんと織り込んだ版
  };

  /* ============================================================
   *  設定の既定値と、その意味
   * ============================================================ */

  function defaultSettings() {
    return {
      raceName:      '第1レース',
      placeCoef:     1 / 3,        // 複勝係数 a
      takeout:       0,            // 控除率
      oddsFloor:     1.1,          // オッズ下限
      oddsCap:       999,          // オッズ上限
      trifectaCoef:  1,            // 三連単係数
      trioCoef:      1,            // 三連複係数
      initialPoints: 1000,         // 初期持ち点
      roundUnit:     1,            // 払戻の丸め単位（切り上げ）
      trifectaMode:  MODE.SIMPLE,  // 三連系方式
      open:          false,        // 受付中かどうか
    };
  }

  /**
   * 設定の説明文。admin画面の各入力欄の横にそのまま出します。
   * 「なんか分からんけど動く」を避けるための本体。
   */
  var SETTING_INFO = [
    { key: 'raceName', label: 'レース名', type: 'text',
      note: '参加者の画面の見出しに出ます。' },
    { key: 'placeCoef', label: '複勝係数 a', type: 'number', step: 'any',
      note: '複勝の賭け金を A_i に算入するときの掛け率。払戻にも同じ a を掛けます。' +
            '3着以内に入る確率はだいたい単勝確率の3倍なので、a = 1/3 ≒ 0.3333 で複勝の期待払戻がちょうど100%になります。' },
    { key: 'takeout', label: '控除率', type: 'number', step: 'any',
      note: '胴元（書道会）の取り分。0.1 なら賭け金の10%を差し引いてからオッズを出します。0なら全額還元。' +
            'オッズが甘いと感じたらここを上げてください。' },
    { key: 'oddsFloor', label: 'オッズ下限', type: 'number', step: 'any',
      note: 'どんなに人気でも最低これだけの倍率は付けます。JRAでいう元返し防止。' },
    { key: 'oddsCap', label: 'オッズ上限', type: 'number', step: 'any',
      note: '誰も賭けていない馬でオッズが無限に飛ぶのを防ぐ天井。' },
    { key: 'trifectaCoef', label: '三連単係数', type: 'number', step: 'any',
      note: '三連単の払戻に最後に掛ける調整倍率。「単純積」方式だと 1 のままで期待払戻が約180%（胴元の持ち出し）になります。' +
            '下の【三連系の注意】を読んでから決めてください。' },
    { key: 'trioCoef', label: '三連複係数', type: 'number', step: 'any',
      note: '同上（三連複）。' },
    { key: 'initialPoints', label: '初期持ち点', type: 'number', step: '1',
      note: '各チームに配る持ち点。これを超える購入は弾かれます。' },
    { key: 'roundUnit', label: '丸め単位', type: 'number', step: 'any',
      note: '払戻ptの丸め単位。5にすると5pt刻みで切り上げます（春合宿版は5でした）。' },
    { key: 'trifectaMode', label: '三連系方式', type: 'select', options: [MODE.SIMPLE, MODE.HARVILLE],
      note: '「単純積」＝もらった式どおり O_i×O_j×O_k。派手な配当が出ますが期待払戻が約180%になります。' +
            '「Harville補正」＝1着に決まった馬は2着になれない分をきちんと織り込んだ版で、期待払戻がちょうど100%になります。' },
  ];

  /* ============================================================
   *  オッズの算出
   * ============================================================ */

  /**
   * 各馬の A_i を、券種ごとの内訳つきで積み上げる。
   * もらった手書きの「＜オッズの算出＞」をそのまま実装したもの。
   *
   *   単勝   X に m pt → A_X += m
   *   複勝   X に m pt → A_X += a × m
   *   三連単 X→Y→Z に m pt → A_X += m/2, A_Y += m/3, A_Z += m/6
   *   三連複 X,Y,Z に m pt → 3頭それぞれ += m/3
   *
   * 重みの合計が 単勝1 ／ 三連単 1/2+1/3+1/6 = 1 ／ 三連複 1/3×3 = 1 に
   * 揃っているので、配分しても金額は増減しません。
   * だから ΣA_i がそのまま賭け金の総額になり、Σ(1/O_i) = 1 が成り立ちます。
   */
  function computePools(horses, bets, s) {
    var index = {};
    horses.forEach(function (h, i) { index[h.name] = i; });

    var rows = horses.map(function () {
      return { win: 0, place: 0, tri: 0, trio: 0 };
    });

    function add(name, kind, amount) {
      var i = index[name];
      if (i === undefined) return;   // 出走取消などで名前が消えた馬ぶんは捨てる
      rows[i][kind] += amount;
    }

    bets.forEach(function (b) {
      var pt = Number(b.pt) || 0;
      if (pt <= 0) return;
      var p = b.picks || [];
      if (b.ticket === '単勝')  add(p[0], 'win', pt);
      else if (b.ticket === '複勝')  add(p[0], 'place', pt * s.placeCoef);
      else if (b.ticket === '三連単') {
        add(p[0], 'tri', pt / 2);
        add(p[1], 'tri', pt / 3);
        add(p[2], 'tri', pt / 6);
      } else if (b.ticket === '三連複') {
        add(p[0], 'trio', pt / 3);
        add(p[1], 'trio', pt / 3);
        add(p[2], 'trio', pt / 3);
      }
    });

    return rows;
  }

  /** MEDIAN(下限, 値, 上限) — 値を下限〜上限に押し込む。 */
  function clamp(v, s) {
    if (!isFinite(v)) return s.oddsCap;
    return Math.min(s.oddsCap, Math.max(s.oddsFloor, v));
  }

  /**
   * オッズ表を作る。参加者画面・admin画面・精算の全部がこの戻り値を使う。
   *
   * 返り値 .horses[i] = {
   *   name, comment,
   *   breakdown : 券種ごとの内訳（admin画面で見せる用）
   *   pool      : A_i
   *   p         : 想定1着率 A_i / ΣA
   *   raw       : 素オッズ O_i = T / A_i （三連系の土台。押し込み前）
   *   win       : 単勝オッズ（押し込み後）
   *   place     : 複勝オッズ ＝ a × O_i（押し込み後）
   * }
   * まだ1票も入っていないときは raw / win / place が null になります
   * （オッズが定義できないので「―」と出す）。
   */
  function computeOdds(horses, bets, s) {
    var br = computePools(horses, bets, s);
    var pools = br.map(function (r) { return r.win + r.place + r.tri + r.trio; });
    var sumA = pools.reduce(function (a, b) { return a + b; }, 0);
    var T = sumA * (1 - s.takeout);
    var empty = sumA <= 0;

    var out = horses.map(function (h, i) {
      var A = pools[i];
      // A_i = 0（誰も賭けていない）＝ オッズは上限。ΣA = 0（誰も何も賭けていない）＝ 未定。
      var raw = empty ? null : (A > 0 ? Math.min(s.oddsCap, T / A) : s.oddsCap);
      return {
        no: h.no,
        name: h.name,
        comment: h.comment || '',
        breakdown: {
          win:  round1(br[i].win),
          place: round1(br[i].place),
          tri:  round1(br[i].tri),
          trio: round1(br[i].trio),
        },
        pool: round1(A),
        p:    empty ? null : A / sumA,
        raw:  raw,
        win:  raw === null ? null : clamp(raw, s),
        place: raw === null ? null : clamp(raw * s.placeCoef, s),
      };
    });

    return { horses: out, sumA: round1(sumA), T: round1(T), empty: empty };
  }

  function round1(v) { return Math.round(v * 10) / 10; }

  /* ============================================================
   *  1枚の馬券に適用されるオッズ
   * ============================================================ */

  /**
   * 券種と指名から、その馬券の倍率を出す。
   *   単勝   = O_i
   *   複勝   = a × O_i
   *   三連単 = O_i × O_j × O_k          （単純積）
   *   三連複 = O_i × O_j × O_k ÷ 6      （単純積）
   * Harville補正のときは「実際に当たる確率」の逆数を使います（後述）。
   *
   * 買えない組み合わせ（未選択・重複指名・存在しない馬）は null を返します。
   * まだ1票も入っていないときも null（オッズ未定）。
   */
  function oddsForBet(ticket, picks, table, s) {
    if (!ticket || PICKS[ticket] === undefined) return null;
    var need = PICKS[ticket];
    var ps = (picks || []).slice(0, need).map(function (x) { return String(x || '').trim(); });
    if (ps.length !== need || ps.some(function (x) { return !x; })) return null;
    if (new Set(ps).size !== ps.length) return null;      // 同じ人を2回は不可

    var byName = {};
    table.horses.forEach(function (h) { byName[h.name] = h; });
    var h = ps.map(function (n) { return byName[n]; });
    if (h.some(function (x) { return !x; })) return null;
    if (h.some(function (x) { return x.raw === null; })) return null;   // オッズ未定

    if (ticket === '単勝') return h[0].win;
    if (ticket === '複勝') return h[0].place;

    var harville = (s.trifectaMode === MODE.HARVILLE);
    var prod = h[0].raw * h[1].raw * h[2].raw;

    if (ticket === '三連単') {
      var v = harville ? fairOdds(exactOrderProb(h[0].p, h[1].p, h[2].p), s) : prod;
      return clamp(s.trifectaCoef * v, s);
    }

    // 三連複：3頭が順不同で1〜3着を占める確率の逆数（単純積なら ÷6）
    var w = harville ? fairOdds(trioProb(h[0].p, h[1].p, h[2].p), s) : prod / 6;
    return clamp(s.trioCoef * w, s);
  }

  /**
   * Harville補正の考え方。
   *   1着が i になる確率            … p_i
   *   その次に j が来る確率          … p_j / (1 − p_i)      ← i はもう居ないので母数が減る
   *   その次に k が来る確率          … p_k / (1 − p_i − p_j)
   * 「単純積」の O_i×O_j×O_k は 1/(p_i p_j p_k)、つまり
   * 毎回6頭から引き直す計算になっていて、この母数の減りを無視しています。
   * そのぶん倍率が過大（期待払戻が約180%）になるので、正しく条件付けした版がこれ。
   */
  function exactOrderProb(pi, pj, pk) {
    var d1 = 1 - pi;
    var d2 = 1 - pi - pj;
    if (d1 <= 1e-9 || d2 <= 1e-9) return 0;   // その並びが起こり得ない場合
    return pi * (pj / d1) * (pk / d2);
  }

  /** 三連複＝3頭の並べ替え6通りの確率をぜんぶ足す。 */
  function trioProb(a, b, c) {
    return exactOrderProb(a, b, c) + exactOrderProb(a, c, b)
         + exactOrderProb(b, a, c) + exactOrderProb(b, c, a)
         + exactOrderProb(c, a, b) + exactOrderProb(c, b, a);
  }

  /** 的中確率から公正オッズへ。控除率のぶんだけ削ってから逆数を取る。 */
  function fairOdds(prob, s) {
    if (!(prob > 1e-12)) return s.oddsCap;
    return (1 - s.takeout) / prob;
  }

  /* ============================================================
   *  的中判定と払戻
   * ============================================================ */

  /** 結果（1〜3着）が3つ埋まっているか。埋まるまで判定は保留する。 */
  function resultReady(result) {
    return Array.isArray(result) && result.length === 3 &&
           result.every(function (x) { return String(x || '').trim() !== ''; });
  }

  /**
   * 的中したか。
   *   単勝   … 1着が一致
   *   複勝   … 3着以内に居る
   *   三連単 … 3頭が順番どおり
   *   三連複 … 3頭が順不同で全員3着以内
   * 結果が未入力なら null（＝まだ判定しない）。
   */
  function judge(bet, result) {
    if (!resultReady(result)) return null;
    var r = result.map(function (x) { return String(x).trim(); });
    var p = (bet.picks || []).map(function (x) { return String(x || '').trim(); });

    if (bet.ticket === '単勝')  return p[0] === r[0];
    if (bet.ticket === '複勝')  return r.indexOf(p[0]) >= 0;
    if (bet.ticket === '三連単') return p[0] === r[0] && p[1] === r[1] && p[2] === r[2];
    if (bet.ticket === '三連複') return p.every(function (x) { return r.indexOf(x) >= 0; });
    return false;
  }

  /** 払戻pt ＝ 賭けpt × オッズ を丸め単位で切り上げ。 */
  function payout(pt, odds, s) {
    var u = Number(s.roundUnit) > 0 ? Number(s.roundUnit) : 1;
    return Math.ceil((pt * odds) / u) * u;
  }

  /**
   * 全購入を精算する。admin の精算表と、参加者の結果表示の両方がこれを使う。
   * 返り値の各行 = 購入 + { odds, hit, payout }
   *   hit: true=的中 / false=不的中 / null=結果未入力
   */
  function settle(horses, bets, result, s) {
    var table = computeOdds(horses, bets, s);
    return bets.map(function (b) {
      var o = oddsForBet(b.ticket, b.picks, table, s);
      var hit = judge(b, result);
      return Object.assign({}, b, {
        odds: o,
        hit: hit,
        payout: hit === true && o !== null ? payout(b.pt, o, s) : (hit === null ? null : 0),
      });
    });
  }

  /**
   * チームごとの収支。
   *   使用pt … 賭けた合計
   *   払戻pt … 的中ぶんの合計
   *   収支   … 払戻 − 使用
   *   残高   … 初期持ち点 + 収支
   *   順位   … 残高の多い順（同点は同順位。結果未入力のあいだは null）
   */
  function standings(teams, settled, result, s) {
    var by = {};
    teams.forEach(function (t) {
      by[t] = { team: t, used: 0, ret: 0, count: 0 };
    });
    settled.forEach(function (b) {
      var t = by[b.team];
      if (!t) return;
      t.used += Number(b.pt) || 0;
      t.count += 1;
      if (b.payout) t.ret += b.payout;
    });

    var rows = teams.map(function (t) {
      var r = by[t];
      var profit = r.ret - r.used;
      return {
        team: t, used: r.used, ret: r.ret, count: r.count,
        profit: profit,
        balance: s.initialPoints + profit,
        free: s.initialPoints - r.used,     // まだ賭けられる残り
        rank: null,
      };
    });

    if (resultReady(result)) {
      var sorted = rows.slice().sort(function (a, b) { return b.balance - a.balance; });
      sorted.forEach(function (row, i) {
        // 同点は同順位（1,2,2,4 …）
        row.rank = (i > 0 && sorted[i - 1].balance === row.balance) ? sorted[i - 1].rank : i + 1;
      });
    }
    return rows;
  }

  return {
    TICKETS: TICKETS,
    PICKS: PICKS,
    MODE: MODE,
    SETTING_INFO: SETTING_INFO,
    defaultSettings: defaultSettings,
    computeOdds: computeOdds,
    oddsForBet: oddsForBet,
    resultReady: resultReady,
    judge: judge,
    payout: payout,
    settle: settle,
    standings: standings,
  };
});
