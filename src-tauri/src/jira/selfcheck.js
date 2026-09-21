// 注入機能の DOM 追従セルフチェック（issue #51）。各機能が JIRAPP.expectDom で申告した
// セレクタを点検し、当たらなくなっていたら画面隅の通知と console.warn で知らせる。
//
// なぜアプリ内でやるのか（CI での定期チェックを見送った理由）:
//  - ボードの DOM は認証後の SPA でしか得られない。CI から取るには実ブラウザで Jira Cloud へ
//    ログインする必要があり、Atlassian の認証情報を CI シークレットへ置くことになる
//    （REST API のトークンでは画面の DOM は取れない）。
//  - Atlassian の UI 変更はテナント単位で段階配信される。検証用の別テナントで見張っても、
//    自分のテナントがいつ切り替わるかは分からない。
//  そこで「実際に使っているテナントを、実際に使っている本人の画面で」点検する形にした。
//  黙って壊れるのを防ぐのが目的なので、直せることまでは狙わない。
//
// 設計の要点:
//  - 誤報を出さないことを優先する。仕掛けは 3 つ。
//     (1) ボード**本体**の URL のときだけ点検する（`JIRAPP.onBoard`）。`/boards/<id>` の
//         配下には backlog や timeline といった列を持たない画面がぶら下がっており、
//         `/boards/` を含むかで判定すると、そちらを開いているあいだ列の申告が全滅して
//         誤報になる。
//     (2) 描画が終わるだけの猶予（GRACE_MS）を置いてから判定を始める。
//     (3) 猶予後も、連続 STRIKES 回欠けたときだけ通知する。1 回のスナップショットで確定すると、
//         列のドラッグ中の一瞬の入れ替わりや描画の遅れを恒久的な誤報にしてしまう。
//    gate セレクタが 0 件の申告は「対象外」として飛ばす（カードが 1 枚も無いボードで
//    キー関連を追従切れと誤判定しないため）。
//  - 通知は 1 回だけ。閉じたらそのページでは二度と出さない（リロードすれば再び点検される）。
JIRAPP.registerFeature("selfCheck", function (app) {
  var GRACE_MS = 30000; // ボードを開いてからこれだけ待って初めて判定を始める
  var POLL_MS = 1000;
  var STRIKES = 10; // 連続でこの回数欠けたら追従切れとみなす
  var BANNER_ID = "__jirapp-selfcheck";


  // 追従できていない機能の一覧を「機能名（欠けた要素・...）」の形で返す。
  function missing() {
    var out = [];
    var list = app.domExpectations();
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (e.gate && !document.querySelector(e.gate)) continue;
      var lost = [];
      for (var k in e.selectors) {
        if (!document.querySelector(e.selectors[k])) lost.push(k);
      }
      if (lost.length) out.push(e.label + "（" + lost.join("・") + "）");
    }
    return out;
  }

  app.addStyle(
    "__jirapp_selfcheck_style__",
    "#" + BANNER_ID + "{position:fixed;left:16px;bottom:16px;z-index:2147483000;max-width:380px;" +
    "box-sizing:border-box;padding:10px 12px;border-radius:6px;font-size:12px;line-height:1.5;" +
    "border:1px solid var(--ds-border-warning,#e2b203);color:var(--ds-text,#172b4d);" +
    "background:var(--ds-background-warning,#fff7d6);" +
    "box-shadow:var(--ds-shadow-overlay,0 1px 4px rgba(9,30,66,.25));}\n" +
    "#" + BANNER_ID + " ul{margin:6px 0 0;padding-left:18px;}\n" +
    "#" + BANNER_ID + " button{margin-top:8px;padding:3px 10px;cursor:pointer;font-size:12px;" +
    "border:1px solid var(--ds-border,rgba(9,30,66,.14));border-radius:4px;background:transparent;" +
    "color:inherit;}"
  );

  function showBanner(lost) {
    if (document.getElementById(BANNER_ID)) return;
    var box = document.createElement("div");
    box.id = BANNER_ID;
    var head = document.createElement("div");
    head.textContent = "Pike: Jira の画面構成が変わったようです。次の機能が効いていません。";
    box.appendChild(head);
    var ul = document.createElement("ul");
    for (var i = 0; i < lost.length; i++) {
      var li = document.createElement("li");
      li.textContent = lost[i];
      ul.appendChild(li);
    }
    box.appendChild(ul);
    var close = document.createElement("button");
    close.type = "button";
    close.textContent = "閉じる";
    close.addEventListener("click", function () {
      box.remove();
    });
    box.appendChild(close);
    document.body.appendChild(box);
  }

  var boardSince = 0;
  var strikes = 0;
  var timer = setInterval(function () {
    if (!app.onBoard()) {
      boardSince = 0;
      strikes = 0;
      return;
    }
    if (!boardSince) boardSince = Date.now();
    if (Date.now() - boardSince < GRACE_MS) return;
    var lost = missing();
    if (!lost.length) {
      strikes = 0;
      return;
    }
    if (++strikes < STRIKES) return;
    clearInterval(timer);
    console.warn("[Pike] jira: Jira の DOM に追従できていない可能性: " + lost.join(" / "));
    showBanner(lost);
  }, POLL_MS);
});
