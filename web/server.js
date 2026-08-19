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

const IS_VERCEL = !!process.env.VERCEL;
const DIR = __dirname;
const PUBLIC = path.join(DIR, 'public');
const DATA_DIR = IS_VERCEL ? path.join(os.tmpdir(), 'keizin-data') : path.join(DIR, 'data');
const DATA_FILE = path.join(DATA_DIR, 'race.json');
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');

// Upstash Redis / Vercel KV の REST API（設定されていればクラウド同期、無ければローカル/tmp保存）
const KV_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_REST_URL || '').replace(/\/+$/, '');
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_REST_TOKEN || '';
const KV_KEY = 'keiba_race_state';

/* ============================================================
 *  状態の読み書き
 * ============================================================ */

/**
 * 初期状態。出走馬6人・チーム10組の空欄を用意しておく。
 *
 * carry / raceNo / history が「レースをまたいで持ち点を引き継ぐ」ための3点セット。
 *   carry   … 今のレースの開始持ち点 { チーム名: pt }。空なら全員 initialPoints。
 *   raceNo  … 何レース目か（1始まり）
 *   history … 終わったレースの記録。通算表に出す。
 */
function freshState() {
  return {
    settings: Engine.defaultSettings(),
    horses: Array.from({ length: 6 }, (_, i) => ({ no: i + 1, name: '', comment: '' })),
    teams: Array.from({ length: 10 }, (_, i) => `チーム${i + 1}`),
    bets: [],
    result: ['', '', ''],
    seq: 0,            // 受付番号の連番
    carry: {},
    raceNo: 1,
    history: [],
  };
}

function sanitizeState(s) {
  if (!s || typeof s !== 'object') return freshState();
  s.settings = Object.assign(Engine.defaultSettings(), s.settings || {});
  s.horses = s.horses || [];
  s.teams = s.teams || [];
  s.bets = s.bets || [];
  s.result = (s.result || ['', '', '']).slice(0, 3);
  s.seq = s.seq || s.bets.length;
  s.carry = (s.carry && typeof s.carry === 'object') ? s.carry : {};
  s.raceNo = Number(s.raceNo) > 0 ? Number(s.raceNo) : 1;
  s.history = Array.isArray(s.history) ? s.history : [];
  return s;
}

let state = loadLocal();

function loadLocal() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return sanitizeState(JSON.parse(raw));
  } catch (e) {
    return freshState();
  }
}

/** クラウドKVが設定されている場合は最新状態を同期 */
async function syncFromKV() {
  if (!KV_URL || !KV_TOKEN || typeof fetch !== 'function') return;
  try {
    const res = await fetch(`${KV_URL}/get/${KV_KEY}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.result) {
      const parsed = typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
      state = sanitizeState(parsed);
    }
  } catch (e) {
    // KV接続失敗時はメモリ/ローカルのstateを維持
  }
}

/** クラウドKVへの非同期保存 */
async function syncToKV() {
  if (!KV_URL || !KV_TOKEN || typeof fetch !== 'function') return;
  try {
    await fetch(`${KV_URL}/set/${KV_KEY}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KV_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(state),
    });
  } catch (e) {
    console.warn('⚠ KVへの保存に失敗しました:', e.message);
  }
}

/**
 * 保存。一時ファイルに書いてから置き換えるので、途中で落ちてもJSONが壊れません。
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
    if (!IS_VERCEL) {
      console.warn('⚠ data/race.json に保存できませんでした:', e.message);
    }
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

/** このレースの開始持ち点。＝前レース終了時の残高、無ければ初期持ち点。 */
function startPointsFor(team) {
  return Engine.startPoints(team, state.settings, state.carry);
}

/** 今のレースのチーム収支（開始pt・残高つき）。 */
function currentStandings() {
  const settled = Engine.settle(activeHorses(), state.bets, state.result, state.settings);
  return Engine.standings(activeTeams(), settled, state.result, state.settings, state.carry);
}

/**
 * チームごとの通算表。history に積んだ各レースの残高を横に並べる。
 * 「今どれだけ持っているか」は現レースの残高がそのまま答えになります
 * （繰越が入っているので、残高＝通算成績）。
 */
function totalsByTeam() {
  const now = currentStandings();
  const ready = Engine.resultReady(state.result);
  const settled = Engine.settle(activeHorses(), state.bets, state.result, state.settings);
  const hitsNow = {};
  settled.forEach(b => { if (b.hit === true) hitsNow[b.team] = (hitsNow[b.team] || 0) + 1; });

  return now.map(r => {
    const past = state.history.map(h => (h.teams && h.teams[r.team]) || null);
    const usedAll = past.reduce((a, p) => a + (p ? p.used : 0), 0) + r.used;
    const retAll = past.reduce((a, p) => a + (p ? p.ret : 0), 0) + r.ret;
    const hitAll = past.reduce((a, p) => a + (p ? p.hits || 0 : 0), 0) + (hitsNow[r.team] || 0);
    return {
      team: r.team,
      races: state.history.length + (ready ? 1 : 0),
      usedAll, retAll, hitAll,
      perRace: past.map(p => (p ? p.balance : null)),
      start: r.start,
      balance: r.balance,     // ＝いま持っている点（繰越込み）
      rank: r.rank,
    };
  });
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
  const stand = Engine.standings(teams, settled, state.result, s, state.carry);

  const me = teamName ? stand.find(r => r.team === teamName) : null;
  const myBets = teamName
    ? settled.filter(b => b.team === teamName).slice().reverse()   // 新しい順
    : [];

  return {
    raceName: s.raceName,
    raceNo: state.raceNo,
    carryOn: state.history.length > 0,   // 2レース目以降か（繰越の説明を出すかの判定）
    open: !!s.open,
    resultReady: Engine.resultReady(state.result),
    result: Engine.resultReady(state.result) ? state.result : ['', '', ''],
    tickets: Engine.TICKETS,
    picks: Engine.PICKS,
    horses: table.horses,
    totals: { sumA: table.sumA, T: table.T, empty: table.empty },
    betCount: state.bets.length,
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
    // 終わったレースの自分の成績（繰越の内訳を見せるため）
    myHistory: teamName
      ? state.history.map(h => Object.assign(
          { raceName: h.raceName },
          (h.teams && h.teams[teamName]) || null))
        .filter(x => x.balance !== undefined)
      : [],
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
    standings: Engine.standings(teams, settled, state.result, s, state.carry),
    modes: [Engine.MODE.SIMPLE, Engine.MODE.HARVILLE],
    tickets: Engine.TICKETS,
    picks: Engine.PICKS,
    horseNames: horses.map(h => h.name),
    betCount: state.bets.length,
    totalStake: state.bets.reduce((a, b) => a + (Number(b.pt) || 0), 0),
    // 繰越まわり
    raceNo: state.raceNo,
    carry: teams.map(t => ({ team: t, start: startPointsFor(t), carried: state.carry[t] !== undefined })),
    history: state.history.map(h => ({ raceName: h.raceName, result: h.result })),
    teamTotals: totalsByTeam(),
    carryPool: teams.reduce((a, t) => a + startPointsFor(t), 0),
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

  // ★持ち点は「このレースの開始pt」基準。前レースで増やした払戻ぶんもここに入っている。
  const start = startPointsFor(team);
  const used = state.bets.filter(b => b.team === team)
    .reduce((a, b) => a + (Number(b.pt) || 0), 0);
  const free = start - used;
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
   *
   * ★ここで持ち点を繰り越します。
   *   着順が3つ埋まっている（＝精算済み）なら、各チームの残高＝開始pt＋収支を
   *   次のレースの開始ptにします。的中した払戻ぶんもそのまま次で使えます。
   *
   *   着順が入っていないままリセットした場合は繰り越しません。
   *   計算しようとすると全馬券が「不的中」扱いになって、賭けた点数だけ没収される
   *   （＝レース中止なのに全員が損する）ので、そのレースを丸ごと無かったことにします。
   */
  reset(body) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = String(state.settings.raceName || 'race').replace(/[\\/:*?"<>|]/g, '_');
    fs.writeFileSync(path.join(ARCHIVE_DIR, `${stamp}_${name}.json`),
      JSON.stringify(state, null, 2), 'utf8');

    const settled = Engine.settle(activeHorses(), state.bets, state.result, state.settings);
    const stand = Engine.standings(activeTeams(), settled, state.result,
                                  state.settings, state.carry);
    const ready = Engine.resultReady(state.result);
    let note;

    if (ready) {
      const hits = {};
      settled.forEach(b => { if (b.hit === true) hits[b.team] = (hits[b.team] || 0) + 1; });

      // 通算表のために1レースぶんを記録
      const rec = { raceName: state.settings.raceName, result: state.result.slice(), teams: {} };
      stand.forEach(r => {
        rec.teams[r.team] = {
          start: r.start, used: r.used, ret: r.ret, profit: r.profit,
          balance: r.balance, rank: r.rank, count: r.count, hits: hits[r.team] || 0,
        };
      });
      state.history.push(rec);

      state.carry = Engine.nextCarry(stand, state.settings);
      state.raceNo += 1;

      const revived = stand.filter(r => state.carry[r.team] > r.balance).length;
      note = `残高をそのまま次のレースの持ち点に繰り越しました（${stand.length}チーム）。` +
        (revived ? `うち ${revived} チームは敗者復活の最低持ち点まで戻しています。` : '');
    } else {
      note = '★着順が未入力だったので、このレースは無効として持ち点を繰り越していません' +
             '（賭けた点数は返ります）。着順を入れてからリセットすると精算した残高が繰り越されます。';
    }

    state.bets = [];
    state.result = ['', '', ''];
    state.seq = 0;
    state.settings.open = false;
    if (body.raceName) {
      state.settings.raceName = String(body.raceName).trim();
    } else if (ready) {
      state.settings.raceName = `第${state.raceNo}レース`;
    }
    if (body.clearHorses) {
      state.horses = state.horses.map(h => ({ no: h.no, name: '', comment: '' }));
    }
    save();
    return { ok: true, message: `前のレースを data/archive/ に保存しました。${note}` };
  },

  /**
   * 持ち点の手直し。入力ミスの救済用。
   * 「そのレースの開始pt」を直接書き換えます（受付中に触ると参加者の残高が動きます）。
   */
  carry(body) {
    const rows = body.carry || {};
    const teams = activeTeams();
    let n = 0;
    teams.forEach(t => {
      if (!(t in rows)) return;
      const v = Number(rows[t]);
      if (!isFinite(v) || v < 0) return;
      state.carry[t] = Math.floor(v);
      n += 1;
    });
    // 既に使った点より少ない持ち点にしてしまうと残高がマイナスになるので警告
    const over = currentStandings().filter(r => r.free < 0).map(r => r.team);
    save();
    return {
      ok: true,
      message: `${n} チームの持ち点を書き換えました。` +
        (over.length ? `★${over.join('・')} は既に購入した点数を下回っています（残高がマイナス）。` : ''),
    };
  },

  /** 企画のやり直し。繰越も履歴も消して全チーム初期持ち点に戻す。 */
  restart() {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(ARCHIVE_DIR, `${stamp}_restart.json`),
      JSON.stringify(state, null, 2), 'utf8');

    state.bets = [];
    state.result = ['', '', ''];
    state.seq = 0;
    state.carry = {};
    state.raceNo = 1;
    state.history = [];
    state.settings.open = false;
    state.settings.raceName = '第1レース';
    save();
    return {
      ok: true,
      message: `全部リセットしました。全チーム ${state.settings.initialPoints}pt からやり直しです` +
               `（直前の状態は data/archive/ にあります）。`,
    };
  },
};

/* ============================================================
 *  CSV書き出し（スプレッドシートに貼り戻したいとき用）
 * ============================================================ */

function betsCsv() {
  const s = state.settings;
  const settled = Engine.settle(activeHorses(), state.bets, state.result, s);
  const head = ['レース', '受付ID', '受付時刻', 'チーム', '券種', '1着指名', '2着指名', '3着指名',
                '賭けPt', '適用オッズ', '的中', '払戻pt'];
  const lines = [head.join(',')];
  settled.forEach(b => {
    lines.push([
      s.raceName,
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

/**
 * 通算表のCSV。レースごとの残高が横に並びます。
 * 最後の列が「いま持っている点」＝繰越込みの通算成績。
 */
function totalsCsv() {
  const rows = totalsByTeam();
  const head = ['チーム']
    .concat(state.history.map(h => (h.raceName || 'レース') + '終了時'))
    .concat([state.settings.raceName + 'の開始pt', '現在の持ち点',
             '通算使用pt', '通算払戻pt', '通算的中数']);
  const lines = [head.join(',')];
  rows.forEach(r => {
    lines.push([r.team].concat(r.perRace.map(v => (v === null ? '' : v)))
      .concat([r.start, r.balance, r.usedAll, r.retAll, r.hitAll])
      .map(csvCell).join(','));
  });
  return '﻿' + lines.join('\r\n');
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

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    // クラウドKVが設定されている場合は最新データを同期
    await syncFromKV();

    /* --- 画面 --- */
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return sendFile(res, path.join(PUBLIC, 'index.html'));
    }
    if (req.method === 'GET' && (p === '/odds' || p === '/odds.html')) {
      return sendFile(res, path.join(PUBLIC, 'odds.html'));
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
    if (req.method === 'GET' && p === '/api/admin/totals.csv') {
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="totals.csv"',
      });
      return res.end(totalsCsv());
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
}

const server = http.createServer(handleRequest);

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
 *  エクスポートと起動
 * ============================================================ */

module.exports = handleRequest;

if (require.main === module) {
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
    console.log(`  オッズ画面    http://localhost:${PORT}/odds  （スクリーン投影用）`);
    console.log(`  運営ページ    http://localhost:${PORT}${ADMIN_PATH}`);
    if (ips.length) {
      console.log('');
      console.log('  同じWi-Fiのスマホからは ↓ を配ってください');
      ips.forEach(ip => console.log(`      http://${ip}:${PORT}/`));
      console.log('');
      console.log('  会場のスクリーン・プロジェクター用:');
      ips.forEach(ip => console.log(`      http://${ip}:${PORT}/odds`));
      console.log(`  （運営ページも同じWi-Fiの誰でも開けます。気になるときは`);
      console.log(`    ADMIN_PATH=/himitsu node server.js のようにパスを変えてください）`);
    }
    console.log('');
    console.log(`  データ: ${DATA_FILE}`);
    console.log('  止めるときは Ctrl+C');
    console.log('');
  });
}
