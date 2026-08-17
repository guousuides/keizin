/**
 * ============================================================
 *  夏合宿 競馬企画 — スプレッドシート構築
 * ============================================================
 *  メニュー「🏇 競馬企画」→「① セットアップ（シートを作り直す）」
 *  で全シート・全数式・入力規則を生成します。
 *
 *  計算はすべて「シート上の数式」として置いてあります。
 *  スクリプトの中で数字をこねているわけではないので、
 *  セルをクリックすれば何をしているか必ず読めます。
 * ============================================================
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🏇 競馬企画')
    .addItem('① セットアップ（シートを作り直す）', 'セットアップ')
    .addSeparator()
    .addItem('▶ 受付を開始する', '受付開始')
    .addItem('⏹ 受付を締め切る', '受付締切')
    .addSeparator()
    .addItem('🔗 WebアプリのURLを表示', 'URL表示')
    .addItem('🔄 次のレース用にリセット（購入ログと結果を消す）', '次のレース準備')
    .addToUi();
}

/* ============================================================
 *  メイン：セットアップ
 * ============================================================ */
function セットアップ() {
  const ss = SpreadsheetApp.getActive();
  PropertiesService.getScriptProperties().setProperty('SS_ID', ss.getId());

  // 既に入力済みの「人が手で入れた値」を退避しておき、作り直したあとに書き戻す。
  // これで何回セットアップを流しても、馬名やチーム名や購入ログが消えない。
  const keep = 退避する_(ss);

  設定シート_(ss);
  出走馬シート_(ss);
  チームシート_(ss);
  購入ログシート_(ss);
  オッズシート_(ss);
  結果シート_(ss);
  精算シート_(ss);
  解説シート_(ss);

  名前付き範囲_(ss);
  入力規則_(ss);   // 名前付き範囲を作ってから入力規則を張る
  シート順_(ss);

  書き戻す_(ss, keep);

  SpreadsheetApp.getUi().alert(
    'セットアップ完了',
    '次の順で進めてください。\n\n' +
    '1.「出走馬」シートに代表者6人の名前を入れる\n' +
    '2.「チーム」シートに10チームの名前を入れる\n' +
    '3.「設定」シートで持ち点や係数を確認する\n' +
    '4. メニュー →「受付を開始する」\n' +
    '5. メニュー →「WebアプリのURLを表示」でURLを配る\n' +
    '6. レース直前にメニュー →「受付を締め切る」\n' +
    '7.「結果」シートに1〜3着を入れると「精算」と「チーム」が自動で埋まる',
    SpreadsheetApp.getUi().ButtonSet.OK);
}

/* ============================================================
 *  各シートの構築
 * ============================================================ */

/** 設定シート — 当日いじるパラメータを1か所に集める。 */
function 設定シート_(ss) {
  const sh = 作り直す_(ss, CFG.SHEETS.SETTING);
  見出し_(sh, '⚙ 設定',
    'この企画のつまみ。B列の値だけ触ってください。ここを変えると全シートの計算が一斉に変わります。');

  sh.getRange('A3:C3').setValues([['項目', '値', '意味・どこで使うか']]);

  const rows = [
    ['複勝係数 a', 1 / 3,
     '複勝の賭け金を「その馬に賭けられた金額 A_i」に算入するときの掛け率。払戻にも同じ a を掛ける。' +
     '3着以内に入る確率はだいたい単勝確率の3倍なので、a=1/3 にすると複勝の期待払戻がちょうど100%になる。'],
    ['控除率', 0,
     '胴元（書道会）の取り分。0.1 なら賭け金の10%を差し引いてからオッズを出す。0なら全額還元。' +
     'オッズが全体的に甘いと感じたらここを上げる。'],
    ['オッズ下限', 1.1,
     '計算上どんなに人気でも、最低これだけの倍率は付ける。JRAでいう元返し防止。'],
    ['オッズ上限', 999,
     '誰も賭けていない馬でオッズが発散する（0で割る）のを防ぐ天井。'],
    ['三連単係数', 1,
     '三連単の払戻に最後に掛ける調整倍率。1のままだと期待払戻が約180%（＝胴元が持ち出し）になる。' +
     '「解説」シートの§4を読んでから決めること。'],
    ['三連複係数', 1,
     '同上（三連複）。'],
    ['初期持ち点', 1000,
     '各チームに配る持ち点。Webアプリはこの範囲でしか買えないよう弾く。'],
    ['受付状態', '受付中',
     '「締切」にするとWebアプリからの購入が即座に止まる。メニューからも切り替えられる。'],
    ['丸め単位', 1,
     '払戻ptの丸め単位。5にすると5pt刻みで切り上げる（春合宿版は5だった）。'],
    ['三連系方式', TRIFECTA_MODES.SIMPLE,
     '三連単・三連複のオッズの出し方。「単純積」は O_i×O_j×O_k をそのまま使う（もらった式どおり）。' +
     '「Harville補正」は着順が絡む分の確率をきちんと織り込んで期待払戻が100%になるようにした版。'],
    ['レース名', '第1レース',
     'Webアプリの見出しに出る名前。'],
  ];
  sh.getRange(4, 1, rows.length, 3).setValues(rows);

  sh.getRange('B4').setNumberFormat('0.000000');
  sh.getRange('B5').setNumberFormat('0.00%');
  sh.getRange('B6:B7').setNumberFormat('0.0');

  sh.getRange('B4').setNote(
    'a = 1/3 の根拠：\n' +
    '複勝の期待払戻 = 賭け金 × a × O_i × P(3着以内)\n' +
    'P(3着以内) ≒ 3 × p_i、O_i = 1/p_i なので\n' +
    '= 賭け金 × a × 3。a = 1/3 で 100% 還元になる。');

  整える_(sh, [140, 110, 620], 3);
  sh.getRange('A3:C3').setFontWeight('bold').setBackground('#e8eaed');
  sh.getRange('C4:C' + (3 + rows.length)).setWrap(true).setFontSize(9).setFontColor('#5f6368');
  sh.getRange('B4:B' + (3 + rows.length)).setBackground('#fff8e1');
}

/** 出走馬シート — 代表者6人。 */
function 出走馬シート_(ss) {
  const sh = 作り直す_(ss, CFG.SHEETS.HORSE);
  見出し_(sh, '🐴 出走馬',
    '代表者6人の名前。Webアプリの選択肢も、オッズ計算も、全部ここを読みます。同姓同名は不可（区別できないため）。');

  sh.getRange('A3:C3').setValues([['馬番', '名前', 'ひとこと（Webアプリに表示・任意）']]);
  const nums = [];
  for (let i = 1; i <= CFG.HORSE_COUNT; i++) nums.push([i]);
  sh.getRange(CFG.FIRST_ROW, 1, CFG.HORSE_COUNT, 1).setValues(nums);

  const last = CFG.FIRST_ROW + CFG.HORSE_COUNT - 1;
  sh.getRange(CFG.FIRST_ROW, 2, CFG.HORSE_COUNT, 2).setBackground('#fff8e1');
  整える_(sh, [60, 160, 320], last);
  sh.getRange('A3:C3').setFontWeight('bold').setBackground('#e8eaed');
}

/** チームシート — 10チームの持ち点と収支。 */
function チームシート_(ss) {
  const sh = 作り直す_(ss, CFG.SHEETS.TEAM);
  見出し_(sh, '👥 チーム',
    'A列のチーム名だけ手入力。C列より右はすべて自動計算です。');

  sh.getRange('A3:G3').setValues([[
    'チーム名', '初期持ち点', '使用pt', '払戻pt', '収支', '残高', '順位']]);

  const first = CFG.FIRST_ROW;
  const last = first + CFG.TEAM_COUNT - 1;
  const f = [];
  for (let r = first; r <= last; r++) {
    f.push([
      `=初期持ち点`,
      // 購入ログのうち自分のチームの賭けPtを全部足す
      `=SUMIF(購入ログ!$B:$B,$A${r},購入ログ!$G:$G)`,
      // 精算シートのうち自分のチームの払戻ptを全部足す
      `=SUMIF(精算!$B:$B,$A${r},精算!$J:$J)`,
      `=$D${r}-$C${r}`,
      `=$B${r}+$E${r}`,
      `=IF($A${r}="","",IF(COUNTBLANK(結果上位3)>0,"",RANK($F${r},$F$${first}:$F$${last})))`,
    ]);
  }
  sh.getRange(first, 2, CFG.TEAM_COUNT, 6).setFormulas(f);

  sh.getRange(first, 1, CFG.TEAM_COUNT, 1).setBackground('#fff8e1');
  sh.getRange(first, 2, CFG.TEAM_COUNT, 5).setNumberFormat('#,##0');
  sh.getRange('C3').setNote('そのチームが賭けた合計。Webアプリはこれを見て「残高を超える購入」を弾いています。');
  sh.getRange('E3').setNote('収支 = 払戻pt − 使用pt。プラスなら勝ち。');

  整える_(sh, [140, 90, 90, 90, 90, 90, 60], last);
  sh.getRange('A3:G3').setFontWeight('bold').setBackground('#e8eaed');
}

/** 購入ログ — Webアプリが1行ずつ追記していく、唯一の生データ。 */
function 購入ログシート_(ss) {
  const sh = 作り直す_(ss, CFG.SHEETS.LOG);
  見出し_(sh, '🧾 購入ログ',
    'Webアプリからの購入がここに1行ずつ積まれます。★このシートは手で編集しないこと★ ' +
    'オッズも精算も全部ここを集計して作られているので、1行いじると全部ずれます。取り消したい行は行ごと削除してください。');

  sh.getRange('A3:H3').setValues([[
    '受付時刻', 'チーム', '券種', '1着指名', '2着指名', '3着指名', '賭けPt', '受付ID']]);
  sh.getRange('A3:H3').setFontWeight('bold').setBackground('#e8eaed');
  sh.getRange('A:A').setNumberFormat('yyyy/MM/dd HH:mm:ss');
  sh.getRange('G:G').setNumberFormat('#,##0');
  sh.setFrozenRows(3);
  整える_(sh, [150, 120, 70, 110, 110, 110, 80, 130], 3);
}

/**
 * オッズシート — 企画の心臓部。
 * 画像の「＜オッズの算出＞」をそのまま列に分解している。
 */
function オッズシート_(ss) {
  const sh = 作り直す_(ss, CFG.SHEETS.ODDS);
  見出し_(sh, '📊 オッズ',
    '購入ログを集計して各馬の A_i と オッズ O_i を出します。C〜F列が「どの券種からいくら流れ込んだか」の内訳です。全部自動。');

  sh.getRange('A3:K3').setValues([[
    '馬番', '名前',
    '単勝から', '複勝から(×a)', '三連単から', '三連複から',
    '合計 A_i', '素オッズ O_i', '単勝オッズ', '複勝オッズ', '想定勝率 p_i']]);

  const first = CFG.FIRST_ROW;
  const last = first + CFG.HORSE_COUNT - 1;
  const totalRow = last + 2;   // 賭け金の総額 T を置く行

  const L = '購入ログ';
  const f = [];
  for (let r = first; r <= last; r++) {
    const hr = r;  // 出走馬シートも同じ行番号に揃えてある
    f.push([
      `=出走馬!A${hr}`,
      `=出走馬!B${hr}`,
      // 単勝 → そのまま A_i へ
      `=SUMIFS(${L}!$G:$G,${L}!$C:$C,"単勝",${L}!$D:$D,$B${r})`,
      // 複勝 → a を掛けて A_i へ
      `=複勝係数*SUMIFS(${L}!$G:$G,${L}!$C:$C,"複勝",${L}!$D:$D,$B${r})`,
      // 三連単 → 1着指名に1/2、2着指名に1/3、3着指名に1/6
      `=1/2*SUMIFS(${L}!$G:$G,${L}!$C:$C,"三連単",${L}!$D:$D,$B${r})` +
      `+1/3*SUMIFS(${L}!$G:$G,${L}!$C:$C,"三連単",${L}!$E:$E,$B${r})` +
      `+1/6*SUMIFS(${L}!$G:$G,${L}!$C:$C,"三連単",${L}!$F:$F,$B${r})`,
      // 三連複 → 指名した3頭に1/3ずつ（順序は関係ないのでどの列に居ても同じ扱い）
      `=1/3*(SUMIFS(${L}!$G:$G,${L}!$C:$C,"三連複",${L}!$D:$D,$B${r})` +
      `+SUMIFS(${L}!$G:$G,${L}!$C:$C,"三連複",${L}!$E:$E,$B${r})` +
      `+SUMIFS(${L}!$G:$G,${L}!$C:$C,"三連複",${L}!$F:$F,$B${r}))`,
      // A_i
      `=SUM(C${r}:F${r})`,
      // 素オッズ O_i = T / A_i （上限だけ効かせる。下限は券種ごとに効かせる）
      `=IF($G${r}=0,"",MIN(オッズ上限,$G$${totalRow}/$G${r}))`,
      // 単勝オッズ
      `=IF($H${r}="","―",MEDIAN(オッズ下限,$H${r},オッズ上限))`,
      // 複勝オッズ = a × O_i （払戻が 賭け金 × a × O_i なので、表示上はこれが実効倍率）
      `=IF($H${r}="","―",MEDIAN(オッズ下限,$H${r}*複勝係数,オッズ上限))`,
      // 想定勝率 p_i = A_i / ΣA_i
      `=IFERROR($G${r}/SUM($G$${first}:$G$${last}),"")`,
    ]);
  }
  sh.getRange(first, 1, CFG.HORSE_COUNT, 11).setFormulas(f);

  // 合計行
  sh.getRange(totalRow, 5).setValue('賭け金の総額 T ＝');
  sh.getRange(totalRow, 7).setFormula(
    `=SUM(G${first}:G${last})*(1-控除率)`);
  sh.getRange(totalRow + 1, 5).setValue('控除前の合計 ΣA_i ＝');
  sh.getRange(totalRow + 1, 7).setFormula(`=SUM(G${first}:G${last})`);
  sh.getRange(totalRow, 5, 2, 1).setHorizontalAlignment('right').setFontWeight('bold');
  sh.getRange(totalRow, 7, 2, 1).setNumberFormat('#,##0.0').setFontWeight('bold');

  sh.getRange(totalRow + 3, 1).setValue(
    '【なぜ ΣA_i がそのまま総額になるのか】' +
    '単勝は 1、三連単は 1/2+1/3+1/6 = 1、三連複は 1/3×3 = 1、複勝だけ a。' +
    'つまり配分しても金額は増えも減りもしません。だから Σ(1/O_i) = ΣA_i / T = 1 となり、' +
    'p_i = 1/O_i がそのまま「その馬が1着になる想定確率」として使えます。');
  sh.getRange(totalRow + 3, 1, 1, 8).merge()
    .setWrap(true).setFontSize(9).setFontColor('#5f6368').setBackground('#f1f3f4');

  sh.getRange('C3').setNote('画像の「単勝 → そのまま A_i へ」。');
  sh.getRange('D3').setNote('画像の「複勝 → a(<1) を掛けて A_i へ」。a は設定シートの複勝係数。');
  sh.getRange('E3').setNote('画像の「三連単 → 1位の馬に賭け金の1/2、2位に1/3、3位に1/6」。合計すると1になる。');
  sh.getRange('F3').setNote('画像の「三連複 → 3頭へ1/3ずつ」。');
  sh.getRange('H3').setNote('O_i = 賭け金の総額 T ÷ A_i。これが全ての払戻の土台。');
  sh.getRange('J3').setNote('複勝の払戻は 賭け金 × a × O_i。表示している倍率もそれに合わせて a を掛けてある。');
  sh.getRange('K3').setNote('p_i = A_i / ΣA_i = 1/O_i。6頭ぶん足すとちょうど1になる。');

  sh.getRange(first, 3, CFG.HORSE_COUNT, 5).setNumberFormat('#,##0.0');
  sh.getRange(first, 8, CFG.HORSE_COUNT, 3).setNumberFormat('0.00');
  sh.getRange(first, 11, CFG.HORSE_COUNT, 1).setNumberFormat('0.0%');
  sh.getRange(first, 9, CFG.HORSE_COUNT, 2).setBackground('#e6f4ea').setFontWeight('bold');

  整える_(sh, [50, 130, 90, 110, 100, 100, 90, 90, 90, 90, 90], totalRow + 3);
  sh.getRange('A3:K3').setFontWeight('bold').setBackground('#e8eaed');
}

/** 結果シート — レース後に着順を入れる。 */
function 結果シート_(ss) {
  const sh = 作り直す_(ss, CFG.SHEETS.RESULT);
  見出し_(sh, '🏁 結果',
    'レースが終わったらここに1〜3着を入れてください。3つ埋まった瞬間に精算とチーム順位が動きます。');

  sh.getRange('A3:B3').setValues([['着順', '名前']]);
  sh.getRange('A4:A6').setValues([['1着'], ['2着'], ['3着']]);
  sh.getRange('B4:B6').setBackground('#fff8e1');

  sh.getRange('A8').setValue(
    '4着以下は払戻に一切関係しないので入力欄を用意していません。' +
    '入力途中（1〜3着のどれかが空欄）のあいだは、精算シートの判定は空欄のまま止まります。');
  sh.getRange('A8:D8').merge().setWrap(true).setFontSize(9).setFontColor('#5f6368');

  整える_(sh, [70, 160, 100, 200], 8);
  sh.getRange('A3:B3').setFontWeight('bold').setBackground('#e8eaed');
}

/** 精算シート — 購入ログ1行につき1行、的中判定と払戻。 */
function 精算シート_(ss) {
  const sh = 作り直す_(ss, CFG.SHEETS.PAYOUT);
  見出し_(sh, '💰 精算',
    'A〜G列は購入ログの写しです。H〜J列が結果、K〜P列はその計算過程（見たい人向け）。全部自動なので触らないでください。');

  sh.getRange('A3:P3').setValues([[
    '受付時刻', 'チーム', '券種', '1着指名', '2着指名', '3着指名', '賭けPt',
    '適用オッズ', '的中', '払戻pt',
    'p1', 'p2', 'p3', 'O_i×O_j×O_k', '三連単(補正)', '三連複(補正)']]);

  const first = CFG.FIRST_ROW;
  const last = first + CFG.BET_ROWS - 1;

  // A〜G列は1本の ARRAYFORMULA で購入ログをそのまま写す
  sh.getRange(first, 1).setFormula(
    `=ARRAYFORMULA(IF(購入ログ!A${first}:G${last}="","",購入ログ!A${first}:G${last}))`);
  sh.getRange(first, 1).setNote(
    'この1つの数式でA〜G列すべてを購入ログから写しています。' +
    '行が増えても自動で追随するので、下にコピーする必要はありません。');

  const HV = TRIFECTA_MODES.HARVILLE;
  const f = [];
  for (let r = first; r <= last; r++) {
    f.push([
      /* H 適用オッズ */
      `=IF($C${r}="","",IFERROR(MEDIAN(オッズ下限,IFS(` +
        `$C${r}="単勝",VLOOKUP($D${r},オッズ表,8,FALSE),` +
        `$C${r}="複勝",VLOOKUP($D${r},オッズ表,9,FALSE),` +
        `$C${r}="三連単",三連単係数*IF(三連系方式="${HV}",$O${r},$N${r}),` +
        `$C${r}="三連複",三連複係数*IF(三連系方式="${HV}",$P${r},$N${r}/6)` +
      `),オッズ上限),"―"))`,

      /* I 的中判定 */
      `=IF($C${r}="","",IF(COUNTBLANK(結果上位3)>0,"",IFS(` +
        `$C${r}="単勝",IF($D${r}=結果1着,"的中","不的中"),` +
        `$C${r}="複勝",IF(COUNTIF(結果上位3,$D${r})>0,"的中","不的中"),` +
        `$C${r}="三連単",IF(AND($D${r}=結果1着,$E${r}=結果2着,$F${r}=結果3着),"的中","不的中"),` +
        `$C${r}="三連複",IF(AND(COUNTIF(結果上位3,$D${r})>0,COUNTIF(結果上位3,$E${r})>0,COUNTIF(結果上位3,$F${r})>0),"的中","不的中")` +
      `)))`,

      /* J 払戻pt */
      `=IF($I${r}="","",IF($I${r}="的中",CEILING($G${r}*$H${r},丸め単位),0))`,

      /* K p1 = 1/O(1着指名) */
      `=IF($D${r}="","",IFERROR(1/VLOOKUP($D${r},オッズ表,7,FALSE),""))`,
      /* L p2 */
      `=IF($E${r}="","",IFERROR(1/VLOOKUP($E${r},オッズ表,7,FALSE),""))`,
      /* M p3 */
      `=IF($F${r}="","",IFERROR(1/VLOOKUP($F${r},オッズ表,7,FALSE),""))`,

      /* N 単純積 O_i×O_j×O_k */
      `=IF(OR($K${r}="",$L${r}="",$M${r}=""),"",IFERROR(1/($K${r}*$L${r}*$M${r}),""))`,

      /* O 三連単 Harville補正 = 単純積 ×(1-p1)(1-p1-p2) */
      `=IF($N${r}="","",IFERROR($N${r}*(1-$K${r})*(1-$K${r}-$L${r}),""))`,

      /* P 三連複 Harville補正 = 1 / (3頭の並べ替え6通りの確率の和) */
      `=IF($N${r}="","",IFERROR(1/(` +
        `$K${r}*($L${r}/(1-$K${r}))*($M${r}/(1-$K${r}-$L${r}))+` +
        `$K${r}*($M${r}/(1-$K${r}))*($L${r}/(1-$K${r}-$M${r}))+` +
        `$L${r}*($K${r}/(1-$L${r}))*($M${r}/(1-$K${r}-$L${r}))+` +
        `$L${r}*($M${r}/(1-$L${r}))*($K${r}/(1-$L${r}-$M${r}))+` +
        `$M${r}*($K${r}/(1-$M${r}))*($L${r}/(1-$M${r}-$K${r}))+` +
        `$M${r}*($L${r}/(1-$M${r}))*($K${r}/(1-$M${r}-$L${r}))` +
      `),""))`,
    ]);
  }
  sh.getRange(first, 8, CFG.BET_ROWS, 9).setFormulas(f);

  sh.getRange('H3').setNote(
    '券種ごとに使う倍率を選んでいます。\n' +
    '単勝 → オッズシートの単勝オッズ\n' +
    '複勝 → オッズシートの複勝オッズ（＝a×O_i）\n' +
    '三連単 → O_i×O_j×O_k\n' +
    '三連複 → O_i×O_j×O_k ÷ 6\n' +
    '最後に MEDIAN(下限, 値, 上限) で下限1.1〜上限999に押し込んでいます。');
  sh.getRange('I3').setNote(
    '単勝＝1着が一致。複勝＝3着以内に居る。三連単＝3頭が順番どおり。' +
    '三連複＝3頭が順不同で全員3着以内。\n' +
    '結果シートが1つでも空欄なら空欄のままにします（フライング判定の防止）。');
  sh.getRange('N3').setNote('もらった式のとおりの単純積。三連複はこれを6で割る。');
  sh.getRange('O3').setNote(
    '「1着がi、次にj、次にk」の確率を p_i × p_j/(1-p_i) × p_k/(1-p_i-p_j) と見て逆数を取った版。' +
    '設定シートの三連系方式を「Harville補正」にすると、H列がこちらを使います。');

  // ARRAYFORMULAで写した受付時刻は素の数値として来るので、日時として表示させる
  sh.getRange(first, 1, CFG.BET_ROWS, 1).setNumberFormat('yyyy/MM/dd HH:mm:ss');
  sh.getRange(first, 7, CFG.BET_ROWS, 1).setNumberFormat('#,##0');
  sh.getRange(first, 8, CFG.BET_ROWS, 1).setNumberFormat('0.00');
  sh.getRange(first, 10, CFG.BET_ROWS, 1).setNumberFormat('#,##0');
  sh.getRange(first, 11, CFG.BET_ROWS, 3).setNumberFormat('0.000');
  sh.getRange(first, 14, CFG.BET_ROWS, 3).setNumberFormat('0.00');
  sh.getRange(first, 11, CFG.BET_ROWS, 6).setFontColor('#9aa0a6').setFontSize(9);
  sh.getRange(first, 10, CFG.BET_ROWS, 1).setBackground('#e6f4ea').setFontWeight('bold');

  // 的中行を緑、不的中行をグレーに
  const rule的中 = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied(`=$I${first}="的中"`)
    .setBackground('#ceead6')
    .setRanges([sh.getRange(first, 1, CFG.BET_ROWS, 10)]).build();
  const rule不 = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied(`=$I${first}="不的中"`)
    .setFontColor('#9aa0a6')
    .setRanges([sh.getRange(first, 1, CFG.BET_ROWS, 10)]).build();
  sh.setConditionalFormatRules([rule的中, rule不]);

  sh.setFrozenRows(3);
  sh.setFrozenColumns(3);
  整える_(sh, [140, 110, 65, 100, 100, 100, 70, 80, 60, 80, 55, 55, 55, 95, 90, 90], 3);
  sh.getRange('A3:P3').setFontWeight('bold').setBackground('#e8eaed');
}

/** 解説シート — 「なんか分からんけど動く」を避けるための読み物。 */
function 解説シート_(ss) {
  const sh = 作り直す_(ss, CFG.SHEETS.DOC);
  見出し_(sh, '📖 解説', 'この企画の計算が何をやっているかの説明。困ったらここを読んでください。');

  const t = [
['§1  全体の流れ', ''],
['', '① Webアプリで各チームが馬券を買う → 「購入ログ」に1行ずつ溜まる'],
['', '② 「オッズ」シートが購入ログを集計して A_i と O_i を出す（賭けが入るたびリアルタイムに動く）'],
['', '③ レース直前にメニューから受付を締め切る → オッズが確定'],
['', '④ レース後に「結果」シートへ1〜3着を入力'],
['', '⑤ 「精算」が全購入の的中/払戻を計算 → 「チーム」に収支と順位が出る'],
['', ''],
['§2  A_i（その馬に賭けられた金額）の作り方', ''],
['', '単勝でXに m pt   → A_X に m'],
['', '複勝でXに m pt   → A_X に a×m         （a は設定シート、既定 1/3）'],
['', '三連単 X→Y→Z m pt → A_X に m/2、A_Y に m/3、A_Z に m/6'],
['', '三連複 X,Y,Z m pt → A_X, A_Y, A_Z に m/3 ずつ'],
['', ''],
['', '配分の重みが 1/2+1/3+1/6 = 1、1/3×3 = 1 と必ず1になるように出来ているので、'],
['', '「賭け金の総額 T」＝「ΣA_i」がぴったり一致します（複勝だけ a 倍された額で入る）。'],
['', ''],
['§3  オッズ', ''],
['', 'O_i = T / A_i'],
['', ''],
['', 'このとき p_i := 1/O_i = A_i/ΣA_i となり、6頭ぶん足すとちょうど1。'],
['', 'つまり p_i を「その馬が1着になる想定確率」としてそのまま扱えます。これが後の三連系の計算の土台。'],
['', ''],
['', '払戻'],
['', '  単勝   = 賭け金 × O_i'],
['', '  複勝   = 賭け金 × a × O_i'],
['', '  三連単 = 賭け金 × O_i × O_j × O_k'],
['', '  三連複 = 賭け金 × O_i × O_j × O_k ÷ 6'],
['', ''],
['', '複勝で a を掛ける理由：3着以内に入る確率はおおよそ 3×p_i。'],
['', '期待払戻 = 賭け金 × a × O_i × 3p_i = 賭け金 × 3a。a = 1/3 でちょうど100%還元。よく出来ています。'],
['', ''],
['§4  ★注意★ 三連単・三連複は期待払戻が約180%になります', ''],
['', '6頭が完全に横一線（p = 1/6）のとき、'],
['', '  三連単の的中確率 = 3!/6! = 1/120  なのに 払戻倍率 = 6×6×6 = 216倍'],
['', '  三連複の的中確率 = 3!3!/6! = 1/20 なのに 払戻倍率 = 216÷6 = 36倍'],
['', '  → どちらも 期待払戻 = 216/120 = 36/20 = 1.8 倍'],
['', ''],
['', 'つまり三連系を買えば買うほど、統計的には書道会が持ち出しになります。'],
['', '人気馬で固めた三連単だとさらに開きます（p=0.4,0.3,… だと期待払戻5倍超）。'],
['', ''],
['', '原因：O_i×O_j×O_k = 1/(p_i p_j p_k) は「3回とも独立に引き直す」計算になっていて、'],
['', '実際は1着に決まった馬は2着になれない（＝残りの母数が減る）ぶんを織り込めていないためです。'],
['', ''],
['', '対処は3つ。好きなものを選んでください。'],
['', '  (a) 何もしない。派手な配当が出て盛り上がるので、企画としてはこれもアリ。'],
['', '  (b) 設定シートの「三連単係数」「三連複係数」を 0.5〜0.6 くらいに下げる。手っ取り早い。'],
['', '  (c) 設定シートの「三連系方式」を「Harville補正」にする。'],
['', '      1着 p_i → 2着 p_j/(1-p_i) → 3着 p_k/(1-p_i-p_j) と正しく条件付けした確率の逆数を使うので、'],
['', '      期待払戻がちょうど100%になります。精算シートのO列・P列で計算済みです。'],
['', ''],
['§4b 複勝は「穴馬買い」が得になります（仕様として理解しておくところ）', ''],
['', 'a=1/3 で期待払戻100%になるのは「6頭が横一線（p=1/6）」のときちょうど、です。'],
['', '人気が偏ると次のようにズレます（数値は Harville で厳密計算したもの）。'],
['', ''],
['', '     p_i      3着以内率     複勝の期待払戻'],
['', '    0.167      50.0%           100%    ← 横一線'],
['', '    0.357      81.8%            76%    ← 本命'],
['', '    0.500      91.7%            61%    ← 大本命'],
['', '    0.100      41.7%           139%    ← 穴'],
['', '    0.040      40.1%           334%    ← 大穴'],
['', ''],
['', '理由：3着以内率は最大でも100%で頭打ちなのに、a×O_i は p が小さいほど青天井に伸びるためです。'],
['', 'つまり「人気薄の複勝を買う」のが数学的には一番おいしい。'],
['', '企画としてはむしろ面白い（大穴に賭ける動機ができる）ので、そのままで良いと思います。'],
['', '気になるなら控除率を上げるか、複勝だけ別に係数を持たせてください。'],
['', ''],
['§5  春合宿版から直したところ', ''],
['', '・三連複の6通りの並べ替えのうち1項目の分母が (1-H-G) ではなく (1-G-F) になっていた'],
['', '  → 春合宿の実データ(p=0.475,0.425,0.175)で検算すると三連複オッズが約15%低く出ていた'],
['', '・三連複の第1項で除算 / が乗算 * になっていた箇所が3つ（J25/M25/P25）'],
['', '・オッズが事前の「ポイント」固定だったのを、実際の賭け金から動くようにした'],
['', '・参加者ごとに12枚あったシートを、購入ログ1枚＋精算1枚に集約した'],
  ];
  sh.getRange(3, 1, t.length, 2).setValues(t);
  sh.getRange(3, 1, t.length, 1).setFontWeight('bold').setFontColor('#1a73e8');
  整える_(sh, [340, 700], t.length + 3);
  sh.getRange(3, 2, t.length, 1).setWrap(false);
}

/* ============================================================
 *  名前付き範囲・入力規則・並び順
 * ============================================================ */

function 名前付き範囲_(ss) {
  const set = (name, a1) => {
    try { ss.removeNamedRange(name); } catch (e) { /* 無ければ何もしない */ }
    ss.setNamedRange(name, ss.getRange(a1));
  };
  const S = CFG.SHEETS;
  Object.keys(SETTING_ROWS).forEach(k => set(k, `${S.SETTING}!$B$${SETTING_ROWS[k]}`));

  const hFirst = CFG.FIRST_ROW, hLast = CFG.FIRST_ROW + CFG.HORSE_COUNT - 1;
  const tLast = CFG.FIRST_ROW + CFG.TEAM_COUNT - 1;

  set('馬名リスト',   `${S.HORSE}!$B$${hFirst}:$B$${hLast}`);
  set('チーム名リスト', `${S.TEAM}!$A$${CFG.FIRST_ROW}:$A$${tLast}`);
  // VLOOKUP用：1列目=名前, 7列目=素オッズ, 8列目=単勝オッズ, 9列目=複勝オッズ
  set('オッズ表',     `${S.ODDS}!$B$${hFirst}:$J$${hLast}`);
  set('結果1着',      `${S.RESULT}!$B$4`);
  set('結果2着',      `${S.RESULT}!$B$5`);
  set('結果3着',      `${S.RESULT}!$B$6`);
  set('結果上位3',    `${S.RESULT}!$B$4:$B$6`);
}

function 入力規則_(ss) {
  const S = CFG.SHEETS;
  const horses = ss.getRange('馬名リスト');

  const dvHorse = SpreadsheetApp.newDataValidation()
    .requireValueInRange(horses, true).setAllowInvalid(false)
    .setHelpText('出走馬シートに載っている名前から選んでください。').build();
  ss.getSheetByName(S.RESULT).getRange('B4:B6').setDataValidation(dvHorse);

  const dv受付 = SpreadsheetApp.newDataValidation()
    .requireValueInList(['受付中', '締切'], true).setAllowInvalid(false).build();
  ss.getSheetByName(S.SETTING).getRange(SETTING_ROWS.受付状態, 2).setDataValidation(dv受付);

  const dv方式 = SpreadsheetApp.newDataValidation()
    .requireValueInList([TRIFECTA_MODES.SIMPLE, TRIFECTA_MODES.HARVILLE], true)
    .setAllowInvalid(false)
    .setHelpText('「解説」シートの§4を読んでから選んでください。').build();
  ss.getSheetByName(S.SETTING).getRange(SETTING_ROWS.三連系方式, 2).setDataValidation(dv方式);
}

function シート順_(ss) {
  const order = [CFG.SHEETS.ODDS, CFG.SHEETS.TEAM, CFG.SHEETS.RESULT,
                 CFG.SHEETS.HORSE, CFG.SHEETS.SETTING, CFG.SHEETS.LOG,
                 CFG.SHEETS.PAYOUT, CFG.SHEETS.DOC];
  order.forEach((n, i) => {
    const sh = ss.getSheetByName(n);
    if (sh) { ss.setActiveSheet(sh); ss.moveActiveSheet(i + 1); }
  });
  ss.setActiveSheet(ss.getSheetByName(CFG.SHEETS.ODDS));
}

/* ============================================================
 *  メニューから呼ぶ操作
 * ============================================================ */

function 受付開始() { 受付状態を切替_('受付中', '受付を開始しました。Webアプリから購入できます。'); }
function 受付締切() { 受付状態を切替_('締切', '受付を締め切りました。この時点のオッズが確定です。'); }

function 受付状態を切替_(v, msg) {
  SpreadsheetApp.getActive().getSheetByName(CFG.SHEETS.SETTING)
    .getRange(SETTING_ROWS.受付状態, 2).setValue(v);
  SpreadsheetApp.getActive().toast(msg, '🏇 競馬企画', 5);
}

function URL表示() {
  const ui = SpreadsheetApp.getUi();
  let url = '';
  try { url = ScriptApp.getService().getUrl(); } catch (e) { /* 未デプロイ */ }
  ui.alert('WebアプリのURL',
    url ? url + '\n\nこれを参加者に配ってください。' :
      'まだデプロイされていません。\n\nApps Scriptエディタ →「デプロイ」→「新しいデプロイ」→\n' +
      '種類「ウェブアプリ」／実行するユーザー「自分」／アクセスできるユーザー「全員」\n' +
      'で作成すると、ここにURLが出ます。',
    ui.ButtonSet.OK);
}

function 次のレース準備() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.alert('次のレース用にリセット',
    '購入ログと結果を消去します。設定・出走馬・チーム名は残ります。\n\n' +
    '※ 前のレースの記録を残したいなら、先にファイルごとコピーしてください（1レース1ファイル推奨）。\n\n' +
    '実行しますか？', ui.ButtonSet.YES_NO);
  if (res !== ui.Button.YES) return;

  const ss = SpreadsheetApp.getActive();
  const log = ss.getSheetByName(CFG.SHEETS.LOG);
  const n = log.getLastRow() - (CFG.FIRST_ROW - 1);
  if (n > 0) log.getRange(CFG.FIRST_ROW, 1, n, 8).clearContent();
  ss.getSheetByName(CFG.SHEETS.RESULT).getRange('B4:B6').clearContent();
  受付状態を切替_('受付中', 'リセットしました。受付中です。');
}

/* ============================================================
 *  小道具
 * ============================================================ */

function 作り直す_(ss, name) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  sh.clear();
  sh.clearNotes();
  sh.setConditionalFormatRules([]);
  const maxR = sh.getMaxRows(), maxC = sh.getMaxColumns();
  sh.getRange(1, 1, maxR, maxC).setDataValidation(null).breakApart();
  sh.setFrozenRows(0);
  sh.setFrozenColumns(0);
  return sh;
}

function 見出し_(sh, title, sub) {
  sh.getRange('A1').setValue(title)
    .setFontSize(14).setFontWeight('bold');
  sh.getRange('A2').setValue(sub)
    .setFontSize(9).setFontColor('#5f6368').setWrap(true);
  sh.getRange('A2:H2').merge();
  sh.setRowHeight(2, 32);
}

function 整える_(sh, widths, lastRow) {
  widths.forEach((w, i) => sh.setColumnWidth(i + 1, w));
  // 見出しで A2:H2 を結合しているので、8列より狭くは削らない（結合を壊さないため）
  const keep = Math.max(widths.length, 8);
  const maxC = sh.getMaxColumns();
  if (maxC > keep) sh.deleteColumns(keep + 1, maxC - keep);
  sh.setHiddenGridlines(false);
}

/** セットアップを流し直しても手入力が消えないよう、先に読み出しておく。 */
function 退避する_(ss) {
  const g = (name, a1) => {
    const sh = ss.getSheetByName(name);
    if (!sh) return null;
    try { return sh.getRange(a1).getValues(); } catch (e) { return null; }
  };
  const log = ss.getSheetByName(CFG.SHEETS.LOG);
  let logData = null;
  if (log && log.getLastRow() >= CFG.FIRST_ROW) {
    logData = log.getRange(CFG.FIRST_ROW, 1,
      log.getLastRow() - CFG.FIRST_ROW + 1, 8).getValues();
  }
  return {
    horses:  g(CFG.SHEETS.HORSE, `B${CFG.FIRST_ROW}:C${CFG.FIRST_ROW + CFG.HORSE_COUNT - 1}`),
    teams:   g(CFG.SHEETS.TEAM,  `A${CFG.FIRST_ROW}:A${CFG.FIRST_ROW + CFG.TEAM_COUNT - 1}`),
    setting: g(CFG.SHEETS.SETTING, 'B4:B14'),
    result:  g(CFG.SHEETS.RESULT, 'B4:B6'),
    log:     logData,
  };
}

function 書き戻す_(ss, keep) {
  if (!keep) return;
  if (keep.setting) ss.getSheetByName(CFG.SHEETS.SETTING).getRange('B4:B14').setValues(keep.setting);
  if (keep.horses) {
    ss.getSheetByName(CFG.SHEETS.HORSE)
      .getRange(CFG.FIRST_ROW, 2, keep.horses.length, 2).setValues(keep.horses);
  }
  if (keep.teams) {
    ss.getSheetByName(CFG.SHEETS.TEAM)
      .getRange(CFG.FIRST_ROW, 1, keep.teams.length, 1).setValues(keep.teams);
  }
  if (keep.result) ss.getSheetByName(CFG.SHEETS.RESULT).getRange('B4:B6').setValues(keep.result);
  if (keep.log) {
    ss.getSheetByName(CFG.SHEETS.LOG)
      .getRange(CFG.FIRST_ROW, 1, keep.log.length, 8).setValues(keep.log);
  }
}
