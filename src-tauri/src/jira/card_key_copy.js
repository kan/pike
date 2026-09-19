// チケットキーのコピー機能（issue #22）。カンバンカードのキー "COM-123" の隣に、
// カードホバーで現れる小さなコピーボタンを足し、クリックでキー文字列をクリップボードへ
// コピーする。基盤 machinery.js の window.JIRAPP プラットフォームに registerFeature で登録し、
// addStyle を共有利用する（永続状態は持たないので store は使わない）。
//
// 対象 DOM は 2026-09 のボード刷新（issue #51）で入れ替わった。旧実装が使っていた
// platform-card.common.ui.key.key / software-board.*.card-with-icc の testid は消えている。
//
// 設計の要点（実機 DOM を CDP で確認済み。詳細は開発メモ jira-card-key-copy-dom 参照）:
//  - カード: data-testid="board.content.cell.card"。
//  - キー要素: 刷新後のキーには testid が無い。カード内の /browse/ リンクのうち、表示文字列を
//    持つものがキー（もう 1 本ある同 href のリンクはカード全体を覆う position:absolute の
//    オーバーレイで、テキストを持たない）。実機の全カードでこの条件は 1 本だけに一致した。
//  - 配置: キーの箱（リンクの親 div）は刷新後、キー文字列より広いブロック（実測 175px に対し
//    キーは 52px）になった。旧実装のように position:absolute; left:100% で浮かせると箱の右端＝
//    担当者アバターの裏へ回り込んでしまうため、リンクの直後へインラインで置く。箱は
//    white-space:nowrap にして、ボタンが次行へ落ちないようにする。ボタンは <a> の外なので
//    リンク遷移は誘発しない。
//  - クリップ回避（重要）: キーの箱は Jira 側スタイルで overflow:hidden（刷新後も同じ）。
//    箱に収まりきらない場合にボタンが切り取られるため、`overflow:visible !important` で上書き
//    する（非 important では Jira 側に負けるため !important 必須）。箱には testid も安定クラスも
//    無いので、目印として自前の class を付けて CSS を当てる。
//  - クリックを拾わせる（重要）: 刷新後のカードは中身がまとめて pointer-events:none にされ、
//    クリックはカード全体を覆うオーバーレイの <a> が受ける造りになった。そのままではボタンが
//    ヒットテストに乗らず、押しても「チケットを開く」だけになる。`pointer-events:auto` を
//    ボタンへ明示して復活させる（塗り順ではカード本体がオーバーレイより上なので z-index は不要）。
//  - 表示: 既定 opacity:0。カードの :hover でのみ表示（キーボード focus でも）。
//  - コピー: navigator.clipboard.writeText（secure context で可）。失敗時は textarea + execCommand。
//    クリックはユーザージェスチャなので clipboard API のフォーカス要件を満たす。
//  - 常駐: SPA 再描画でカードが再生成されても MutationObserver で貼り直す。多重付与は
//    箱の中の既存ボタン有無で防ぐ。
JIRAPP.registerFeature("cardKeyCopy", function (app) {
  // カンバン DOM の安定 testid。
  var T_CARD = "board.content.cell.card";
  // キーのリンク（同 href のオーバーレイと区別するため、テキストの有無で絞り込む）。
  var KEY_LINK_SEL = 'a[href^="/browse/"]';
  // キーの箱に付ける自前の目印。
  var WRAP_CLASS = "__jirapp-keywrap";

  var sel = app.sel;

  // 依存 DOM の申告（selfcheck.js が点検する）。カードが 1 枚も無いボードでは判定できないので、
  // カードの存在を gate にする（カードの testid 自体が変わった場合は列側の申告で気づける）。
  // 見るのは「キーのリンクがあるか」ではなく「ボタンが付いたか」＝この機能の結果そのもの。
  // キー文字列が <a> の外へ出るような変更（＝#51 と同種）で keyLink が誰も拾えなくなった場合も
  // ボタンが 0 個になるので、これ 1 つで足りる。
  app.expectDom("チケットキーのコピー", sel(T_CARD), {
    コピーボタン: ".__jirapp-copybtn"
  });

  // アイコン（Atlassian のトークン色に追従。copy = 2枚重ねの矩形 / check = チェックマーク）。
  var COPY_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="9" y="9" width="13" height="13" rx="2"/>' +
    '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  var CHECK_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
    'stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

  app.addStyle(
    "__jirapp_card_copy_style__",
    "." + WRAP_CLASS + "{overflow:visible !important;white-space:nowrap;}\n" +
    ".__jirapp-copybtn{display:inline-flex;vertical-align:middle;pointer-events:auto;" +
    "margin-left:4px;align-items:center;justify-content:center;" +
    "width:18px;height:18px;box-sizing:border-box;border:0;padding:0;background:transparent;" +
    "cursor:pointer;border-radius:3px;opacity:0;transition:opacity .1s;" +
    "color:var(--ds-text-subtle,#626f86);}\n" +
    sel(T_CARD) + ":hover .__jirapp-copybtn{opacity:1;}\n" +
    ".__jirapp-copybtn:focus-visible{opacity:1;outline:2px solid var(--ds-border-focused,#388bff);}\n" +
    ".__jirapp-copybtn:hover{background:var(--ds-background-neutral-hovered,rgba(9,30,66,.08));" +
    "color:var(--ds-text,#172b4d);}\n" +
    ".__jirapp-copybtn.is-copied{color:var(--ds-icon-success,#22a06b);opacity:1;}\n" +
    ".__jirapp-copybtn svg{width:13px;height:13px;pointer-events:none;}"
  );

  function text(el) {
    return el ? (el.textContent || "").trim() : "";
  }

  // カード内のキーのリンク。無ければ null。
  // 表示文字列が href 末尾のキーと一致するものだけを採る。「テキストの有無」だけで選ぶと、
  // オーバーレイ側に読み上げ用の非表示文言（"COM-123 …を読み込むには Enter キー…"）が入って
  // いるときにそちらを掴み、カード全体の箱にレイアウト用の CSS を当ててしまう。
  function keyLink(card) {
    var links = card.querySelectorAll(KEY_LINK_SEL);
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute("href") || "";
      var key = href.slice(href.lastIndexOf("/") + 1);
      if (key && text(links[i]) === key) return links[i];
    }
    return null;
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      ta.remove();
    } catch {}
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () {
        fallbackCopy(text);
      });
    }
    fallbackCopy(text);
    return Promise.resolve();
  }

  // コピー成功の一時フィードバック（チェックマークへ変えて約1.2秒後に戻す）。
  function flash(btn) {
    btn.classList.add("is-copied");
    btn.innerHTML = CHECK_SVG;
    clearTimeout(btn.__jirappTimer);
    btn.__jirappTimer = setTimeout(function () {
      btn.classList.remove("is-copied");
      btn.innerHTML = COPY_SVG;
    }, 1200);
  }

  function addButton(card) {
    var link = keyLink(card);
    if (!link) return;
    var wrap = link.parentElement;
    if (!wrap || wrap.querySelector(".__jirapp-copybtn")) return;
    var initial = text(link);
    wrap.classList.add(WRAP_CLASS);
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "__jirapp-copybtn";
    btn.setAttribute("aria-label", "チケットキーをコピー");
    btn.title = "キーをコピー: " + initial;
    btn.innerHTML = COPY_SVG;
    btn.addEventListener(
      "click",
      function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        // カード再利用で文字列が変わりうるので、クリック時に最新のキーを読む。
        var key = text(keyLink(card));
        if (!key) return;
        Promise.resolve(copyText(key)).then(function () {
          flash(btn);
        });
      },
      true
    );
    // 押下がカードのドラッグ開始やクリック（詳細を開く）に伝播しないようにする。
    btn.addEventListener("pointerdown", function (ev) {
      ev.stopPropagation();
    }, true);
    btn.addEventListener("mousedown", function (ev) {
      ev.stopPropagation();
    }, true);
    wrap.appendChild(btn);
  }

  function addAll() {
    var cards = document.querySelectorAll(sel(T_CARD));
    for (var i = 0; i < cards.length; i++) addButton(cards[i]);
  }

  // 常駐監視: addAll は全カードを走査するので、カードの追加・再描画があったときだけ呼ぶ。
  addAll();
  app.watchDom(addAll, [sel(T_CARD)]);
});
