// 列ヘッダ着色機能（issue #21）。カンバン列ヘッダの背景色をステータス名ごとに変更し、
// 列の ⋯（その他の操作）メニューに「色の変更」を追加する。基盤 machinery.js の
// window.JIRAPP プラットフォームに登録し、store / addStyle を共有利用する。
//
// 対象 DOM は 2026-09 のボード刷新（issue #51）で入れ替わった。旧実装が拠り所にしていた
// platform-board-kit.* / software-board.* の testid は消え、board.content.* 系になっている。
//
// 設計の要点（いずれも実機検証済み。詳細は開発メモ jira-column-color-dom 参照）:
//  - 着色方式: 刷新後の列ヘッダ自身は背景が透明で、グレーは列セル（board.content.cell）が
//    持つ。ヘッダへ色を敷けばセルのグレーの上に載るので、セル側は触らない。注入 <style> の
//    `[data-jirapp-col="<hue>"]{...}` と header への `data-jirapp-col` 属性で着色し、クリアは
//    属性を外すだけで既定の見た目へ戻す。将来ヘッダ側に背景が復活しても勝てるよう
//    `!important` は残す。
//  - 列の識別: 位置（nth-child）は並べ替え・増減で崩れるため、安定した data-testid を辿り、
//    ステータス名をキーにする。列名の要素は件数バッジを含まないので textContent をそのまま使える。
//  - ⋯ トリガ: 刷新後は testid が無い。ヘッダ内の `button[aria-haspopup="true"]` が
//    ⋯（その他のアクション）で、aria-label は locale 依存なので使わない。
//  - 列メニューの同定: トリガを押すと `aria-controls="ds--dropdown--…"` が付き、その id の
//    要素の中に `[role="menu"]` が描画される。この対応で「今開いたのが押した列のメニューか」を
//    locale にも testid にも依存せず判定でき、カード側の ⋯ メニューへの誤爆も防げる。
//  - 永続化: JIRAPP.store（iframe 経由 native localStorage）に名前→hue マップを保存する。
//    Jira ウィンドウは IPC を持たず設定ストアへは書けないため、この WebView 内保存を用いる。
//  - 常駐: SPA 遷移や再描画で属性が失われても MutationObserver で貼り直す。マップはメモリに
//    キャッシュし、保存時のみ更新する（再適用のたびに localStorage を読み直さない）。
JIRAPP.registerFeature("columnColor", function (app) {
  var STORE_KEY = "jirapp.columnColors.v1";

  // Jira の accent パレット名（hue）と日本語ラベル。--ds-background-accent-<hue>-subtlest に対応。
  var HUES = [
    ["gray", "グレー"], ["red", "レッド"], ["orange", "オレンジ"], ["yellow", "イエロー"],
    ["lime", "ライム"], ["green", "グリーン"], ["teal", "ティール"], ["blue", "ブルー"],
    ["purple", "パープル"], ["magenta", "マゼンタ"]
  ];

  // カンバン DOM の安定 testid。
  var T_CELL = "board.content.cell";
  var T_HDR = "board.content.cell.column-header";
  var T_NAME = "board.content.cell.column-header.name";
  // ⋯ トリガ（testid が無いので aria 属性で拾う）。
  var TRIG_SEL = 'button[aria-haspopup="true"]';

  var sel = app.sel;

  // 依存 DOM の申告（selfcheck.js が点検する）。ボードには必ず列があるので gate は要らず、
  // ここが 0 件になったら Jira 側の作りが変わったということ。
  app.expectDom("列ヘッダの着色", null, {
    列セル: sel(T_CELL),
    列ヘッダ: sel(T_HDR),
    列名: sel(T_NAME),
    "列メニューの ⋯": sel(T_HDR) + " " + TRIG_SEL
  });

  // 名前→hue マップはメモリに保持し、保存時のみ更新する（再適用ごとの読み直しを避ける）。
  var map = app.store.get(STORE_KEY, {}) || {};
  function save() {
    app.store.set(STORE_KEY, map);
  }

  // 着色スタイルシートを一度だけ用意する（hue ごとの !important ルール）。
  var css = "";
  HUES.forEach(function (h) {
    css += sel(T_HDR) + '[data-jirapp-col="' + h[0] + '"]' +
      "{background-color:var(--ds-background-accent-" + h[0] + "-subtlest)!important;}\n";
  });
  app.addStyle("__jirapp_col_style__", css);

  function columnName(cell) {
    var n = cell.querySelector(sel(T_NAME));
    return n ? (n.textContent || "").trim() : "";
  }

  // 保存済みマップに従い、全列のヘッダへ属性を反映する。
  function applyAll() {
    var cells = document.querySelectorAll(sel(T_CELL));
    for (var i = 0; i < cells.length; i++) {
      var hdr = cells[i].querySelector(sel(T_HDR));
      if (!hdr) continue;
      var hue = map[columnName(cells[i])];
      if (hue) hdr.setAttribute("data-jirapp-col", hue);
      else hdr.removeAttribute("data-jirapp-col");
    }
  }

  // ⋯ のクリックを起点に、その列のメニューが描画されるのを待って項目を足す。
  // メニューは空のコンテナが先に挿入され中身が後から入るため、MutationObserver では
  // 「[role=menu] を含むノードの追加」を取り逃がす。押したトリガから辿るこの形なら確実で、
  // 対象列（＝名前）とメニューの対応も取り違えない。
  document.addEventListener("click", function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest(TRIG_SEL) : null;
    if (!t || !t.closest(sel(T_HDR))) return;
    var cell = t.closest(sel(T_CELL));
    waitForMenu(t, cell ? columnName(cell) : "");
  }, true);

  // 注入したら終わり、にはしない。メニューは段階的に描画されるので、1 件目を見た時点で足した
  // 項目が後続のレンダリングで消えることがある。開いているあいだポーリングを続け、消えていれば
  // 貼り直す（injectMenuItem は冪等）。
  function waitForMenu(trigger, name) {
    var tries = 0;
    (function poll() {
      if (tries++ > 40) return; // 約 2 秒で打ち切る（閉じる操作だったときもここで抜ける）
      var id = trigger.getAttribute("aria-expanded") === "true"
        ? trigger.getAttribute("aria-controls")
        : null;
      var dd = id ? document.getElementById(id) : null;
      var menu = dd ? dd.querySelector('[role="menu"]') : null;
      if (menu && menu.querySelector('[role="menuitem"]')) {
        injectMenuItem(menu, trigger, name);
      }
      setTimeout(poll, 50);
    })();
  }

  // --- 自前パレットのポップアップ ---
  function closePalette() {
    var p = document.getElementById("__jirapp_col_pop__");
    if (p) p.remove();
    document.removeEventListener("mousedown", onOutside, true);
  }
  function onOutside(ev) {
    var p = document.getElementById("__jirapp_col_pop__");
    if (p && !p.contains(ev.target)) closePalette();
  }
  function openPalette(anchor, name) {
    closePalette();
    if (!name) return;
    var pop = document.createElement("div");
    pop.id = "__jirapp_col_pop__";
    pop.style.cssText =
      "position:fixed;z-index:2147483647;background:var(--ds-surface-overlay,#fff);" +
      "border:1px solid var(--ds-border,rgba(9,30,66,.14));border-radius:6px;" +
      "box-shadow:0 4px 12px rgba(9,30,66,.25);padding:8px;width:184px;box-sizing:border-box;" +
      "display:flex;flex-wrap:wrap;gap:6px;";
    var r = anchor.getBoundingClientRect();
    pop.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 190)) + "px";
    pop.style.top = Math.min(r.bottom + 4, window.innerHeight - 120) + "px";

    HUES.forEach(function (h) {
      var sw = document.createElement("button");
      sw.type = "button";
      sw.title = h[1];
      sw.style.cssText =
        "width:28px;height:28px;border-radius:4px;cursor:pointer;padding:0;border:2px solid " +
        (map[name] === h[0] ? "var(--ds-border-selected,#0c66e4)" : "transparent") +
        ";background-color:var(--ds-background-accent-" + h[0] + "-subtlest);";
      sw.addEventListener("click", function () {
        map[name] = h[0];
        save();
        applyAll();
        closePalette();
      });
      pop.appendChild(sw);
    });

    var clr = document.createElement("button");
    clr.type = "button";
    clr.textContent = "クリア（色なし）";
    clr.style.cssText =
      "width:100%;margin-top:2px;padding:6px;cursor:pointer;font-size:12px;" +
      "border:1px solid var(--ds-border,rgba(9,30,66,.14));border-radius:4px;background:transparent;" +
      "color:var(--ds-text,#172b4d);";
    clr.addEventListener("click", function () {
      delete map[name];
      save();
      applyAll();
      closePalette();
    });
    pop.appendChild(clr);

    document.body.appendChild(pop);
    // 直後の同一クリックで即閉じないよう、リスナ登録は次サイクルへ回す。
    setTimeout(function () {
      document.addEventListener("mousedown", onOutside, true);
    }, 0);
  }

  // --- 列メニューへ「色の変更」項目を注入 ---
  // menu は押した ⋯ の aria-controls 配下から取ったものなので、カードの ⋯ など別メニューへの
  // 誤爆は起きない。既定項目は 3 つとも同じクラスで、破壊的操作だけ見た目が違うといったことは
  // ないため、複製元は先頭の項目でよい。
  function injectMenuItem(menu, anchor, name) {
    if (menu.querySelector("[data-jirapp-menuitem]")) return;
    var tmpl = menu.querySelector('[role="menuitem"]');
    if (!tmpl) return;

    var mi = tmpl.cloneNode(true); // クローンは React の fiber 外なので既定項目のハンドラは発火しない。
    mi.setAttribute("data-jirapp-menuitem", "1");
    mi.removeAttribute("data-testid");
    // id を引き継ぐと DOM に同じ id が 2 つ並ぶ。Atlaskit のメニューはキーボード操作を
    // aria-activedescendant ＋ id で行うので、複製側へ矢印キーで移ったときに参照がずれる。
    mi.removeAttribute("id");
    // 表示ラベルだけ差し替える（アイコン等の構造は保つ）。
    var title = mi.querySelector("[data-item-title]");
    if (title) title.textContent = "色の変更";
    else mi.textContent = "色の変更";
    mi.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      openPalette(anchor, name);
      // Jira の列メニューを閉じる（パレットは body 直下の自前要素なので影響を受けない）。
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }, true);
    tmpl.parentNode.appendChild(mi);
  }

  // --- 常駐監視 ---
  // applyAll は全列を走査するので、「列に関係する変化」があったときだけ呼ぶよう絞る
  // （無関係な SPA 変化で全列再走査しない）。
  applyAll();
  app.watchDom(applyAll, [sel(T_CELL), sel(T_HDR)]);
});
