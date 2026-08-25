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
const KV_LOCK_KEY = 'keiba_race_lock';
const LOCK_TTL_MS = 5000;      // 鍵の有効期限。インスタンスが落ちてもここで自動的に開く
const LOCK_WAIT_MS = 3000;     // 鍵が空くのを待つ上限
const KV_ENABLED = !!(KV_URL && KV_TOKEN && typeof fetch === 'function');

/**
 * ★サーバレス（Vercel）で「受付中」と「締切」が数秒ごとに往復する事故について
 *
 * Vercelではリクエストごとに別のインスタンスが応答することがあります。
 * インスタンスはメモリも /tmp も共有しないので、状態をクラウドKVに書き戻していないと
 *   運営が「受付開始」を押したインスタンス   … open = true
 *   それ以外のインスタンス                   … open = false
 * が並立し、参加者ページの3秒ごとの自動更新がどちらに当たるかで
 * 受付中と締切が入れ替わって見えます（買えたり買えなかったりする）。
 *
 * 対策はひとつだけで「書き換えたら必ずKVへ書き戻し、書き戻し終わるまで返事をしない」。
 *   save()  … ローカルへ即書き＋「まだKVに書けていない」印を立てる
 *   flush() … KVへ書き戻す。mutate() がレスポンス前に必ず待つ
 *   mutate()… 読み込み→書き換え→書き戻し を1本の待ち行列に通す
 */
let dirty = false;      // KVへ書き戻していない変更を抱えているか
let kvError = null;     // 直近のKV通信エラー（運営ページに出す）
let kvLoaded = false;   // 一度でもKVの内容を手にしたか（＝いまの state を信じてよいか）

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

/** Upstash / Vercel KV のRESTコマンドを1つ投げる。 */
async function kvCommand(args) {
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
    cache: 'no-store',
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 120)}`);
  return JSON.parse(text);
}

/**
 * クラウドKVから最新状態を読み込む。
 * まだ書き戻せていない変更を抱えているとき（dirty）は読まない。
 * 読んでしまうとその変更が古い内容で消され、まさに「勝手に元に戻る」が起きるため。
 */
async function syncFromKV() {
  if (!KV_ENABLED || dirty) return;
  let data;
  try {
    data = await kvCommand(['GET', KV_KEY]);
  } catch (e) {
    kvError = '読み込み失敗: ' + e.message;
    throw new Error(kvError);      // ★握りつぶさない。理由は下の syncForRead を参照
  }
  if (data && data.result) {
    const parsed = typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
    state = sanitizeState(parsed);
  }
  // 中身が空（result が null）でも「まだ誰も保存していない」という正しい答えなので信用してよい
  kvLoaded = true;
  kvError = null;
}

/**
 * 読み取り専用リクエストのための同期。
 *
 * ★ここが「受付と締切が往復する」の残り火だったところ。
 *   起動直後のインスタンスの state は freshState()＝「締切・購入0件」です。
 *   KVの読み込みに1回失敗しただけでそのまま返すと、参加者の3秒ごとの自動更新の
 *   なかでその1回だけが「締切」になり、受付中と締切が入れ替わって見えます。
 *   読めなかったときは推測で答えず、false を返して呼び出し側に断らせます。
 *
 * 戻り値 false＝「いま返せる正しい状態が無い」。
 */
async function syncForRead() {
  try {
    await syncFromKV();
    return true;
  } catch (e) {
    return kvLoaded;   // 一度でも読めているなら、その内容を出す方が無言の「締切」よりまし
  }
}

/** 状態を読めなかったことを、締切と誤解されない言葉で伝える。 */
function sendUnavailable(res) {
  return json(res, {
    unavailable: true,
    message: 'サーバの最新状態を読み取れませんでした。締切ではありません。数秒後に自動でやり直します。',
    detail: kvError || '',
  }, 503);
}

/**
 * 書き換えのあいだ、全インスタンスで1つだけ持てる鍵を取る。
 *
 * ★これが無いと、締切間際に複数チームが同時に購入したとき
 *     インスタンスA: KVを読む（購入2件）→ 自分の1件を足して3件を書く
 *     インスタンスB: KVを読む（購入2件）→ 自分の1件を足して3件を書く
 *   となって、後から書いた方が勝ち、片方の購入が「購入しました」と言われたのに消えます。
 *   読む前に鍵を取り、書き終えてから返すことで、この取りこぼしを防ぎます。
 *
 * 戻り値: 鍵の合言葉（KV未使用なら ''）。取れなかったときは null。
 */
async function acquireLock() {
  if (!KV_ENABLED) return '';      // 1プロセスだけなら下の待ち行列（chain）で足りる
  const token = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const until = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      const r = await kvCommand(['SET', KV_LOCK_KEY, token, 'NX', 'PX', String(LOCK_TTL_MS)]);
      if (r && r.result) return token;
    } catch (e) {
      kvError = '鍵の取得に失敗: ' + e.message;
      return null;
    }
    if (Date.now() >= until) return null;
    await sleep(30 + Math.floor(Math.random() * 50));   // 少しずらして再挑戦
  }
}

/** 鍵を返す。自分が取った鍵のときだけ消す（期限切れ後に他人の鍵を消さないため）。 */
async function releaseLock(token) {
  if (!KV_ENABLED || !token) return;
  const script = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
  try {
    await kvCommand(['EVAL', script, '1', KV_LOCK_KEY, token]);
  } catch (e) {
    // EVALが使えない構成向けの保険。最悪でも LOCK_TTL_MS で自然に開く。
    try { await kvCommand(['DEL', KV_LOCK_KEY]); } catch (e2) { /* 期限切れ待ち */ }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** クラウドKVへ現在の状態を書き込む。失敗したら投げる（呼び出し側が拾って表示する）。 */
async function syncToKV() {
  if (!KV_ENABLED) return;
  await kvCommand(['SET', KV_KEY, JSON.stringify(state)]);
  kvLoaded = true;
}

/**
 * 保存。ローカルには即書きし、クラウドKVへは flush() でまとめて書き戻します。
 * 書き戻しが終わるまでレスポンスを返さない（mutate() 参照）ので、
 * 「保存したのに次のリクエストで元に戻る」が起きません。
 */
function save() {
  dirty = true;
  saveLocal();
}

/**
 * 溜まっている変更をクラウドKVへ書き戻す。
 * 成功なら null、失敗ならその理由を返す（＝黙って失敗させない）。
 */
async function flush() {
  if (!dirty) return null;
  if (!KV_ENABLED) { dirty = false; return null; }
  try {
    await syncToKV();
    dirty = false;
    kvError = null;
    return null;
  } catch (e) {
    kvError = '保存失敗: ' + e.message;
    console.warn('⚠ KVへの保存に失敗しました:', e.message);
    return kvError;
  }
}

/**
 * ローカルへの保存。一時ファイルに書いてから置き換えるので、途中で落ちてもJSONが壊れません。
 */
function saveLocal() {
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
    // 保存まわりの健康状態。ここが赤いまま本番に入ると受付が往復します。
    storage: storageStatus(),
  };
}

/**
 * 保存先の状態。運営ページの上部に警告として出します。
 * 「動いてはいるが保存できていない」を黙って進ませないための表示です。
 */
function storageStatus() {
  let warning = null;
  if (IS_VERCEL && !KV_ENABLED) {
    warning = '★クラウドKVが未設定です。このままだとリクエストごとに別のサーバが応答し、' +
              '「受付中」と「締切」が数秒ごとに入れ替わって、購入もバラバラに消えます。' +
              '環境変数 KV_REST_API_URL と KV_REST_API_TOKEN を設定して再デプロイしてください。';
  } else if (kvError) {
    warning = '★クラウドKVとの通信に失敗しています（' + kvError + '）。' +
              'この間の変更は他の端末に伝わりません。';
  }
  return { cloud: KV_ENABLED, serverless: IS_VERCEL, error: kvError, warning: warning };
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

/**
 * 状態を書き換えるリクエストは、必ずこれを通す。
 *   1. 全インスタンス共通の鍵を取る
 *   2. KVから最新状態を読む
 *   3. 書き換える
 *   4. KVへ書き戻し終わってから鍵を返し、それから返事をする
 *
 * 同じインスタンス内は1本の待ち行列（chain）、インスタンスをまたぐぶんは鍵。
 * この2段構えで「読んでから書くまでの間に他人が書く」が起きなくなります。
 */
let chain = Promise.resolve();

function mutate(fn) {
  const run = chain.then(async () => {
    const lock = await acquireLock();
    if (lock === null) {
      // 鍵が取れない理由は2つある。順番待ちで詰まったのか、KVと話せていないのか。
      // 参加者には理由で言い方を変える（「重なった」と言われて何度も押させないため）。
      const jammed = kvError && kvError.indexOf('鍵の取得に失敗') === 0;
      return {
        ok: false,
        message: jammed
          ? '★サーバと通信できませんでした（' + kvError + '）。少し待ってからもう一度押してください。'
          : '★他の端末の処理と重なりました。もう一度押してください。',
      };
    }
    try {
      if (dirty) await flush();     // 前回書き戻せなかったぶんを先に片付ける
      try {
        await syncFromKV();
      } catch (e) {
        // ★最新を読めていないまま書き換えると、起動直後の空の状態でKVを上書きしてしまい、
        //   他の端末の購入がまとめて消えます。読めなかったら何もせずに断る。
        return { ok: false, message: '★サーバの最新状態を読めませんでした（' + kvError + '）。もう一度お試しください。' };
      }
      const out = fn();
      const err = await flush();
      if (err && out && out.ok) {
        out.ok = false;
        out.message = '★サーバに保存できませんでした（' + err + '）。もう一度お試しください。';
      }
      return out;
    } finally {
      await releaseLock(lock);
    }
  });
  chain = run.then(() => {}, () => {});   // 失敗しても行列は止めない
  return run;
}

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    /* --- 画面（状態を読まないので同期は不要） --- */
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
      if (!(await syncForRead())) return sendUnavailable(res);   // 読めなかったら推測で答えない
      return json(res, publicState(String(url.searchParams.get('team') || '').trim()));
    }
    if (req.method === 'POST' && p === '/api/bet') {
      const body = await readBody(req, res);
      if (body === undefined) return;
      return json(res, await mutate(() => submitBet(body)));
    }
    if (req.method === 'POST' && p === '/api/cancel') {
      const body = await readBody(req, res);
      if (body === undefined) return;
      return json(res, await mutate(() => cancelBet(body)));
    }

    /* --- 運営API --- */
    if (req.method === 'GET' && p === '/api/admin/state') {
      if (!(await syncForRead())) return sendUnavailable(res);   // 読めなかったら推測で答えない
      return json(res, adminState());
    }
    if (req.method === 'GET' && p === '/api/admin/bets.csv') {
      if (!(await syncForRead())) return sendUnavailable(res);   // 読めなかったら推測で答えない
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="bets.csv"',
      });
      return res.end(betsCsv());
    }
    if (req.method === 'GET' && p === '/api/admin/totals.csv') {
      if (!(await syncForRead())) return sendUnavailable(res);   // 読めなかったら推測で答えない
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
      const body = await readBody(req, res);
      if (body === undefined) return;
      const out = await mutate(() => {
        const o = fn(body);
        o.state = adminState();      // 書き戻し済みの状態をそのまま返す
        return o;
      });
      return json(res, out);
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

/**
 * リクエストボディを読んでJSONにする。
 * 読めなかったときはこの中で返事まで済ませて undefined を返す
 * （呼び出し側は undefined なら何もせず return するだけ）。
 */
function readBody(req, res) {
  return new Promise(resolve => {
    let raw = '';
    let over = false;
    req.on('data', c => {
      if (over) return;
      raw += c;
      if (raw.length > 100000) {
        over = true;
        json(res, { ok: false, message: '送信データが大きすぎます。' }, 413);
        resolve(undefined);
        req.destroy();
      }
    });
    req.on('end', () => {
      if (over) return;
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        json(res, { ok: false, message: '受け取れませんでした: ' + e.message }, 400);
        resolve(undefined);
      }
    });
    req.on('error', () => {
      if (over) return;
      over = true;
      resolve(undefined);
    });
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
