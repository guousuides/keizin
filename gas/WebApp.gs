/**
 * ============================================================
 *  夏合宿 競馬企画 — Webアプリ（馬券購入フォーム）
 * ============================================================
 *  参加者はスマホでこのURLを開いて馬券を買います。
 *  やっていることは実質「購入ログシートに1行 追記する」だけ。
 *  オッズも払戻もスプレッドシート側の数式が計算するので、
 *  ここには金額の計算ロジックを置いていません（＝二重管理を避ける）。
 *  唯一の例外はフォーム上のオッズ「予想」表示で、
 *  これは精算シートH列と同じ式をJS側で写しているだけです。
 * ============================================================
 */

function doGet() {
  return HtmlService.createTemplateFromFile('Form')
    .evaluate()
    .setTitle('🏇 馬券購入')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** 対象のスプレッドシートを取得。Webアプリ実行中は getActive() が使えないことがあるのでIDで開く。 */
function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('SS_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActive();
}

function 設定値_(ss, key) {
  return ss.getSheetByName(CFG.SHEETS.SETTING).getRange(SETTING_ROWS[key], 2).getValue();
}

/* ============================================================
 *  画面に渡すデータ
 * ============================================================ */

/**
 * フォームの初期表示に必要なものを一式返す。
 * 購入のたびに呼び直してオッズを更新する。
 */
function getState(teamName) {
  const ss = ss_();
  const S = CFG.SHEETS;
  const first = CFG.FIRST_ROW;

  const 出走 = ss.getSheetByName(S.HORSE)
    .getRange(first, 1, CFG.HORSE_COUNT, 3).getValues();
  const オッズ = ss.getSheetByName(S.ODDS)
    .getRange(first, 7, CFG.HORSE_COUNT, 5).getValues();  // G:K = A_i, 素O, 単勝, 複勝, p

  const horses = [];
  for (let i = 0; i < CFG.HORSE_COUNT; i++) {
    if (!出走[i][1]) continue;   // 名前未入力の行は出さない
    horses.push({
      no:      出走[i][0],
      name:    String(出走[i][1]),
      comment: String(出走[i][2] || ''),
      pool:    Number(オッズ[i][0]) || 0,
      raw:     Number(オッズ[i][1]) || 0,   // 素オッズ O_i（三連系の計算に使う）
      win:     typeof オッズ[i][2] === 'number' ? オッズ[i][2] : null,
      place:   typeof オッズ[i][3] === 'number' ? オッズ[i][3] : null,
      p:       Number(オッズ[i][4]) || 0,
    });
  }

  const teamNames = ss.getSheetByName(S.TEAM)
    .getRange(first, 1, CFG.TEAM_COUNT, 1).getValues()
    .map(r => String(r[0]).trim()).filter(String);

  const 使用 = 使用pt集計_(ss);
  const 初期 = Number(設定値_(ss, '初期持ち点')) || 0;
  const teams = teamNames.map(n => ({
    name: n,
    used: 使用[n] || 0,
    balance: 初期 - (使用[n] || 0),
  }));

  return {
    raceName:  String(設定値_(ss, 'レース名') || 'レース'),
    open:      String(設定値_(ss, '受付状態')) === '受付中',
    tickets:   CFG.TICKETS,
    picks:     CFG.PICKS,
    horses:    horses,
    teams:     teams,
    initial:   初期,
    // 精算シートH列と同じ計算をフォーム側で再現するためのパラメータ
    calc: {
      floor:      Number(設定値_(ss, 'オッズ下限')),
      cap:        Number(設定値_(ss, 'オッズ上限')),
      tanCoef:    Number(設定値_(ss, '三連単係数')),
      fukuCoef:   Number(設定値_(ss, '三連複係数')),
      mode:       String(設定値_(ss, '三連系方式')),
      harvilleId: TRIFECTA_MODES.HARVILLE,
    },
    history: teamName ? 購入履歴_(ss, teamName) : [],
  };
}

/** チームごとの使用ptを購入ログから集計。 */
function 使用pt集計_(ss) {
  const log = ss.getSheetByName(CFG.SHEETS.LOG);
  const n = log.getLastRow() - CFG.FIRST_ROW + 1;
  const out = {};
  if (n <= 0) return out;
  log.getRange(CFG.FIRST_ROW, 2, n, 6).getValues().forEach(r => {
    const team = String(r[0]).trim();
    if (!team) return;
    out[team] = (out[team] || 0) + (Number(r[5]) || 0);
  });
  return out;
}

/** そのチームの購入履歴（新しい順）。 */
function 購入履歴_(ss, teamName) {
  const log = ss.getSheetByName(CFG.SHEETS.LOG);
  const n = log.getLastRow() - CFG.FIRST_ROW + 1;
  if (n <= 0) return [];
  const rows = log.getRange(CFG.FIRST_ROW, 1, n, 8).getValues();
  const out = [];
  rows.forEach(r => {
    if (String(r[1]).trim() !== String(teamName).trim()) return;
    out.push({
      time:   r[0] instanceof Date ? Utilities.formatDate(r[0], 'Asia/Tokyo', 'HH:mm') : '',
      ticket: String(r[2]),
      picks:  [r[3], r[4], r[5]].filter(String).map(String),
      pt:     Number(r[6]) || 0,
      id:     String(r[7]),
    });
  });
  return out.reverse();
}

/* ============================================================
 *  購入の受付
 * ============================================================ */

/**
 * 馬券を1点購入する。
 * 弾く条件はすべてここに集約：締切・存在しないチーム/馬・重複指名・pt不正・残高オーバー・行数オーバー。
 */
function submitBet(payload) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    return { ok: false, message: '混み合っています。もう一度押してください。' };
  }
  try {
    const ss = ss_();
    const S = CFG.SHEETS;

    if (String(設定値_(ss, '受付状態')) !== '受付中') {
      return { ok: false, message: '受付は締め切られました。' };
    }

    const team = String(payload.team || '').trim();
    const ticket = String(payload.ticket || '').trim();
    const picks = (payload.picks || []).map(s => String(s || '').trim()).filter(String);
    const pt = Number(payload.pt);

    const teamNames = ss.getSheetByName(S.TEAM)
      .getRange(CFG.FIRST_ROW, 1, CFG.TEAM_COUNT, 1).getValues()
      .map(r => String(r[0]).trim()).filter(String);
    if (teamNames.indexOf(team) < 0) return { ok: false, message: 'チームを選んでください。' };

    if (CFG.TICKETS.indexOf(ticket) < 0) return { ok: false, message: '券種を選んでください。' };

    const need = CFG.PICKS[ticket];
    if (picks.length !== need) {
      return { ok: false, message: `${ticket}は${need}頭 選んでください。` };
    }

    const horseNames = ss.getSheetByName(S.HORSE)
      .getRange(CFG.FIRST_ROW, 2, CFG.HORSE_COUNT, 1).getValues()
      .map(r => String(r[0]).trim()).filter(String);
    for (const p of picks) {
      if (horseNames.indexOf(p) < 0) return { ok: false, message: `「${p}」は出走していません。` };
    }
    if (new Set(picks).size !== picks.length) {
      return { ok: false, message: '同じ人を2回以上 選ぶことはできません。' };
    }

    if (!isFinite(pt) || pt <= 0 || Math.floor(pt) !== pt) {
      return { ok: false, message: '賭けptは1以上の整数で入れてください。' };
    }
    const 初期 = Number(設定値_(ss, '初期持ち点')) || 0;
    const 残高 = 初期 - (使用pt集計_(ss)[team] || 0);
    if (pt > 残高) {
      return { ok: false, message: `残高が足りません（残り ${残高} pt）。` };
    }

    const log = ss.getSheetByName(S.LOG);
    const 本数 = Math.max(0, log.getLastRow() - CFG.FIRST_ROW + 1);
    if (本数 >= CFG.BET_ROWS) {
      return { ok: false, message: '購入本数が上限に達しました。運営に声をかけてください。' };
    }

    const id = Utilities.getUuid().slice(0, 8);
    log.appendRow([
      new Date(), team, ticket,
      picks[0] || '', picks[1] || '', picks[2] || '',
      pt, id,
    ]);
    SpreadsheetApp.flush();   // オッズの再計算を確定させてから状態を読み直す

    return {
      ok: true,
      message: `${ticket} ${picks.join('→')} に ${pt}pt 購入しました。`,
      state: getState(team),
    };
  } finally {
    lock.releaseLock();
  }
}

/** 直前の購入を取り消す（受付中のみ・自分のチームのみ）。押し間違い対策。 */
function cancelBet(team, id) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, message: '混み合っています。' };
  try {
    const ss = ss_();
    if (String(設定値_(ss, '受付状態')) !== '受付中') {
      return { ok: false, message: '受付終了後は取り消せません。運営に相談してください。' };
    }
    const log = ss.getSheetByName(CFG.SHEETS.LOG);
    const n = log.getLastRow() - CFG.FIRST_ROW + 1;
    if (n <= 0) return { ok: false, message: '取り消せる購入がありません。' };

    const rows = log.getRange(CFG.FIRST_ROW, 1, n, 8).getValues();
    for (let i = n - 1; i >= 0; i--) {
      if (String(rows[i][7]) === String(id) &&
          String(rows[i][1]).trim() === String(team).trim()) {
        log.deleteRow(CFG.FIRST_ROW + i);
        SpreadsheetApp.flush();
        return { ok: true, message: '取り消しました。', state: getState(team) };
      }
    }
    return { ok: false, message: '該当の購入が見つかりませんでした。' };
  } finally {
    lock.releaseLock();
  }
}
