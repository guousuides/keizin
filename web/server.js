/**
 * ============================================================
 *  夏合宿 競馬企画 — ローカルサーバ
 * ============================================================
 *  Node だけで動きます（npm install も外部ライブラリも不要）。
 *
 *    起動:  node server.js
 *    参加者: http://localhost:3000/
 *    運営  : http://localhost:3000/admin
 *
 *  同じWi-Fiのスマホから開けるように 0.0.0.0 で待ち受けます。
 *  起動時にターミナルへ「スマホ用のURL」を出すので、それを配ってください。
 *
 *  役割分担
 *    engine.js … オッズと払戻の計算（★式はあそこにしか無い）
 *    server.js … 保存と受付のルール（締切判定・残高チェックなど）
 *    public/   … 画面
 *
 *  データは data/race.json に都度保存します。
 *  サーバを再起動しても購入内容は消えません。
 * ============================================================
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Engine = require('./engine.js');

const PORT = Number(process.env.PORT) || 3000;
/** 運営ページのパス。心配なら ADMIN_PATH=/kanri node server.js のように変えられます。 */
const ADMIN_PATH = process.env.ADMIN_PATH || '/admin';

const DIR = __dirname;
const PUBLIC = path.join(DIR, 'public');
const DATA_DIR = path.join(DIR, 'data');
const DATA_FILE = path.join(DATA_DIR, 'race.json');
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');

/* ============================================================
 *  状態の読み書き
 * ============================================================ */

/** 初期状態。出走馬6人・チーム10組の空欄を用意しておく。 */
function freshState() {
  return {
    settings: Engine.defaultSettings(),
    horses: Array.from({ length: 6 }, (_, i) => ({ no: i + 1, name: '', comment: '' })),
    teams: Array.from({ length: 10 }, (_, i) => `チーム${i + 1}`),
    bets: [],
    result: ['', '', ''],
    seq: 0,            // 受付番号の連番
  };
}

let state = load();

function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const s = JSON.parse(raw);
    // 古い保存ファイルに新しい設定項目が無くても落ちないように既定値で埋める
    s.settings = Object.assign(Engine.defaultSettings(), s.settings || {});
    s.horses = s.horses || [];
    s.teams = s.teams || [];
    s.bets = s.bets || [];
    s.result = (s.result || ['', '', '']).slice(0, 3);
    s.seq = s.seq || s.bets.length;
    return s;
  } catch (e) {
    return freshState();
  }
}

/**
 * 保存。一時ファイルに書いてから置き換えるので、途中で落ちてもJSONが壊れません。
 *
 * ただしWindowsでは、ウイルス対策ソフトやOneDriveが一瞬ファイルを掴んでいると
 * 置き換え（rename）が EPERM で失敗します。デスクトップ上だと普通に起こります。
 * 失敗しても購入を無かったことにはできない（参加者が二重に買ってしまう）ので、
 *   ① 少し待って5回まで retry
 *   ② それでもダメなら直接上書き
 *   ③ それも失敗したら警告だけ出して続行（メモリ上の状態が正）
 * という順で粘ります。保存できなくても当日の進行は止まりません。
 */
function save() {
  const text = JSON.stringify(state, null, 2);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, text, 'utf8');

    for (let i = 0; i < 5; i++) {
      try {
        fs.renameSync(tmp, DATA_FILE);
        return;
      } catch (e) {
        if (i === 4) break;
        sleepSync(40);      // 掴んでいるプロセスが離すのを待つ
      }
    }
    fs.writeFileSync(DATA_FILE, text, 'utf8');   // 置き換えを諦めて直接上書き
    try { fs.unlinkSync(tmp); } catch (e) { /* 消せなくても実害なし */ }
  } catch (e) {
    console.warn('⚠ data/race.json に保存できませんでした:', e.message);
    console.warn('  進行は続きます（購入内容はサーバのメモリ上にあります）。');
    console.warn('  サーバを止める前に、運営ページの「CSVで書き出す」で控えを取ってください。');
  }
}

/** 同期的に少しだけ待つ（保存のretry用）。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 出走馬のうち名前が入っている馬だけ。計算はすべてこれを使う。 */
function activeHorses() {
  return state.horses.filter(h => String(h.name || '').trim() !== '')
    .map(h => ({ no: h.no, name: String(h.name).trim(), comment: String(h.comment || '') }));
}

function activeTeams() {
  return state.teams.map(t => String(t || '').trim()).filter(Boolean);
}

/* ============================================================
 *  参加者向けの状態
 * ============================================================ */

function publicState(teamName) {
  const s = state.settings;
  const horses = activeHorses();
  const teams = activeTeams();
  const table = Engine.computeOdds(horses, state.bets, s);
  const settled = Engine.settle(horses, state.bets, state.result, s);
  const stand = Engine.standings(teams, settled, state.result, s);

  const me = teamName ? stand.find(r => r.team === teamName) : null;
  const myBets = teamName
    ? settled.filter(b => b.team === teamName).slice().reverse()   // 新しい順
    : [];

  return {
    raceName: s.raceName,
    open: !!s.open,
    resultReady: Engine.resultReady(state.result),
    result: Engine.resultReady(state.result) ? state.result : ['', '', ''],
    tickets: Engine.TICKETS,
    picks: Engine.PICKS,
    horses: table.horses,
    totals: { sumA: table.sumA, T: table.T, empty: table.empty },
    teams: teams,
    initialPoints: s.initialPoints,
    // ブラウザ側でも同じ engine.js を使って想定オッズを出すために設定を渡す
    settings: {
      placeCoef: s.placeCoef, takeout: s.takeout,
      oddsFloor: s.oddsFloor, oddsCap: s.oddsCap,
      trifectaCoef: s.trifectaCoef, trioCoef: s.trioCoef,
      roundUnit: s.roundUnit, trifectaMode: s.trifectaMode,
      initialPoints: s.initialPoints,
    },
    me: me || null,
    myBets: myBets,
    standings: Engine.resultReady(state.result) ? stand : null,   // 結果が出るまで順位は隠す
  };
}

function adminState() {
  const s = state.settings;
  const horses = activeHorses();
  const teams = activeTeams();
  const table = Engine.computeOdds(horses, state.bets, s);
  const settled = Engine.settle(horses, state.bets, state.result, s);

  return {
    settings: s,
    settingInfo: Engine.SETTING_INFO,
    horsesRaw: state.horses,
    teamsRaw: state.teams,
    result: state.result,
    resultReady: Engine.resultReady(state.result),
    odds: table.horses,
    totals: { sumA: table.sumA, T: table.T, empty: table.empty },
    bets: settled.slice().reverse(),
    standings: Engine.standings(teams, settled, state.result, s),
    modes: [Engine.MODE.SIMPLE, Engine.MODE.HARVILLE],
    tickets: Engine.TICKETS,
    picks: Engine.PICKS,
    horseNames: horses.map(h => h.name),
    betCount: state.bets.length,
    totalStake: state.bets.reduce((a, b) => a + (Number(b.pt) || 0), 0),
  };
}

/* ============================================================
 *  購入の受付
 * ============================================================ */

/** 弾く条件はすべてここに集約。ブラウザ側の入力チェックは親切表示だけで、判定はここが正。 */
function submitBet(body) {
  const s = state.settings;
  if (!s.open) return { ok: false, message: '受付は締め切られています。' };

  const team = String(body.team || '').trim();
  const ticket = String(body.ticket || '').trim();
  const need = Engine.PICKS[ticket];
  const picks = (body.picks || []).map(x => String(x || '').trim()).filter(Boolean);
  const pt = Number(body.pt);

  if (activeTeams().indexOf(team) < 0) return { ok: false, message: 'チームを選んでください。' };
  if (need === undefined) return { ok: false, message: '券種を選んでください。' };
  if (picks.length !== need) return { ok: false, message: `${ticket}は${need}人 選んでください。` };

  const names = activeHorses().map(h => h.name);
  for (const p of picks) {
    if (names.indexOf(p) < 0) return { ok: false, message: `「${p}」は出走していません。` };
  }
  if (new Set(picks).size !== picks.length) {
    return { ok: false, message: '同じ人を2回以上 選ぶことはできません。' };
  }
  if (!isFinite(pt) || pt <= 0 || Math.floor(pt) !== pt) {
    return { ok: false, message: '賭けptは1以上の整数で入れてください。' };
  }

  const used = state.bets.filter(b => b.team === team)
    .reduce((a, b) => a + (Number(b.pt) || 0), 0);
  const free = s.initialPoints - used;
  if (pt > free) return { ok: false, message: `持ち点が足りません（残り ${free} pt）。` };

  state.seq += 1;
  state.bets.push({
    id: String(state.seq).padStart(4, '0'),
    time: new Date().toISOString(),
    team, ticket, picks, pt,
  });
  save();
  return {
    ok: true,
    message: `${ticket}　${picks.join(' → ')}　に ${pt}pt 購入しました。`,
    state: publicState(team),
  };
}

/** 参加者の取り消し。受付中で、かつ自分のチームの購入だけ。 */
function cancelBet(body) {
  if (!state.settings.open) {
    return { ok: false, message: '締切後は取り消せません。運営に相談してください。' };
  }
  const team = String(body.team || '').trim();
  const id = String(body.id || '');
  const i = state.bets.findIndex(b => b.id === id && b.team === team);
  if (i < 0) return { ok: false, message: '該当の購入が見つかりませんでした。' };
  state.bets.splice(i, 1);
  save();
  return { ok: true, message: '取り消しました。', state: publicState(team) };
}

/* ============================================================
 *  運営の操作
 * ============================================================ */

const adminActions = {
  /** 設定の更新。数値項目は数値に直してから入れる。 */
  settings(body) {
    const s = state.settings;
    Engine.SETTING_INFO.forEach(info => {
      if (!(info.key in (body.settings || {}))) return;
      const v = body.settings[info.key];
      if (info.type === 'number') {
        const n = Number(v);
        if (isFinite(n)) s[info.key] = n;
      } else {
        s[info.key] = String(v);
      }
    });
    // 明らかにおかしい値は直してしまう（0除算や逆転を防ぐ）
    if (!(s.oddsFloor >= 1)) s.oddsFloor = 1;
    if (!(s.oddsCap > s.oddsFloor)) s.oddsCap = s.oddsFloor + 1;
    if (!(s.roundUnit > 0)) s.roundUnit = 1;
    if (!(s.takeout >= 0) || s.takeout >= 1) s.takeout = 0;
    if (!(s.placeCoef > 0)) s.placeCoef = 1 / 3;
    save();
    return { ok: true, message: '設定を保存しました。' };
  },

  /** 出走馬の名前とひとことコメント。 */
  horses(body) {
    const rows = Array.isArray(body.horses) ? body.horses : [];
    state.horses = rows.slice(0, 20).map((h, i) => ({
      no: i + 1,
      name: String(h.name || '').trim(),
      comment: String(h.comment || '').trim(),
    }));
    // 消えた馬に賭けられていた馬券があると計算から漏れるので警告する
    const names = state.horses.map(h => h.name);
    const orphan = state.bets.some(b => (b.picks || []).some(p => names.indexOf(p) < 0));
    save();
    return {
      ok: true,
      message: orphan
        ? '保存しました。★既に購入された馬券の中に、今の出走馬に居ない名前があります（その馬券は集計から外れます）。'
        : '出走馬を保存しました。',
    };
  },

  teams(body) {
    const rows = Array.isArray(body.teams) ? body.teams : [];
    state.teams = rows.slice(0, 40).map(t => String(t || '').trim());
    save();
    return { ok: true, message: 'チームを保存しました。' };
  },

  /** 受付の開始・締切。締切を押した瞬間のオッズが確定オッズ。 */
  open(body) {
    state.settings.open = !!body.open;
    save();
    return {
      ok: true,
      message: state.settings.open
        ? '受付を開始しました。参加者は購入できます。'
        : '受付を締め切りました。この時点のオッズで確定です。',
    };
  },

  /** 着順の入力。3つ埋まった瞬間に精算とチーム順位が動く。 */
  result(body) {
    const r = (body.result || []).slice(0, 3).map(x => String(x || '').trim());
    while (r.length < 3) r.push('');
    const filled = r.filter(Boolean);
    if (new Set(filled).size !== filled.length) {
      return { ok: false, message: '同じ人を2つの着順に入れることはできません。' };
    }
    const names = activeHorses().map(h => h.name);
    for (const x of filled) {
      if (names.indexOf(x) < 0) return { ok: false, message: `「${x}」は出走していません。` };
    }
    state.result = r;
    save();
    return {
      ok: true,
      message: Engine.resultReady(r)
        ? '着順を確定しました。精算と順位が出ています。'
        : '保存しました（3着まで埋まると精算が始まります）。',
    };
  },

  /** 運営による1点取り消し。押し間違いの救済用。 */
  deleteBet(body) {
    const i = state.bets.findIndex(b => b.id === String(body.id || ''));
    if (i < 0) return { ok: false, message: '見つかりませんでした。' };
    const b = state.bets.splice(i, 1)[0];
    save();
    return { ok: true, message: `${b.team} の ${b.ticket} ${b.pt}pt を取り消しました。` };
  },

  /**
   * 次のレースへ。購入と着順だけ消して、出走馬・チーム・設定は残す。
   * 消す前に data/archive/ へ丸ごと退避するので、後から見返せます。
   */
  reset(body) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = String(state.settings.raceName || 'race').replace(/[\\/:*?"<>|]/g, '_');
    fs.writeFileSync(path.join(ARCHIVE_DIR, `${stamp}_${name}.json`),
      JSON.stringify(state, null, 2), 'utf8');

    state.bets = [];
    state.result = ['', '', ''];
    state.seq = 0;
    state.settings.open = false;
    if (body.raceName) state.settings.raceName = String(body.raceName).trim();
    if (body.clearHorses) {
      state.horses = state.horses.map(h => ({ no: h.no, name: '', comment: '' }));
    }
    save();
    return { ok: true, message: `前のレースを data/archive/ に保存して、リセットしました。` };
  },
};

/* ============================================================
 *  CSV書き出し（スプレッドシートに貼り戻したいとき用）
 * ============================================================ */

function betsCsv() {
  const s = state.settings;
  const settled = Engine.settle(activeHorses(), state.bets, state.result, s);
  const head = ['受付ID', '受付時刻', 'チーム', '券種', '1着指名', '2着指名', '3着指名',
                '賭けPt', '適用オッズ', '的中', '払戻pt'];
  const lines = [head.join(',')];
  settled.forEach(b => {
    lines.push([
      b.id,
      new Date(b.time).toLocaleString('ja-JP'),
      b.team, b.ticket,
      b.picks[0] || '', b.picks[1] || '', b.picks[2] || '',
      b.pt,
      b.odds === null ? '' : b.odds.toFixed(2),
      b.hit === null ? '' : (b.hit ? '的中' : '不的中'),
      b.payout === null ? '' : b.payout,
    ].map(csvCell).join(','));
  });
  return '﻿' + lines.join('\r\n');   // BOM付き。Excel/スプレッドシートで文字化けしない
}

function csvCell(v) {
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/* ============================================================
 *  HTTPサーバ
 * ============================================================ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    /* --- 画面 --- */
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return sendFile(res, path.join(PUBLIC, 'index.html'));
    }
    if (req.method === 'GET' && (p === ADMIN_PATH || p === ADMIN_PATH + '/')) {
      return sendFile(res, path.join(PUBLIC, 'admin.html'));
    }
    if (req.method === 'GET' && p === '/engine.js') {
      return sendFile(res, path.join(DIR, 'engine.js'));
    }

    /* --- 参加者API --- */
    if (req.method === 'GET' && p === '/api/state') {
      return json(res, publicState(String(url.searchParams.get('team') || '').trim()));
    }
    if (req.method === 'POST' && p === '/api/bet') {
      return withBody(req, res, body => json(res, submitBet(body)));
    }
    if (req.method === 'POST' && p === '/api/cancel') {
      return withBody(req, res, body => json(res, cancelBet(body)));
    }

    /* --- 運営API --- */
    if (req.method === 'GET' && p === '/api/admin/state') {
      return json(res, adminState());
    }
    if (req.method === 'GET' && p === '/api/admin/bets.csv') {
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="bets.csv"',
      });
      return res.end(betsCsv());
    }
    if (req.method === 'POST' && p.startsWith('/api/admin/')) {
      const action = p.slice('/api/admin/'.length);
      const fn = adminActions[action];
      if (!fn) return json(res, { ok: false, message: '不明な操作です。' }, 404);
      return withBody(req, res, body => {
        const out = fn(body);
        out.state = adminState();
        json(res, out);
      });
    }

    /* --- その他の静的ファイル --- */
    if (req.method === 'GET') {
      const file = path.join(PUBLIC, path.normalize(p).replace(/^[\\/]+/, ''));
      if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return sendFile(res, file);
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('見つかりません: ' + p);
  } catch (e) {
    console.error(e);
    json(res, { ok: false, message: 'サーバ側でエラー: ' + e.message }, 500);
  }
});

function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('ファイルがありません: ' + path.basename(file));
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',   // 当日その場で直しても即反映されるように
    });
    res.end(buf);
  });
}

function json(res, obj, code) {
  res.writeHead(code || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

function withBody(req, res, fn) {
  let raw = '';
  let tooBig = false;
  req.on('data', c => {
    raw += c;
    if (raw.length > 100000) { tooBig = true; req.destroy(); }
  });
  req.on('end', () => {
    if (tooBig) return json(res, { ok: false, message: '送信データが大きすぎます。' }, 413);
    try {
      fn(raw ? JSON.parse(raw) : {});
    } catch (e) {
      json(res, { ok: false, message: '受け取れませんでした: ' + e.message }, 400);
    }
  });
}

/* ============================================================
 *  起動
 * ============================================================ */

server.listen(PORT, '0.0.0.0', () => {
  const ips = [];
  Object.values(os.networkInterfaces()).forEach(list => {
    (list || []).forEach(ni => {
      if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
    });
  });

  console.log('');
  console.log('  🏇 夏合宿 競馬企画 サーバ起動');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  参加者ページ  http://localhost:${PORT}/`);
  console.log(`  運営ページ    http://localhost:${PORT}${ADMIN_PATH}`);
  if (ips.length) {
    console.log('');
    console.log('  同じWi-Fiのスマホからは ↓ を配ってください');
    ips.forEach(ip => console.log(`      http://${ip}:${PORT}/`));
    console.log(`  （運営ページも同じWi-Fiの誰でも開けます。気になるときは`);
    console.log(`    ADMIN_PATH=/himitsu node server.js のようにパスを変えてください）`);
  }
  console.log('');
  console.log(`  データ: ${DATA_FILE}`);
  console.log('  止めるときは Ctrl+C');
  console.log('');
});
