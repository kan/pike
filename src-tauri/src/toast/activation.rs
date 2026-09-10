//! 通知を押されたことを受け取る口（#334）。
//!
//! ## なぜプロトコルなのか
//!
//! トーストの活性化には 2 つの経路がある。画面に出ているあいだは、アプリが持っている
//! `ToastNotification` の `Activated` が発火する（インプロセス）。**通知センターへ移った
//! あとのクリックはそこを通らない**: Windows はショートカットの
//! `ToastActivatorCLSID` を CoCreate して `INotificationActivationCallback` を呼ぶ。
//! 集中モードや離席でトーストを見逃すと通知は最初から通知センターへ入るので、
//! この経路を持たないと「押しても何も起きない」が普通に起きる。
//!
//! COM サーバーを実装する道もあるが、Microsoft が挙げているもう一方
//! （**スタブ CLSID ＋ プロトコル活性化**）を採る。Pike はトースト上のテキスト入力を
//! 使わないので、失うのはインプロセス活性化だけで、そちらはプロトコル側に寄せられる。
//!
//! **ショートカットに CLSID を書いた時点で、インプロセスの活性化は効かなくなる。**
//! だから「通知センターのぶんを足す」のではなく、**経路をプロトコルへ一本化する**変更に
//! なる（`toast/mod.rs` は `on_activated` を登録しない）。結果として、画面上のトーストも
//! 通知センターのぶんも同じコードを通る。
//!
//! ## スキームはビルドで分ける
//!
//! `pike:` と `pike-dev:` を分けるのは、**登録が HKCU の 1 本しかないため**。同じ名前に
//! すると、最後に登録したビルドが相手の通知まで起動することになる（開発版を触った日から
//! インストール版の通知が `target\debug\pike.exe` を起こす）。ショートカットと AUMID が
//! 既にビルドで分かれている（`toast/mod.rs` の `link_name`）ので、それに揃える。

use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};

/// 通知を押されたときに開く URL の形。`focus` 以外の動作は今のところ無い。
const HOST: &str = "focus";

/// このビルドの URI スキーム。**identifier から導く**（`cfg!(debug_assertions)` では
/// `tauri build --config tauri.dev.conf.json`＝release プロファイルの開発版を取り違える）。
///
/// **非 Windows でも値を返す**（`platform.md` の「stub を置いて呼び出し側は分岐させない」）。
/// あちらに通知の経路自体が無いので、この値が使われることはない。
pub fn scheme() -> &'static str {
    #[cfg(windows)]
    {
        if crate::types::app_identifier().ends_with(".debug") {
            "pike-dev"
        } else {
            "pike"
        }
    }
    #[cfg(not(windows))]
    {
        "pike"
    }
}

/// 通知が指す先。**pty とプロジェクトの両方を載せる**（#334）。通知センターからは数時間後に
/// 押されうるので、そのころ pty は無いことのほうが多い。プロジェクトまで分かっていれば、
/// タブが無くてもそのウィンドウを前に出す（無ければ開く）ところまで行ける。
#[derive(Debug, Clone, PartialEq)]
pub struct Activation {
    pub pty: String,
    /// タブの持ち主。グローバルウィンドウのターミナルでは空。
    pub project: Option<String>,
}

impl Activation {
    /// トーストの `launch` に書く URL。
    pub fn to_url(&self) -> String {
        let mut url = format!("{}://{HOST}?pty={}", scheme(), encode(&self.pty));
        if let Some(project) = self.project.as_deref().filter(|p| !p.is_empty()) {
            url.push_str(&format!("&project={}", encode(project)));
        }
        url
    }
}

/// argv からこのビルドの活性化 URL を取り出す。プロトコル起動の argv は
/// `pike.exe "pike://focus?..."` の形。
pub fn from_args(args: &[String]) -> Option<Activation> {
    args.iter().find_map(|a| parse(a))
}

/// `<scheme>://focus?pty=…&project=…` を読む。**このビルドのスキームだけ**受ける。
///
/// **`Url` 型を持ち込まない。** 読むのは自分で組み立てた 2 つのクエリだけで、しかも
/// 相手（Windows のシェル）は `launch` に書いた文字列をそのまま返す。壊れた形は
/// `None` にして黙って捨てる（押した人に見せる先が無い）。
pub fn parse(url: &str) -> Option<Activation> {
    let rest = url.strip_prefix(&format!("{}://", scheme()))?;
    let (host, query) = rest.split_once('?')?;
    // 末尾の `/` はシェルが足すことがある（`pike://focus/?…`）。
    if host.trim_end_matches('/') != HOST {
        return None;
    }
    let mut pty = None;
    let mut project = None;
    for pair in query.split('&') {
        // **読めない組は飛ばす**（`?` で全体を捨てない）。末尾の `&` や、シェルが足した
        // 空の組が 1 つ混ざるだけで「押しても何も起きない」に落ちるのは割に合わない。
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        match key {
            "pty" => pty = Some(decode(value)),
            "project" => project = Some(decode(value)),
            _ => {}
        }
    }
    let pty = pty.filter(|v| !v.is_empty())?;
    Some(Activation {
        pty,
        project: project.filter(|v| !v.is_empty()),
    })
}

/// エスケープせずに残す文字（RFC 3986 の unreserved）。**`&` と `=` を必ず包む**のが要点で、
/// プロジェクト id にそれが入るとクエリの区切りと見分けが付かなくなる。
const UNRESERVED: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

/// percent-encode。pty は uuid、プロジェクト id はディレクトリ名から作った slug なので、
/// 実際にはほぼ素通しになる。
fn encode(s: &str) -> String {
    utf8_percent_encode(s, UNRESERVED).to_string()
}

/// percent-decode。壊れた `%` はそのまま残る（この URL を組んだのは Pike 自身なので、
/// 直せない形が来たときに直そうとしない）。
fn decode(s: &str) -> String {
    percent_decode_str(s).decode_utf8_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_pty_and_project() {
        let a = Activation {
            pty: "9f0b-1".into(),
            project: Some("my proj/ä".into()),
        };
        assert_eq!(parse(&a.to_url()), Some(a));
    }

    #[test]
    fn accepts_a_url_without_a_project() {
        let a = Activation {
            pty: "abc".into(),
            project: None,
        };
        let url = a.to_url();
        assert!(!url.contains("project"));
        assert_eq!(parse(&url), Some(a));
    }

    /// 別のビルドのスキームは受けない（開発版とインストール版で分けてある）。
    #[test]
    fn rejects_another_scheme() {
        let other = if scheme() == "pike" {
            "pike-dev"
        } else {
            "pike"
        };
        assert_eq!(parse(&format!("{other}://focus?pty=abc")), None);
    }

    #[test]
    fn rejects_a_url_without_a_pty() {
        assert_eq!(parse(&format!("{}://focus?project=p", scheme())), None);
        assert_eq!(parse(&format!("{}://focus?pty=", scheme())), None);
    }

    /// シェルが末尾に `/` を足した形も受ける。
    #[test]
    fn accepts_a_trailing_slash_on_the_host() {
        let url = format!("{}://focus/?pty=abc", scheme());
        assert_eq!(parse(&url).map(|a| a.pty), Some("abc".to_string()));
    }

    #[test]
    fn finds_the_url_among_the_argv() {
        let args = vec![
            "pike.exe".to_string(),
            format!("{}://focus?pty=xyz", scheme()),
        ];
        assert_eq!(from_args(&args).map(|a| a.pty), Some("xyz".to_string()));
        assert_eq!(from_args(&["pike.exe".to_string()]), None);
    }
}
