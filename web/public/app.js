/**
 * 参加者ページ。
 *
 * やっていることは3つだけ。
 *   1. /api/state を3秒ごとに読んで、最新のオッズと持ち点を画面に出す
 *   2. 券種・指名・賭けptから想定オッズを出して見せる
 *      → 計算は engine.js（サーバと同じファイル）に任せる
 *   3. /api/bet に投げる
 * 買えるか買えないかの最終判定はサーバ側。ここの入力チェックは親切表示のためだけ。
 */
'use strict';

var S = null;        // サーバから受け取った状態
var ticket = null;   // 選択中の券種
var busy = false;
var timer = null;
var LS_KEY = 'keiba.team';

var $ = function (id) { return document.getElementById(id); };

/* ---------- 起動 ---------- */
boot();

function boot() {
  $('add100').onclick = function () { addPt(100); };
  $('add300').onclick = function () { addPt(300); };
  $('allin').onclick = allIn;
  $('go').onclick = buy;
  $('team').onchange = function () {
    localStorage.setItem(LS_KEY, this.value);
    refresh(true);
  };
  ['p0', 'p1', 'p2'].forEach(function (id) { $(id).onchange = quote; });
  $('pt').oninput = quote;

  refresh(true);
  timer = setInterval(function () { if (!busy) refresh(false); }, 3000);
}

/** サーバから最新状態を取り直す。first=true のときは選択欄も作り直す。 */
function refresh(first) {
  var team = localStorage.getItem(LS_KEY) || '';
  fetch('/api/state?team=' + encodeURIComponent(team))
    .then(function (r) { return r.json(); })
    .then(function (s) {
      S = s;
      if (first) buildSelectors();
      render();
    })
    .catch(function (e) {
      $('status').innerHTML = '<span class="badge closed">接続できません</span> ' +
        'サーバが起動しているか確認してください。';
    });
}

/* ---------- 選択欄の組み立て ---------- */
function buildSelectors() {
  var saved = localStorage.getItem(LS_KEY) || '';
  $('team').innerHTML = '<option value="">— チームを選んでください —</option>' +
    S.teams.map(function (t) {
      return '<option' + (t === saved ? ' selected' : '') + '>' + esc(t) + '</option>';
    }).join('');

  ['p0', 'p1', 'p2'].forEach(function (id) {
    $(id).innerHTML = '<option value="">—</option>' +
      S.horses.map(function (h) { return '<option>' + esc(h.name) + '</option>'; }).join('');
  });

  $('tickets').innerHTML = S.tickets.map(function (t) {
    return '<button class="opt" data-t="' + t + '">' + t +
      '<small>' + (S.picks[t] === 1 ? '1人を指名' : '3人を指名') + '</small></button>';
  }).join('');
  Array.prototype.forEach.call(document.querySelectorAll('#tickets .opt'), function (b) {
    b.onclick = function () { pickTicket(b.dataset.t); };
  });
}

/* ---------- 画面の描き直し ---------- */
function render() {
  $('title').textContent = '🏇 ' + S.raceName;
  $('status').innerHTML = S.open
    ? '<span class="badge open">受付中</span> 締切までは何点でも買えます。'
    : (S.resultReady
        ? '<span class="badge closed">確定</span> レース終了。結果は下に出ています。'
        : '<span class="badge closed">締切</span> オッズはこの内容で確定しました。');

  var team = $('team').value;
  $('main').classList.toggle('hide', !team);
  $('buyCard').classList.toggle('hide', !S.open);

  if (S.me) $('bal').textContent = fmt(S.me.free);
  $('oddsLabel').textContent = S.open ? '現在のオッズ（変動中）' : '確定オッズ';
  $('go').disabled = busy || !S.open;

  renderOdds();
  renderHist();
  renderResult();
  renderStandings();
  quote();
}

function renderOdds() {
  $('oddsBody').innerHTML = S.horses.map(function (h) {
    var mark = '';
    if (S.resultReady) {
      var i = S.result.indexOf(h.name);
      if (i === 0) mark = ' 🥇'; else if (i === 1) mark = ' 🥈'; else if (i === 2) mark = ' 🥉';
    }
    return '<tr><td>' + esc(h.name) + mark +
      (h.comment ? ' <span style="color:var(--dim);font-size:11px">' + esc(h.comment) + '</span>' : '') +
      '</td><td>' + o(h.win) + '</td><td>' + o(h.place) +
      '</td><td style="color:var(--dim)">' + (h.p === null ? '—' : (h.p * 100).toFixed(0) + '%') +
      '</td><td style="color:var(--dim)">' + fmt(h.pool) + '</td></tr>';
  }).join('');
}

function renderHist() {
  var el = $('hist');
  if (!S.myBets.length) {
    el.innerHTML = '<div class="note">まだ購入がありません。</div>';
    $('histNote').textContent = '';
    return;
  }
  el.innerHTML = S.myBets.map(function (b) {
    var right;
    if (b.hit === null) {
      right = S.open
        ? '<button class="x" data-id="' + b.id + '">取消</button>'
        : '<span style="color:var(--dim);font-size:11px">結果待ち</span>';
    } else if (b.hit) {
      right = '<b style="color:var(--accent)">＋' + fmt(b.payout) + 'pt</b>';
    } else {
      right = '<span style="color:var(--dim)">不的中</span>';
    }
    return '<div class="hist"><span>' + time(b.time) + '　<b>' + esc(b.ticket) + '</b> ' +
      esc(b.picks.join(' → ')) + '　' + fmt(b.pt) + 'pt' +
      (b.odds === null ? '' : ' <span style="color:var(--dim);font-size:11px">(' +
        b.odds.toFixed(2) + '倍)</span>') +
      '</span>' + right + '</div>';
  }).join('');

  Array.prototype.forEach.call(el.querySelectorAll('.x'), function (btn) {
    btn.onclick = function () { cancel(btn.dataset.id); };
  });

  var used = S.me ? S.me.used : 0;
  $('histNote').textContent = '合計 ' + S.myBets.length + '点 / ' + fmt(used) + 'pt 使用' +
    (S.open ? '（オッズは他のチームの購入で動くので、上の倍率は今の暫定値です）' : '');
}

function renderResult() {
  $('resultCard').classList.toggle('hide', !S.resultReady);
  if (!S.resultReady || !S.me) return;
  var m = S.me;
  var cls = m.profit > 0 ? 'pos' : (m.profit < 0 ? 'neg' : '');
  $('resultBox').innerHTML =
    '<div style="font-size:17px;margin-bottom:10px">🥇 ' + esc(S.result[0]) +
    '　🥈 ' + esc(S.result[1]) + '　🥉 ' + esc(S.result[2]) + '</div>' +
    '<table><tbody>' +
    tr('使用pt', fmt(m.used)) + tr('払戻pt', fmt(m.ret)) +
    '<tr><td>収支</td><td class="' + cls + '"><b>' + (m.profit > 0 ? '＋' : '') + fmt(m.profit) +
    '</b></td></tr>' +
    tr('最終残高', '<b>' + fmt(m.balance) + '</b>') +
    tr('順位', '<b class="' + (m.rank === 1 ? 'rank1' : '') + '">' + m.rank + '位</b>') +
    '</tbody></table>';
}

function tr(k, v) { return '<tr><td>' + k + '</td><td>' + v + '</td></tr>'; }

function renderStandings() {
  $('standCard').classList.toggle('hide', !S.standings);
  if (!S.standings) return;
  var rows = S.standings.slice().sort(function (a, b) { return b.balance - a.balance; });
  $('standBody').innerHTML = rows.map(function (r) {
    var cls = r.profit > 0 ? 'pos' : (r.profit < 0 ? 'neg' : '');
    return '<tr><td class="' + (r.rank === 1 ? 'rank1' : '') + '">' + r.rank + '</td><td>' +
      esc(r.team) + '</td><td>' + fmt(r.used) + '</td><td>' + fmt(r.ret) +
      '</td><td class="' + cls + '">' + (r.profit > 0 ? '＋' : '') + fmt(r.profit) +
      '</td><td><b>' + fmt(r.balance) + '</b></td></tr>';
  }).join('');
}

/* ---------- 入力 ---------- */
function pickTicket(t) {
  ticket = t;
  Array.prototype.forEach.call(document.querySelectorAll('#tickets .opt'), function (b) {
    b.classList.toggle('on', b.dataset.t === t);
  });
  var three = S.picks[t] === 3;
  Array.prototype.forEach.call(document.querySelectorAll('.pick3'), function (e) {
    e.classList.toggle('hide', !three);
  });
  $('lb1').textContent = three ? '1着' : '本命';
  if (!three) { $('p1').value = ''; $('p2').value = ''; }
  quote();
}

function addPt(n) {
  $('pt').value = (Number($('pt').value) || 0) + n;
  quote();
}

function allIn() {
  $('pt').value = S.me ? S.me.free : 0;
  quote();
}

function picks() {
  var n = ticket ? S.picks[ticket] : 0;
  return ['p0', 'p1', 'p2'].slice(0, n).map(function (id) { return $(id).value; });
}

/** 想定オッズの表示。engine.js を呼ぶだけ＝サーバの精算と必ず同じ式。 */
function quote() {
  var box = $('quote');
  if (!S) return;
  if (!ticket) { box.textContent = 'まず券種を選んでください。'; return; }

  var ps = picks();
  var pt = Number($('pt').value);
  var chosen = ps.filter(Boolean);

  if (new Set(chosen).size !== chosen.length) {
    box.textContent = '同じ人を2回以上 選ぶことはできません。';
    return;
  }
  if (chosen.length !== ps.length) {
    box.textContent = S.picks[ticket] + '人を選んでください。';
    return;
  }
  if (S.totals.empty) {
    box.textContent = 'まだ誰も賭けていないのでオッズが決まりません（あなたが最初の1人です）。' +
      'このまま購入できます。';
    return;
  }

  var odds = Engine.oddsForBet(ticket, ps, { horses: S.horses }, S.settings);
  if (odds === null) { box.textContent = '指名を確認してください。'; return; }

  if (!pt || pt <= 0) {
    box.innerHTML = '想定オッズ <b>' + odds.toFixed(2) + '</b> 倍';
    return;
  }
  var ret = Engine.payout(pt, odds, S.settings);
  box.innerHTML = '想定オッズ <b>' + odds.toFixed(2) + '</b> 倍　→ 的中なら <b>' +
    fmt(ret) + '</b> pt（収支 ' + (ret - pt >= 0 ? '＋' : '') + fmt(ret - pt) + '）';
}

/* ---------- 送信 ---------- */
function buy() {
  if (busy) return;
  post('/api/bet', {
    team: $('team').value, ticket: ticket, picks: picks(), pt: Number($('pt').value),
  });
}

function cancel(id) {
  if (busy) return;
  if (!confirm('この購入を取り消しますか？')) return;
  post('/api/cancel', { team: $('team').value, id: id });
}

function post(url, body) {
  setBusy(true);
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      setBusy(false);
      show(res.message, res.ok);
      if (res.ok) {
        if (res.state) S = res.state;
        $('pt').value = '';
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    })
    .catch(function (e) {
      setBusy(false);
      show('通信エラー：' + e.message, false);
    });
}

/* ---------- 小道具 ---------- */
function setBusy(b) {
  busy = b;
  $('go').disabled = b || !S.open;
  $('go').textContent = b ? '送信中…' : 'この内容で購入する';
}
function show(text, ok) {
  var m = $('msg');
  m.textContent = text;
  m.className = 'msg ' + (ok ? 'ok' : 'ng');
}
function o(v) { return v === null ? '—' : v.toFixed(2); }
function fmt(n) { return Number(n || 0).toLocaleString('ja-JP'); }
function time(iso) {
  var d = new Date(iso);
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}
