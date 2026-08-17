/**
 * 運営ページ。
 *
 * 参加者ページと同じで、状態はぜんぶサーバ持ち。
 * ここは /api/admin/state を読んで表を描き、ボタンで /api/admin/* を叩くだけ。
 * 計算は一切していません（engine.js とサーバに任せる）。
 *
 * ★自動更新（3秒ごと）と手入力がぶつからないようにしている点に注意。
 *   出走馬・チーム・設定・着順のフォームは、1文字でも触ったら「未保存」印を付けて、
 *   保存するまで自動更新で上書きしないようにしています。
 *   （これをやらないと、名前を1人ぶん打って次の欄に移った瞬間に、
 *     サーバ側のまだ空っぽの値で書き戻されて消えてしまいます）
 */
'use strict';

var A = null;      // 運営用の状態
var tab = 'run';
var timer = null;

/** 手で触ったフォーム。true のあいだ自動更新はそのフォームに触らない。 */
var dirty = { horses: false, teams: false, settings: false, result: false };

var $ = function (id) { return document.getElementById(id); };

boot();

function boot() {
  // タブ切り替え
  Array.prototype.forEach.call($('tabs').children, function (b) {
    b.onclick = function () {
      tab = b.dataset.tab;
      Array.prototype.forEach.call($('tabs').children, function (x) {
        x.classList.toggle('on', x === b);
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-panel]'), function (s) {
        s.classList.toggle('hide', s.dataset.panel !== tab);
      });
    };
  });

  $('btnOpen').onclick    = function () { post('open', { open: true }); };
  $('btnClose').onclick   = function () {
    if (confirm('受付を締め切ります。この時点のオッズで確定してよいですか？')) post('open', { open: false });
  };
  $('btnResult').onclick  = saveResult;
  $('btnSettings').onclick = saveSettings;
  $('btnHorses').onclick  = saveHorses;
  $('btnTeams').onclick   = saveTeams;
  // 行を増やすときは、いま画面に打ってある内容を拾ってから増やす（打ちかけを消さない）
  $('btnAddHorse').onclick = function () {
    A.horsesRaw = readHorses();
    A.horsesRaw.push({ no: A.horsesRaw.length + 1, name: '', comment: '' });
    dirty.horses = true;
    renderHorses(true);
    marks();
  };
  $('btnAddTeam').onclick = function () {
    A.teamsRaw = readTeams();
    A.teamsRaw.push('');
    dirty.teams = true;
    renderTeams(true);
    marks();
  };

  // どのフォームを触ったかを覚える（保存するまで自動更新で上書きしない）
  [['horseRows', 'horses'], ['teamRows', 'teams'],
   ['setRows', 'settings'], ['resultInputs', 'result']].forEach(function (pair) {
    ['input', 'change'].forEach(function (ev) {
      $(pair[0]).addEventListener(ev, function () { dirty[pair[1]] = true; marks(); });
    });
  });
  $('btnReset').onclick = function () {
    if (!confirm('購入と着順を消して次のレースの準備をします。\n（消す前に data/archive/ に保存されます）')) return;
    post('reset', { raceName: $('nextName').value });
  };

  refresh();
  timer = setInterval(refresh, 3000);
}

function refresh() {
  fetch('/api/admin/state')
    .then(function (r) { return r.json(); })
    .then(function (a) { A = a; render(); })
    .catch(function () { $('head').textContent = '⚠ サーバに接続できません。'; });
}

/* ============================================================
 *  描画
 * ============================================================ */

function render() {
  $('head').innerHTML = esc(A.settings.raceName) + '　' +
    (A.settings.open ? '<span class="badge open">受付中</span>'
                     : '<span class="badge closed">締切</span>') +
    (A.resultReady ? ' <span class="badge pend">着順入力済</span>' : '');

  $('kOpen').textContent = A.settings.open ? '受付中' : '締切';
  $('kBets').textContent = A.betCount + ' 点';
  $('kSum').textContent = fmt(A.totals.sumA) + ' pt';
  $('kT').textContent = fmt(A.totals.T) + ' pt';

  renderResultInputs();
  renderHorses();
  renderTeams();
  renderSettings();
  renderOdds();
  renderBets();
  renderRank();
  marks();
}

/** 入力中の欄は上書きしない（3秒ごとの自動更新で消えないように） */
function keep(el) { return el && document.activeElement === el; }

/** 「未保存」印の出し入れ。 */
function marks() {
  [['horses', 'markHorses'], ['teams', 'markTeams'],
   ['settings', 'markSettings'], ['result', 'markResult']].forEach(function (p) {
    var el = $(p[1]);
    if (el) el.classList.toggle('hide', !dirty[p[0]]);
  });
}

function renderResultInputs(force) {
  var box = $('resultInputs');
  if (!force && dirty.result) return;      // 選びかけを消さない
  var labels = ['1着', '2着', '3着'];
  // 既に描いてあるなら中身だけ触る（フォーカス中は触らない）
  if (!force && box.children.length === 3) {
    for (var i = 0; i < 3; i++) {
      var sel = box.children[i].querySelector('select');
      if (!keep(sel)) sel.value = A.result[i] || '';
    }
    return;
  }
  box.innerHTML = labels.map(function (lb, i) {
    return '<div><div class="label">' + lb + '</div><select data-r="' + i + '">' +
      '<option value="">—</option>' +
      A.horseNames.map(function (n) {
        return '<option' + (A.result[i] === n ? ' selected' : '') + '>' + esc(n) + '</option>';
      }).join('') + '</select></div>';
  }).join('');
}

function renderHorses(force) {
  var box = $('horseRows');
  if (!force && dirty.horses) return;      // 打ちかけを消さない
  if (force || box.dataset.n !== String(A.horsesRaw.length)) {
    box.innerHTML = A.horsesRaw.map(function (h, i) {
      return '<div class="row"><div class="label">' + (i + 1) + '</div>' +
        '<input data-h="' + i + '" data-f="name" placeholder="代表者の名前" value="' + esc(h.name) + '">' +
        '<input data-h="' + i + '" data-f="comment" placeholder="ひとこと（任意）" value="' + esc(h.comment) + '">' +
        '</div>';
    }).join('');
    box.dataset.n = String(A.horsesRaw.length);
  } else {
    // 行数が同じなら値だけ更新（入力中の欄は飛ばす）
    Array.prototype.forEach.call(box.querySelectorAll('input'), function (inp) {
      if (keep(inp)) return;
      var h = A.horsesRaw[Number(inp.dataset.h)];
      if (h) inp.value = h[inp.dataset.f] || '';
    });
  }
}

function renderTeams(force) {
  var box = $('teamRows');
  if (!force && dirty.teams) return;
  if (force || box.dataset.n !== String(A.teamsRaw.length)) {
    box.innerHTML = A.teamsRaw.map(function (t, i) {
      return '<div class="row"><div class="label">' + (i + 1) + '</div>' +
        '<input data-t="' + i + '" placeholder="チーム名" value="' + esc(t) + '"></div>';
    }).join('');
    box.dataset.n = String(A.teamsRaw.length);
  } else {
    Array.prototype.forEach.call(box.querySelectorAll('input'), function (inp) {
      if (!keep(inp)) inp.value = A.teamsRaw[Number(inp.dataset.t)] || '';
    });
  }
}

/** 設定は「項目 / 入力 / 意味の説明」の3列。説明は engine.js の SETTING_INFO そのまま。 */
function renderSettings() {
  var box = $('setRows');
  if (dirty.settings) return;
  if (box.dataset.built) {
    Array.prototype.forEach.call(box.querySelectorAll('[data-k]'), function (inp) {
      if (!keep(inp)) inp.value = A.settings[inp.dataset.k];
    });
    return;
  }
  box.innerHTML = A.settingInfo.map(function (info) {
    var v = A.settings[info.key];
    var field;
    if (info.type === 'select') {
      field = '<select data-k="' + info.key + '">' + info.options.map(function (o) {
        return '<option' + (o === v ? ' selected' : '') + '>' + esc(o) + '</option>';
      }).join('') + '</select>';
    } else {
      field = '<input data-k="' + info.key + '" type="' +
        (info.type === 'number' ? 'number' : 'text') + '"' +
        (info.step ? ' step="' + info.step + '"' : '') +
        ' value="' + esc(v) + '">';
    }
    return '<div class="set"><div class="k">' + esc(info.label) + '</div><div>' + field +
      '</div><div class="n">' + esc(info.note) + '</div></div>';
  }).join('');
  box.dataset.built = '1';
}

function renderOdds() {
  $('oddsBody').innerHTML = A.odds.map(function (h) {
    var mark = '';
    if (A.resultReady) {
      var i = A.result.indexOf(h.name);
      if (i === 0) mark = ' 🥇'; else if (i === 1) mark = ' 🥈'; else if (i === 2) mark = ' 🥉';
    }
    var b = h.breakdown;
    return '<tr><td>' + esc(h.name) + mark + '</td>' +
      td(b.win) + td(b.place) + td(b.tri) + td(b.trio) +
      '<td><b>' + fmt(h.pool) + '</b></td>' +
      '<td>' + o(h.raw) + '</td>' +
      '<td style="color:var(--accent)"><b>' + o(h.win) + '</b></td>' +
      '<td style="color:var(--accent)"><b>' + o(h.place) + '</b></td>' +
      '<td style="color:var(--dim)">' + (h.p === null ? '—' : (h.p * 100).toFixed(1) + '%') + '</td></tr>';
  }).join('');

  $('oddsFoot').innerHTML =
    '<tr><td colspan="5" style="text-align:right;color:var(--dim)">ΣA_i（賭け金の総額）＝</td>' +
    '<td><b>' + fmt(A.totals.sumA) + '</b></td>' +
    '<td colspan="4" style="color:var(--dim);text-align:left">　払戻に回る額 T ＝ ΣA×(1−控除率) ＝ ' +
    fmt(A.totals.T) + '</td></tr>';
}

function td(v) { return '<td style="color:var(--dim)">' + fmt(v) + '</td>'; }

function renderBets() {
  if (!A.bets.length) {
    $('betsBody').innerHTML = '<tr><td colspan="10" style="color:var(--dim)">まだ購入がありません。</td></tr>';
    return;
  }
  $('betsBody').innerHTML = A.bets.map(function (b) {
    var cls = b.hit === true ? 'hit' : (b.hit === false ? 'miss' : '');
    return '<tr class="' + cls + '"><td>' + b.id + '</td><td>' + time(b.time) + '</td>' +
      '<td>' + esc(b.team) + '</td><td>' + esc(b.ticket) + '</td>' +
      '<td>' + esc(b.picks.join(' → ')) + '</td>' +
      '<td>' + fmt(b.pt) + '</td><td>' + o(b.odds) + '</td>' +
      '<td>' + (b.hit === null ? '—' : (b.hit ? '的中' : '不的中')) + '</td>' +
      '<td><b>' + (b.payout === null ? '—' : fmt(b.payout)) + '</b></td>' +
      '<td><button class="x sec" data-del="' + b.id + '" style="padding:3px 8px;font-size:11px">取消</button></td></tr>';
  }).join('');

  Array.prototype.forEach.call($('betsBody').querySelectorAll('[data-del]'), function (btn) {
    btn.onclick = function () {
      if (confirm('この購入を取り消します（オッズが再計算されます）。よいですか？')) {
        post('deleteBet', { id: btn.dataset.del });
      }
    };
  });
}

function renderRank() {
  var rows = A.standings.slice().sort(function (a, b) {
    if (A.resultReady) return b.balance - a.balance;
    return b.used - a.used;
  });
  $('rankBody').innerHTML = rows.map(function (r) {
    var cls = r.profit > 0 ? 'pos' : (r.profit < 0 ? 'neg' : '');
    return '<tr><td class="' + (r.rank === 1 ? 'rank1' : '') + '">' +
      (r.rank === null ? '—' : r.rank) + '</td>' +
      '<td>' + esc(r.team) + '</td><td>' + r.count + '</td><td>' + fmt(r.used) + '</td>' +
      '<td>' + fmt(r.ret) + '</td>' +
      '<td class="' + cls + '">' + (r.profit > 0 ? '＋' : '') + fmt(r.profit) + '</td>' +
      '<td><b>' + fmt(r.balance) + '</b></td>' +
      '<td style="color:var(--dim)">' + fmt(r.free) + '</td></tr>';
  }).join('');
}

/* ============================================================
 *  保存
 * ============================================================ */

function saveResult() {
  var r = ['', '', ''];
  Array.prototype.forEach.call($('resultInputs').querySelectorAll('select'), function (sel) {
    r[Number(sel.dataset.r)] = sel.value;
  });
  post('result', { result: r });
}

function saveSettings() {
  var s = {};
  Array.prototype.forEach.call($('setRows').querySelectorAll('[data-k]'), function (inp) {
    s[inp.dataset.k] = inp.value;
  });
  post('settings', { settings: s });
}

/** 画面に打ってある出走馬を読み取る。保存と「＋1人 増やす」の両方で使う。 */
function readHorses() {
  var rows = A.horsesRaw.map(function () { return { name: '', comment: '' }; });
  Array.prototype.forEach.call($('horseRows').querySelectorAll('input'), function (inp) {
    var r = rows[Number(inp.dataset.h)];
    if (r) r[inp.dataset.f] = inp.value;
  });
  return rows;
}

function readTeams() {
  var rows = A.teamsRaw.map(function () { return ''; });
  Array.prototype.forEach.call($('teamRows').querySelectorAll('input'), function (inp) {
    rows[Number(inp.dataset.t)] = inp.value;
  });
  return rows;
}

function saveHorses() { post('horses', { horses: readHorses() }); }
function saveTeams()  { post('teams',  { teams:  readTeams()  }); }

/** どの操作を保存したら、どのフォームの「未保存」を解除するか。 */
var CLEARS = {
  horses:   ['horses'],
  teams:    ['teams'],
  settings: ['settings'],
  result:   ['result'],
  reset:    ['horses', 'teams', 'settings', 'result'],
};

function post(action, body) {
  fetch('/api/admin/' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      show(res.message, res.ok);
      if (!res.ok) return;                    // 弾かれたら入力はそのまま残す
      if (res.state) A = res.state;

      // 保存できたフォームだけ「未保存」を解除して、サーバの値で描き直す
      (CLEARS[action] || []).forEach(function (k) { dirty[k] = false; });
      if (action === 'settings') $('setRows').dataset.built = '';
      renderHorses(true);
      renderTeams(true);
      renderResultInputs(true);
      render();
    })
    .catch(function (e) { show('通信エラー：' + e.message, false); });
}

/* ---------- 小道具 ---------- */
function show(text, ok) {
  var m = $('msg');
  m.textContent = text;
  m.className = 'msg ' + (ok ? 'ok' : 'ng');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function o(v) { return (v === null || v === undefined) ? '—' : Number(v).toFixed(2); }
function fmt(n) { return Number(n || 0).toLocaleString('ja-JP'); }
function time(iso) {
  var d = new Date(iso);
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}
function esc(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}
