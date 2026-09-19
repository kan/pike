// 列のスクロールバーを控えめにする（issue #52）。Jira のカンバンは列ごとに縦スクロールする
// ようになったが、OS 既定の太いスクロールバー（幅 15px・矢印ボタン付き・濃いグレー）が常時
// 出ていて主張が強い。細くしたうえで、通常はつまみを透明にし、その列にマウスが乗っている
// あいだだけ見せる。基盤 machinery.js の window.JIRAPP に registerFeature で登録する。
//
// 設計の要点（実機で確かめた）:
//  - 幅は常に 8px で固定し、ホバーで変えるのは**つまみの色だけ**にする。幅を出し入れすると
//    その分だけ中身の幅が変わり、ホバーのたびにカードが横にずれる。場所は取り続けるが、
//    既定の 15px より狭いので、見た目も詰まらず内容の幅も広がる。
//  - **`:hover` では切り替わらない**: Chromium は `::-webkit-scrollbar-*` の指定を hover の
//    状態変化では計算し直さない。`列:hover 領域::-webkit-scrollbar-thumb{...}` と書いても
//    塗りは変わらないままだった（`scrollbar-color` を hover で切り替える標準プロパティ版も同じ。
//    計算値は変わるのに描画が追従しない）。**属性の付け外しなら計算し直される**ので、
//    JS で `data-jirapp-sb` を付け外しし、CSS はその属性で分岐する。
//  - 付け外しは document 1 つの委譲で行う。列は React が作り直すので、個々の列へ
//    mouseenter を張ると付け直しの世話が要る。`mouseover` は移動のたびに上がってくるが、
//    対象が変わったときだけ属性を触るので実質的な仕事はしない。
JIRAPP.registerFeature("columnScrollbar", function (app) {
  var sel = app.sel;
  var T_CELL = "board.content.cell";
  var T_SCROLL = "board.content.cell.scroll-container";
  // ホバー中の列の縦スクロール領域に付ける目印。
  var ATTR = "data-jirapp-sb";

  // 依存 DOM の申告（selfcheck.js が点検する）。ボードには必ず列とその縦スクロール領域がある。
  // 見るのは「列セルの子孫にスクロール領域がある」という関係そのもの。どちらか片方の testid の
  // 有無だけを見ると、入れ子が変わって `cell.querySelector` が空振りするようになっても気づけない。
  app.expectDom("列のスクロールバー", null, {
    "列内のスクロール領域": sel(T_CELL) + " " + sel(T_SCROLL)
  });

  app.addStyle(
    "__jirapp_col_scrollbar_style__",
    // height も指定する。width だけだと、その列に横スクロールが出たときに既定の 15px を
    // 占有したままつまみだけが透明になり、スクロールできることが分からなくなる。
    sel(T_SCROLL) + "::-webkit-scrollbar{width:8px;height:8px;}\n" +
    sel(T_SCROLL) + "::-webkit-scrollbar-track{background:transparent;}\n" +
    sel(T_SCROLL) + "::-webkit-scrollbar-thumb{background:transparent;border-radius:4px;}\n" +
    sel(T_SCROLL) + "[" + ATTR + "]::-webkit-scrollbar-thumb" +
    "{background:var(--ds-border-bold,#8590a2);}\n" +
    sel(T_SCROLL) + "[" + ATTR + "]::-webkit-scrollbar-thumb:hover" +
    "{background:var(--ds-text-subtle,#505258);}"
  );

  // マウスが乗っている列の領域だけに目印を付ける。
  var markedCell = null;
  var marked = null;
  // 引き直しても同じ結果なら何もしない。比較するのは列セルではなくスクロール領域そのもので、
  // 「同じ列だが領域のノードは作り替えられた」を取りこぼさないようにする。
  function mark(cell) {
    markedCell = cell;
    var next = cell ? cell.querySelector(sel(T_SCROLL)) : null;
    if (next === marked) return;
    if (marked) marked.removeAttribute(ATTR);
    marked = next;
    if (next) next.setAttribute(ATTR, "1");
  }

  document.addEventListener("mouseover", function (ev) {
    // mouseover は高頻度で、しかもこのリスナは SPA 遷移後も生き続ける。列が無い画面で
    // closest を最後まで歩かせても無駄なので、先に URL で足切りする。
    if (!app.onBoard()) return;
    var target = ev.target;
    if (!target || !target.closest) return;
    // mouseover は要素をまたぐたびに上がってくる。同じ列の中を動いていて、かつ目印が
    // 生きているあいだは、closest も querySelector も回さずに抜ける。
    // 目印が付けられていない（列セルはあるがスクロール領域がまだ無い瞬間に当たった）場合や、
    // React がスクロール領域のノードだけ作り替えた場合は、ここを通して引き直させる。
    // この機能には watchDom の貼り直しが無いので、取りこぼすと同じ列に居るあいだ直らない。
    if (marked && marked.isConnected && markedCell.contains(target)) return;
    mark(target.closest(sel(T_CELL)));
  }, true);

  // ウィンドウの外へ抜けたときは mouseover が上がってこないので、出しっぱなしを防ぐ。
  // relatedTarget が無いのが「文書の外へ出た」の合図。mouseleave を capture で拾うと、
  // 要素をまたぐたびに（バブルしないはずのものまで）降ってきて消灯してしまう。
  document.addEventListener("mouseout", function (ev) {
    if (!ev.relatedTarget) mark(null);
  }, true);
});
