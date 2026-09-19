// F5 でページを再読み込みする（issue #25）。ブラウザ系のキー操作に揃える。
//
// WebView2 のブラウザアクセラレータキー（F5=更新 等）は有効/無効が環境・設定に依存し、
// 既定で効かないことがある。そこに依存せず一貫して効くよう、window の keydown を
// capture で捕捉して自前で location.reload() する。フル reload なので document-start の
// 注入（machinery 等）も再実行され、on_page_load でユーザー CSS/設定も再適用される
// （システムメニュー「再読み込み」＝ホストからの location.reload() と同じ経路）。
JIRAPP.registerFeature("reloadShortcut", function () {
  window.addEventListener(
    "keydown",
    function (e) {
      // 修飾キーなしの F5 のみを対象にする（Alt+F5 等の別割当を横取りしない）。
      if (e.key === "F5" && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        location.reload();
      }
    },
    { capture: true }
  );
});
