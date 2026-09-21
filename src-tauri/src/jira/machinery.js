// 基盤 JS ＝ 注入機能の共通プラットフォーム。
//
// jirapp（Jira 専用ブラウザ）の inject/machinery.js を Pike に写したもの（Pike #380）。
// **正本はこちら**（写した元は jirapp の 1296b15）。Pike のブラウザのタブで `*.atlassian.net` を
// 開いたときに、`src-tauri/src/site_rules.rs` の `jira_scripts` が document-start で差し込む。
// jirapp との違い:
//   - 設定は Rust から流し込まない（`__JIRAPP_APPLY__` を呼ぶ者が居ない）。自動リロードは既定で有効
//   - ページが隠れているあいだ（Pike が子 webview を隠す＝別のタブを見ている・ダイアログを開いている）
//     はアイドル判定をしない。表に戻ったとき、隠れていた時間が閾値を超えていたらリロードする
//
// Jira ウィンドウへ document-start でネイティブ注入する（initialization_script）。
// CSP の影響を受けにくく、各フルロードのたびに他のページスクリプトより先に走る。
//
// 役割:
//   - アイドル検知＋アイドル時の自動リロード
//   - ユーザー CSS 適用と、Rust からの設定反映（window.__JIRAPP_APPLY__）
//   - 各注入機能が乗る土台 window.JIRAPP を用意する:
//       JIRAPP.registerFeature(name, fn) … 機能を一度だけ登録し DOM 準備後に fn(JIRAPP) 実行
//       JIRAPP.store.get/set(key, ...)   … native localStorage（iframe 経由）による永続化
//       JIRAPP.addStyle(id, css)         … id 付き <style> の作成/更新
//       JIRAPP.onConfig(cb)              … Rust から届く設定（customCss 等）の購読
//       JIRAPP.expectDom(label, gate, m) … 依存している Jira 側 DOM の申告（selfcheck.js が点検）
//       JIRAPP.sel(testid)               … data-testid のセレクタ生成
//       JIRAPP.onBoard()                 … 今ボード本体を開いているか
//       JIRAPP.watchDom(fn, selectors)   … SPA 再描画に追従するための常駐監視
//
// 注意（SPA）: initialization_script はフルナビゲーション時のみ再実行され、クライアント側の
// ルート遷移では走らない。遷移に追従したい処理は各機能側で MutationObserver / setInterval で
// 常駐させ、多重実行は登録ガードで防ぐこと。
(function () {
  if (window.__JIRAPP_INSTALLED__) return;
  // document-start 注入は子フレームでも走る。JIRAPP.store が native localStorage を得るために
  // 作る about:blank の隠し iframe もその一つで、そこで機能を組み立てると store がまた iframe を
  // 作り、際限なく入れ子になって RangeError: Maximum call stack size exceeded で落ちる
  // （最上位の動作自体は catch されて続くが、リロードのたびに例外が積まれていた）。注入機能は
  // どれも最上位の Jira 文書だけが対象なので、子フレームでは何もしない。ただし後続の
  // inject/*.js は読み込み時に JIRAPP を呼ぶので、何もしないスタブだけは置いておく。機能の
  // コードは `registerFeature` のコールバック内に置く決まりなので、子フレームで実際に呼ばれる
  // のは `registerFeature` だけ。残りは、その決まりを破ったときに静かに落ちないための保険。
  if (window.top !== window.self) {
    var noop = function () {};
    window.JIRAPP = {
      registerFeature: noop,
      addStyle: noop,
      onConfig: noop,
      expectDom: noop,
      domExpectations: function () { return []; },
      sel: function (testid) { return '[data-testid="' + testid + '"]'; },
      onBoard: function () { return false; },
      watchDom: noop,
      store: { get: function (_key, fallback) { return fallback; }, set: noop }
    };
    return;
  }
  window.__JIRAPP_INSTALLED__ = true;

  // 既定設定。jirapp では Rust 側の __JIRAPP_APPLY__ 呼び出しで上書きされたが、Pike は流し込まない
  // ので、この値がそのまま使われる（jirapp の既定値と同じ。自動リロードは有効）。
  window.__JIRAPP_CONFIG__ = window.__JIRAPP_CONFIG__ || {
    autoReloadEnabled: true,
    idleThresholdSecs: 300,
    reloadCheckIntervalSecs: 30,
    customCss: ""
  };

  // ============================================================
  //  window.JIRAPP — 注入機能の共通プラットフォーム
  // ============================================================
  var installed = {};       // 機能名 -> true（多重登録防止）
  var configListeners = []; // onConfig 購読者
  var expectations = [];    // expectDom で申告された「依存している DOM」
  var DEBOUNCE_MS = 50;     // watchDom が DOM の変化をまとめる幅
  var BOARD_PATH = /\/boards\/[^/]+(\/board)?\/?$/; // onBoard の判定（ボード本体だけを真とする）

  // --- native localStorage（about:blank iframe 経由）---
  // top の window.localStorage は Atlassian のライブラリがメモリシムに差し替えるため、
  // 直書きは再読込で蒸発する。同一オリジンの hidden iframe から native ストアへ読み書きすれば
  // 永続化する（Atlassian 自身も早期に捕まえた native 参照へ書いている）。
  var lsFrame = null;
  function nativeLS() {
    try {
      if (lsFrame && lsFrame.contentWindow) return lsFrame.contentWindow.localStorage;
      var f = document.createElement("iframe");
      f.setAttribute("aria-hidden", "true");
      f.style.display = "none";
      (document.body || document.documentElement).appendChild(f);
      lsFrame = f;
      return f.contentWindow.localStorage;
    } catch {
      return null;
    }
  }

  var JIRAPP = {
    // 永続ストア（JSON 値）。get は未保存なら fallback を返す。
    store: {
      get: function (key, fallback) {
        try {
          var ls = nativeLS();
          if (!ls) return fallback;
          var raw = ls.getItem(key);
          return raw == null ? fallback : JSON.parse(raw);
        } catch {
          return fallback;
        }
      },
      set: function (key, val) {
        try {
          var ls = nativeLS();
          if (ls) ls.setItem(key, JSON.stringify(val));
        } catch {}
      }
    },

    // id 付き <style> を作成/更新する。css が null/undefined なら内容は変えず要素だけ返す。
    addStyle: function (id, css) {
      var el = document.getElementById(id);
      if (!el) {
        el = document.createElement("style");
        el.id = id;
        (document.head || document.documentElement).appendChild(el);
      }
      if (css != null) el.textContent = css;
      return el;
    },

    // Rust から届く設定（__JIRAPP_CONFIG__）を購読する。登録時に現在値で即コールバック。
    onConfig: function (cb) {
      configListeners.push(cb);
      try {
        cb(window.__JIRAPP_CONFIG__);
      } catch {}
    },

    // 機能が依存している Jira 側の DOM を申告する。selfcheck.js がまとめて点検し、
    // Jira の画面刷新で当たらなくなったら知らせる（issue #51 の再発検知）。
    //   label     … 機能の表示名
    //   gate      … これが 1 件も無いなら「まだ描画されていない／対象外」とみなし点検しない
    //                （null なら常に点検する）
    //   selectors … 説明 -> セレクタ。gate を満たすのに 0 件なら追従切れとみなす。
    //                Jira 側の要素だけでなく、機能が付けた目印を見てもよい（付いたかを直接見る）
    expectDom: function (label, gate, selectors) {
      expectations.push({ label: label, gate: gate, selectors: selectors });
    },
    domExpectations: function () {
      return expectations;
    },

    // data-testid のセレクタを組む。Jira の DOM を辿る取っ掛かりは基本これ。
    sel: function (testid) {
      return '[data-testid="' + testid + '"]';
    },

    // 今ボード本体を開いているか。`/boards/<id>` の配下には backlog や timeline といった
    // 列を持たない画面がぶら下がっているので、`/boards/` を含むかでは判定できない。
    // カンバン前提の機能は、これで安く足切りしてから DOM を辿ること。
    onBoard: function () {
      return BOARD_PATH.test(location.pathname);
    },

    // SPA 再描画に追従するための常駐監視。fn を DOM の落ち着き（DEBOUNCE_MS）でまとめて呼ぶ。
    // initialization_script はフルナビゲーションでしか再実行されないので、各機能はこれで
    // 貼り直しを常駐させる（fn は何度呼ばれてもよい＝冪等に書くこと）。
    //   selectors … 与えると、そのどれかに当たるノードが追加されたときだけ fn を呼ぶ。
    //               fn が全走査するなら必ず絞ること。省略すると全変化で呼ばれる。
    watchDom: function (fn, selectors) {
      var pending = false;
      function schedule() {
        if (pending) return;
        pending = true;
        setTimeout(function () {
          pending = false;
          fn();
        }, DEBOUNCE_MS);
      }
      var mo = new MutationObserver(!selectors ? schedule : function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var added = muts[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var node = added[j];
            if (!node || node.nodeType !== 1 || !node.matches) continue;
            for (var k = 0; k < selectors.length; k++) {
              if (node.matches(selectors[k]) || node.querySelector(selectors[k])) {
                schedule();
                return;
              }
            }
          }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
      return mo;
    },

    // 機能を一度だけ登録し、DOM 準備後に fn(JIRAPP) を実行する。
    registerFeature: function (name, fn) {
      if (installed[name]) return;
      installed[name] = true;
      function run() {
        try {
          fn(JIRAPP);
        } catch (e) {
          console.error("[Pike] jira feature '" + name + "' error", e);
        }
      }
      if (document.body) run();
      else document.addEventListener("DOMContentLoaded", run);
    }
  };
  // **識別子の `jirapp` は写した元の名前のまま残す**（Pike #380）。画面とコンソールに出る
  // 文言だけを `Pike` に直した。名前を揃えたくなったときのために、残す理由を書いておく:
  //   - `jirapp.columnColors.v1`（store のキー）… 変えると**利用者が付けた列の色が消える**。
  //     移行を書くだけの値でもないので、名前のために消す理由が無い
  //   - `data-jirapp-col` / `data-jirapp-sb`（属性）と `__jirapp-*`（要素の id）… JS と CSS の
  //     両方が同じ綴りを読むので、片方だけ直すと黙って効かなくなる
  //   - `window.JIRAPP` / `__JIRAPP_CONFIG__` … ページの JS から見える名前。Jira の画面に
  //     居座る以上、他所とぶつからない珍しい綴りであることのほうが価値がある
  window.JIRAPP = JIRAPP;

  // ============================================================
  //  基盤機能: アイドル検知・自動リロード・ユーザー CSS 適用
  // ============================================================

  // --- アイドル検知: 最後のユーザー操作時刻を記録 ---
  var lastActivity = Date.now();
  function touch() {
    lastActivity = Date.now();
  }
  ["mousemove", "mousedown", "keydown", "scroll", "wheel", "touchstart"].forEach(function (ev) {
    window.addEventListener(ev, touch, { passive: true, capture: true });
  });

  // --- 編集中の判定 ---
  // チケットの説明・コメント欄などに入力中でも問答無用でリロードすると編集内容が消える。
  // フォーカスが入力系要素にある間はアイドル計測をリセットし続け、フォーカスを外してから
  // 改めて閾値ぶん放置されるまでリロードしない（外した直後の即リロードも防ぐ）。
  var NON_TEXT_INPUT = /^(button|submit|reset|checkbox|radio|file|image|range|color)$/;
  function isEditing() {
    var el = document.activeElement;
    // shadow DOM 内のフォーカスは外からは host 要素にしか見えないので辿る
    while (el && el.shadowRoot && el.shadowRoot.activeElement) {
      el = el.shadowRoot.activeElement;
    }
    if (!el) return false;
    // Jira の説明・コメント欄は ProseMirror の contenteditable（input/textarea ではない）
    if (el.isContentEditable) return true;
    var tag = el.tagName;
    if (tag === "TEXTAREA") return true;
    if (tag === "INPUT") return !NON_TEXT_INPUT.test(String(el.type || "text").toLowerCase());
    return false;
  }

  // --- アイドル時の自動リロード ---
  // アイドルとみなす閾値（ミリ秒）。放置の判定と、表に戻ったときの判定が同じ値を見る。
  function idleMs(c) {
    return Math.max(5, c.idleThresholdSecs | 0) * 1000;
  }
  var reloadTimer = null;
  function scheduleReload() {
    if (reloadTimer) {
      clearInterval(reloadTimer);
      reloadTimer = null;
    }
    var cfg = window.__JIRAPP_CONFIG__;
    if (!cfg.autoReloadEnabled) return;
    var intervalMs = Math.max(5, cfg.reloadCheckIntervalSecs | 0) * 1000;
    reloadTimer = setInterval(function () {
      var c = window.__JIRAPP_CONFIG__;
      if (!c.autoReloadEnabled) return;
      // 隠れているあいだは判定しない（Pike #380）。表に戻ったときの扱いは visibilitychange が持つ。
      if (document.hidden) return;
      if (isEditing()) {
        lastActivity = Date.now();
        return;
      }
      if (Date.now() - lastActivity >= idleMs(c)) {
        lastActivity = Date.now(); // 連続リロード防止
        location.reload();
      }
    }, intervalMs);
  }

  // --- 表に戻ったときのリロード（Pike #380）---
  // 隠れていた時間が閾値を超えていたら、表に戻った時点でリロードする（裏にあったあいだの更新を
  // 取り込む）。**閾値を見るのは、短い隠れ方でリロードしないため**：Pike はダイアログや
  // QuickOpen を開いているあいだも子 webview を隠すので、閉じるたびにリロードされてしまう。
  // 閾値に届かなければ、隠れていた時間はアイドルに数えない（戻った時点から数え直す）。
  var hiddenAt = null;
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      hiddenAt = Date.now();
      return;
    }
    var c = window.__JIRAPP_CONFIG__;
    var away = hiddenAt == null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    lastActivity = Date.now();
    if (c.autoReloadEnabled && !isEditing() && away >= idleMs(c)) {
      location.reload();
    }
  });

  // 設定適用のエントリポイント（jirapp では Rust が push_config_script 経由で呼んだ。Pike では
  // DOM 準備時の 1 回だけ）。
  window.__JIRAPP_APPLY__ = function (cfg) {
    if (cfg) window.__JIRAPP_CONFIG__ = cfg;
    JIRAPP.addStyle("__jirapp_user_css__", window.__JIRAPP_CONFIG__.customCss || "");
    scheduleReload();
    for (var i = 0; i < configListeners.length; i++) {
      try {
        configListeners[i](window.__JIRAPP_CONFIG__);
      } catch {}
    }
  };

  // DOM 準備時に既定設定で一度適用しておく。
  function bootstrap() {
    window.__JIRAPP_APPLY__();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();
