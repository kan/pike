// ヘッダ右上のリロードボタン（issue #26、配置は #53 で変更）。Jira のトップナビ右上、
// 「アップグレード」と通知ベルの間にボタンを差し込み、クリックで location.reload() する
// （F5 リロード reload_shortcut.js／システムメニュー「再読み込み」と同じフルロード経路）。
// マウス操作だけで手早くリロードしたい用途向け。基盤 machinery.js の window.JIRAPP
// プラットフォームに registerFeature で登録し、addStyle を共有利用する（状態を持たないので
// store は使わない）。
//
// 設計の要点（実機 DOM を CDP で確認済み）:
//  - 差し込み先: トップナビ右側の二次アクション群は `role="list"`（display:flex, gap:4px）で、
//    子は 順に アップグレード / 通知 / ヘルプ / 設定 / アバター。通知の項目の前へ入れれば
//    タイトルどおり「アップグレードと通知の間」になる。通知の項目は testid を持つトリガを
//    `role="listitem"` が包む形なので、トリガから listitem へ上がって insertBefore する。
//  - 見た目: 隣のアイコンボタンに合わせて 32x32・角丸 6px・アイコン 16px。難読化クラスは
//    複製せず、Atlassian のデザイントークン（`--ds-*`）で組む（クラスは版ごとに変わるが
//    トークンは安定していて、ライト/ダーク両テーマにも追従する）。
//  - 落ちたときの扱い: 差し込み先が見つからなければボタンは出ない。フォールバックで別の場所
//    （旧実装の画面左下など）へ逃がすと、黙って位置が変わって分かりにくい。リロード自体は F5 と
//    システムメニューでもできるので、`expectDom` で申告して selfcheck.js に知らせる側に倒す。
//  - 常駐: React の再描画で取り除かれたり前後を入れ替えられたりしても MutationObserver で
//    差し直す。ナビは深い位置にあり、位置がずれる原因も「他所のノードが挿入されたこと」なので
//    変化の種類では絞り込めない。代わりに `ensureButton` の先頭へ、正しい位置に居るかを
//    getElementById と隣接ノードだけで見る早期脱出を置いて、常駐コストを抑えている。
JIRAPP.registerFeature("reloadButton", function (app) {
  var BTN_ID = "__jirapp-reload-btn";
  var ITEM_ID = "__jirapp-reload-item";
  // 差し込み位置の目印（この項目の直前へ入れる）。
  var T_NOTIF = "atlassian-navigation--secondary-actions--notifications--menu-trigger";

  var sel = app.sel;

  // 円形の更新アイコン（viewBox は 24 のまま。表示サイズは CSS で 16px に縮めて隣に合わせる）。
  var RELOAD_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>';

  // 依存 DOM の申告（selfcheck.js が点検する）。見るのは「ボタンが差し込めたか」＝この機能の
  // 結果そのもの。selfcheck はボード画面のときしか点検せず、そこにトップナビは必ずあるので
  // gate は要らない。gate にトップナビの testid を置くと、その testid が変わったときに申告ごと
  // 飛ばされ、いちばん知らせてほしい場面で無音になる。
  app.expectDom("リロードボタン", null, {
    "ヘッダのボタン": "#" + BTN_ID
  });

  app.addStyle(
    "__jirapp_reload_btn_style__",
    "#" + BTN_ID + "{width:32px;height:32px;display:inline-flex;align-items:center;" +
    "justify-content:center;box-sizing:border-box;border:0;padding:0;border-radius:6px;" +
    "cursor:pointer;background:transparent;color:var(--ds-text-subtle,#505258);" +
    "transition:background .12s;}\n" +
    "#" + BTN_ID + ":hover{background:var(--ds-background-neutral-subtle-hovered,rgba(9,30,66,.06));" +
    "color:var(--ds-text,#172b4d);}\n" +
    "#" + BTN_ID + ":active{background:var(--ds-background-neutral-subtle-pressed,rgba(9,30,66,.14));}\n" +
    "#" + BTN_ID + ":focus-visible{outline:2px solid var(--ds-border-focused,#388bff);outline-offset:2px;}\n" +
    "#" + BTN_ID + " svg{width:16px;height:16px;pointer-events:none;}"
  );

  function createItem() {
    var item = document.createElement("div");
    item.id = ITEM_ID;
    item.setAttribute("role", "listitem");
    var btn = document.createElement("button");
    btn.type = "button";
    btn.id = BTN_ID;
    btn.setAttribute("aria-label", "再読み込み");
    btn.title = "再読み込み";
    btn.innerHTML = RELOAD_SVG;
    btn.addEventListener("click", function (ev) {
      ev.preventDefault();
      location.reload();
    });
    item.appendChild(btn);
    return item;
  }

  // 正しい位置＝自分の次の兄弟が通知の項目であること。ここだけなら getElementById と
  // 小さな部分木への問い合わせで済むので、常駐監視から何度呼ばれても安い。
  function placedCorrectly(item) {
    var next = item && item.nextElementSibling;
    if (!next) return false;
    return next.matches(sel(T_NOTIF)) || !!next.querySelector(sel(T_NOTIF));
  }

  // 作成と位置直しを兼ねる。「アップグレード」は後から非同期で現れ、そのとき React は自分の
  // 管理外である我々のノードを飛ばして挿入するため、先に置いておくと前へ回り込まれてしまう。
  // 毎回「通知の直前にいるか」を見て、ずれていれば入れ直す。
  function ensureButton() {
    var item = document.getElementById(ITEM_ID);
    if (placedCorrectly(item)) return;
    var notif = document.querySelector(sel(T_NOTIF));
    if (!notif) return;
    // 通知の項目＝二次アクション群のリストの直接の子まで遡ったもの。`closest('[role="listitem"]')`
    // だと祖先を無制限に遡るため、Atlassian が通知トリガ直上の listitem を外した構成になったとき、
    // ナビの外側にある別の listitem を掴んでボタンを見当違いの場所へ差してしまう。それだと
    // ボタン自体は DOM に在るのでセルフチェックも気づけない。リストの子に限定して防ぐ。
    var list = notif.closest('[role="list"]');
    if (!list) return;
    var anchor = notif;
    while (anchor.parentElement !== list) anchor = anchor.parentElement;
    list.insertBefore(item || createItem(), anchor);
  }

  // 常駐監視: React の再描画で取り除かれても差し直す。位置がずれる原因は「他所のノードが
  // 挿入されたこと」なので、追加ノードの種類では絞り込めない（＝selectors は渡さない）。
  // その代わり ensureButton は早期脱出込みで安く、自分の差し直しが呼び戻す 1 パスもそこで抜ける。
  ensureButton();
  app.watchDom(ensureButton);
});
