//! `CLAUDE_CONFIG_DIR` の解決と、そこにログインしているアカウントの読み出し（#225）。
//!
//! Claude Code はこの環境変数で `~/.claude` の位置ごと差し替える。空ディレクトリを
//! 指して起動して確かめたところ、`projects/` も `sessions/` も `.claude.json` も
//! そこへ移る。つまり usage 集計・セッション一覧・レート取得・エージェントチャットの
//! 起動は、全部この解決結果を通す必要がある。
//!
//! 検出の順は `.envrc` → シェルの環境変数 → 既定（`$HOME/.claude`）。**`.envrc` を
//! 先に見る**のは、direnv を使っている端末では cd した時点でこちらが rc の export を
//! 上書きするため。実際に走る `claude` が見る値に合わせる。
//!
//! **`.envrc` は評価しない**（bash なので任意のコードが書ける）。`export
//! CLAUDE_CONFIG_DIR=...` の 1 行を取り出し、`~` と `$HOME` だけ Rust 側で展開する。
//!
//! Codex にも `CODEX_HOME` という同種の変数がある。今は `codex_usage` 側に要望が無い
//! ので claude 専用で書いてあるが、必要になったら claude 固有なのは変数名・ディレクトリ名・
//! `.claude.json` のアカウント読みの 3 つだけなので、そこを引数にすれば共用できる。

use crate::types::{install_key, wsl_home_cached, wsl_home_subdir_cached, wsl_native_to_unc, ShellConfig};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 解決の再実行間隔。WSL では環境変数のプローブに `wsl.exe` の起動を伴うので、
/// 30 秒ごとの usage ポーリングに毎回付き合わせない。`.envrc` を書き換えてから
/// 反映までの上限であり、アカウント表示が切り替わるまでの上限でもある。
const RESOLVE_TTL: Duration = Duration::from_secs(300);

/// 解決した設定ディレクトリ。
#[derive(Debug, Clone)]
pub struct ClaudeConfig {
    /// シェルから見たパス。既定（`$HOME/.claude`）なら `None`。`claude` を起動する側
    /// （`rate.rs`・エージェントチャット）が export する値で、Windows から読むための
    /// ものではない。
    pub native_override: Option<String>,
    /// Pike（Windows プロセス）が読めるパス。WSL なら `\\wsl.localhost\…` の UNC。
    pub read_path: Option<PathBuf>,
    /// `read_path` の `.claude.json` にログインしているアカウント。
    ///
    /// ここで一緒に読むのは、`.claude.json` が Claude Code のカウンタ置き場でもあって
    /// 数十 KB あり、しかも稼働中は数十秒ごとに mtime が変わるため。ポーリングのたびに
    /// 読み直すと UNC 越しに毎回全文を舐めることになる。中身（メールアドレス）が変わる
    /// のはログインし直したときだけなので、この TTL に相乗りさせる。
    pub account: Option<ClaudeAccount>,
}

/// `.claude.json` の `oauthAccount` から、どのアカウントかが分かる分だけ取り出す。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAccount {
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub organization: Option<String>,
    /// 表示用のプラン名。どのフィールドから来るかは `plan_label` を参照。
    pub plan: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ClaudeJson {
    #[serde(rename = "oauthAccount")]
    oauth_account: Option<OauthAccount>,
}

/// `.claude.json` の `oauthAccount`。綴りがフィールド名と違うので、素直に読める
/// `ClaudeAccount` とは分けてある。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OauthAccount {
    email_address: Option<String>,
    display_name: Option<String>,
    organization_name: Option<String>,
    seat_tier: Option<String>,
    organization_rate_limit_tier: Option<String>,
    organization_type: Option<String>,
}

impl From<OauthAccount> for ClaudeAccount {
    fn from(a: OauthAccount) -> Self {
        let plan = plan_label(&a);
        Self {
            email: a.email_address,
            display_name: a.display_name,
            organization: a.organization_name,
            plan,
        }
    }
}

/// 表示するプラン名。
///
/// **`seatTier` は個人のサブスクリプションでは `null`**（実機で確認）。Team /
/// Enterprise の席にしか入らないので、無ければ枠の等級（`organizationRateLimitTier`、
/// 例 `default_claude_max_20x`）、それも無ければ種別（`organizationType`、
/// 例 `claude_max`）に落とす。`default_` の接頭辞は情報を持たないので外す。
///
/// 値そのものは加工しない。将来増える等級を勝手に読み替えて誤った名前を出すより、
/// Claude が付けた名前をそのまま見せるほうが安全。
fn plan_label(a: &OauthAccount) -> Option<String> {
    let raw = a
        .seat_tier
        .as_deref()
        .or(a.organization_rate_limit_tier.as_deref())
        .or(a.organization_type.as_deref())?;
    let trimmed = raw.strip_prefix("default_").unwrap_or(raw);
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// マーカー行の値だけ拾う。対話 bash は `.bashrc` のバナーを stdout に出すことがあるので、
/// 行の位置ではなく接頭辞で選ぶ（実測でこのマシンの `.bashrc` は `git status` の結果を出す）。
fn marker_value(stdout: &str, tag: &str) -> Option<String> {
    stdout
        .lines()
        .filter_map(|line| line.strip_prefix(tag)?.strip_prefix('\t'))
        .map(|v| v.trim_end_matches('\r').to_string())
        .find(|v| !v.is_empty())
}

/// キー＝インストール、値＝(引いた時刻, 環境変数の値)。
type EnvCache = Mutex<HashMap<String, (Instant, Option<String>)>>;

/// シェルが持っている `CLAUDE_CONFIG_DIR`。
///
/// WSL は **対話ログインシェル（`-lic`）で** 引く。Ubuntu の `.bashrc` は先頭で
/// 非対話なら `return` するので、`bash -lc` だと `.bashrc` の export を取りこぼす。
/// Pike のターミナルは対話シェルなので、そちらに合わせないと「端末の claude と
/// Pike の集計で別のアカウントを見る」ことになる。
///
/// 対話シェルは終了時に履歴ファイルを書き戻すので、**先頭で `HISTFILE` を落とす**。
/// 落とさないと、このプローブが `HISTSIZE` の設定次第でユーザーの `.bash_history` を
/// 削りうる。`.bashrc` の読み込みは `-c` の文字列より先なので、ここで unset すれば
/// 終了時の書き戻しだけを止められる。
///
/// 値は rc ファイル由来なのでプロジェクトではなく**インストール単位**。ウィンドウを
/// 何枚開いていても distro につき 1 回で足りる。ロックはプローブ中も持ったままにして、
/// 同時に期限切れになった呼び出し（usage と rate は同じ tick で走る）が二重に
/// シェルを起動しないようにする。
fn shell_env_value(shell: &ShellConfig) -> Option<String> {
    let ShellConfig::Wsl { .. } = shell else {
        // Windows シェルは Pike のプロセス環境をそのまま見る（cmd / Git Bash は起動時に
        // 継承するので同じ値）。PowerShell のプロファイルの中だけで設定した場合は拾えない。
        return std::env::var("CLAUDE_CONFIG_DIR").ok().filter(|v| !v.is_empty());
    };

    static CACHE: OnceLock<EnvCache> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = install_key(shell);
    let mut map = cache.lock().ok()?;
    if let Some((at, value)) = map.get(&key) {
        if at.elapsed() < RESOLVE_TTL {
            return value.clone();
        }
    }
    let script = "unset HISTFILE\nprintf 'PIKEENV\\t%s\\n' \"$CLAUDE_CONFIG_DIR\"\nexit 0";
    // 終了コードは見ない。対話シェルは job control の警告を出すし、`.bashrc` の中身次第で
    // 非 0 で終わることもある。
    let value = shell
        .run("bash", &["-lic", script])
        .ok()
        .and_then(|(_code, stdout, _stderr)| marker_value(&stdout, "PIKEENV"));
    map.insert(key, (Instant::now(), value.clone()));
    value
}

/// `.envrc` から `export CLAUDE_CONFIG_DIR=<値>` の右辺を取り出す。行末コメントは扱わない
/// （クォートの中の `#` と区別できないため。誤解釈するくらいなら拾わない）。
fn envrc_value(text: &str) -> Option<&str> {
    text.lines()
        .filter_map(|line| {
            let rest = line.trim_start().strip_prefix("export ")?;
            let rhs = rest.trim_start().strip_prefix("CLAUDE_CONFIG_DIR=")?;
            Some(rhs.trim())
        })
        .find(|rhs| !rhs.is_empty())
}

/// クォートを外し、`~` と `$HOME` だけ展開する。他の展開が残る値は `None`。
fn expand_value(raw: &str, home: Option<&str>) -> Option<String> {
    let trimmed = raw.trim();
    let unquoted = ['"', '\'']
        .iter()
        .find_map(|q| trimmed.strip_prefix(*q).and_then(|s| s.strip_suffix(*q)))
        .unwrap_or(trimmed);
    // 引用符が残っている＝開いたまま閉じていない（行末コメントや連結）。切り出しを
    // 誤っているので拾わない。
    if unquoted.is_empty() || unquoted.contains(['"', '\'', '`']) {
        return None;
    }
    let expanded = match home {
        Some(home) => {
            let home = home.trim_end_matches('/');
            let s = unquoted.replace("${HOME}", home).replace("$HOME", home);
            match s.strip_prefix('~') {
                Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("{home}{rest}"),
                _ => s,
            }
        }
        // HOME が分からないなら `~`/`$HOME` は解けない。
        None if unquoted.starts_with('~') => return None,
        None => unquoted.to_string(),
    };
    // コマンド置換も、`$HOME` 以外の変数も、ここに引っかかる。
    if expanded.contains('$') {
        return None;
    }
    Some(expanded)
}

/// `(HOME, .envrc の Windows から読めるパス)`。
fn home_and_envrc(shell: &ShellConfig, project_root: &str) -> (Option<String>, Option<PathBuf>) {
    match shell {
        ShellConfig::Wsl { distro } => (
            wsl_home_cached(shell, distro),
            // `.envrc` はただのファイルなので UNC で直接読む。プロジェクトごとに違う
            // 唯一の入力がこれなので、ここを spawn 無しにできると解決全体が
            // インストール単位のキャッシュに乗る。
            wsl_native_to_unc(distro, &format!("{}/.envrc", project_root.trim_end_matches('/'))),
        ),
        // WSL 以外はホスト自身。`USERPROFILE` を直接読むと macOS で None になる。
        _ => (
            crate::types::host_home(),
            Some(Path::new(project_root).join(".envrc")),
        ),
    }
}

fn resolve_uncached(shell: &ShellConfig, project_root: &str) -> ClaudeConfig {
    let (home, envrc_path) = home_and_envrc(shell, project_root);
    let from_envrc = envrc_path
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|text| envrc_value(&text).and_then(|v| expand_value(v, home.as_deref())));
    let native = from_envrc
        .or_else(|| shell_env_value(shell).and_then(|v| expand_value(&v, home.as_deref())));

    // 実在を確認できたときだけ採用する。読めない値を `native_override` に残すと、
    // `claude` を起動する側がそれを export して別の場所を作らせてしまう。
    let overridden = native.and_then(|native| {
        let read = match shell {
            ShellConfig::Wsl { distro } => wsl_native_to_unc(distro, &native),
            _ => Some(PathBuf::from(&native)),
        };
        read.filter(|p| p.is_dir()).map(|read| (native, read))
    });

    let (native_override, read_path) = match overridden {
        Some((native, read)) => (Some(native), Some(read)),
        None => (
            None,
            match shell {
                ShellConfig::Wsl { distro } => wsl_home_subdir_cached(shell, distro, ".claude"),
                _ => home.map(|p| PathBuf::from(p).join(".claude")),
            },
        ),
    };
    ClaudeConfig {
        account: read_path
            .as_deref()
            .and_then(|dir| read_account(dir, native_override.is_some())),
        native_override,
        read_path,
    }
}

/// キー＝(インストール, プロジェクト root)、値＝(解決した時刻, 結果)。
type ResolveCache = Mutex<HashMap<(String, String), (Instant, ClaudeConfig)>>;

/// 設定ディレクトリを解決する。`RESOLVE_TTL` のあいだキャッシュする。
pub fn resolve(shell: &ShellConfig, project_root: &str) -> ClaudeConfig {
    static CACHE: OnceLock<ResolveCache> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = (install_key(shell), project_root.to_string());

    // ロックはプローブ中も持ったまま。usage と rate のポーリングは同じ tick で走るので、
    // 手放すと期限切れのたびに 2 本が同時に解決を始める。
    let mut map = match cache.lock() {
        Ok(map) => map,
        Err(_) => return resolve_uncached(shell, project_root),
    };
    if let Some((at, config)) = map.get(&key) {
        if at.elapsed() < RESOLVE_TTL {
            return config.clone();
        }
    }
    let config = resolve_uncached(shell, project_root);
    map.insert(key, (Instant::now(), config.clone()));
    config
}

/// `.claude.json` からアカウントを読む。呼び出しは `resolve` 経由に限る
/// （`ClaudeConfig::account` の doc を参照）。
///
/// **場所が 2 通りある**。`CLAUDE_CONFIG_DIR` を設定していればその中（#225 で空の
/// ディレクトリを指して起動して確認）、既定では `~/.claude` の**中ではなく隣**の
/// `~/.claude.json`（Windows・WSL の実機で確認）。
///
/// **上書きの有無で場所を決め、フォールバックしない**。上書きしているのにその中に
/// まだ `.claude.json` が無いとき（ログイン前など）に親を見ると、`~/.claude.json` の
/// **既定アカウント**を上書き先のものとして表示してしまう。「今どのアカウントか」を
/// 出すための表示で嘘をつくのは、出さないより悪い。
fn read_account(dir: &Path, overridden: bool) -> Option<ClaudeAccount> {
    let base = if overridden {
        dir.to_path_buf()
    } else {
        dir.parent()?.to_path_buf()
    };
    let text = std::fs::read_to_string(base.join(".claude.json")).ok()?;
    let parsed = serde_json::from_str::<ClaudeJson>(&text).ok()?;
    Some(parsed.oauth_account?.into())
}

#[cfg(test)]
mod tests {
    use super::{envrc_value, expand_value, marker_value, ClaudeAccount, ClaudeJson};

    /// `.claude.json` の `oauthAccount` の実際のキー名（実ファイルから抜粋）。
    /// フィールド名と綴りが違うものがあるので、対応が崩れたら気付けるようにする。
    #[test]
    fn reads_the_account_out_of_claude_json() {
        let json = serde_json::json!({
            "numStartups": 42,
            "oauthAccount": {
                "accountUuid": "u-1",
                "emailAddress": "kan@example.com",
                "displayName": "Kan",
                "organizationName": "Example Inc",
                "seatTier": "max_20x",
            },
        })
        .to_string();
        let account: ClaudeAccount = serde_json::from_str::<ClaudeJson>(&json)
            .unwrap()
            .oauth_account
            .unwrap()
            .into();
        assert_eq!(account.email.as_deref(), Some("kan@example.com"));
        assert_eq!(account.display_name.as_deref(), Some("Kan"));
        assert_eq!(account.organization.as_deref(), Some("Example Inc"));
        assert_eq!(account.plan.as_deref(), Some("max_20x"));
    }

    /// 個人のサブスクリプションでは `seatTier` が null。枠の等級に落とし、
    /// 情報を持たない `default_` の接頭辞だけ外す（実アカウントの値で確認）。
    #[test]
    fn plan_falls_back_when_seat_tier_is_null() {
        let json = serde_json::json!({
            "oauthAccount": {
                "emailAddress": "kan@example.com",
                "seatTier": null,
                "organizationRateLimitTier": "default_claude_max_20x",
                "organizationType": "claude_max",
            },
        })
        .to_string();
        let account: ClaudeAccount = serde_json::from_str::<ClaudeJson>(&json)
            .unwrap()
            .oauth_account
            .unwrap()
            .into();
        assert_eq!(account.plan.as_deref(), Some("claude_max_20x"));
    }

    /// 等級も無ければ種別まで落ちる。
    #[test]
    fn plan_falls_back_to_organization_type() {
        let json = serde_json::json!({
            "oauthAccount": { "organizationType": "claude_pro" },
        })
        .to_string();
        let account: ClaudeAccount = serde_json::from_str::<ClaudeJson>(&json)
            .unwrap()
            .oauth_account
            .unwrap()
            .into();
        assert_eq!(account.plan.as_deref(), Some("claude_pro"));
    }

    /// ログイン前は `oauthAccount` ごと無い。
    #[test]
    fn missing_account_is_none() {
        let parsed = serde_json::from_str::<ClaudeJson>("{\"numStartups\":1}").unwrap();
        assert!(parsed.oauth_account.is_none());
    }

    #[test]
    fn picks_marker_line_amid_banner_noise() {
        let out = "Welcome to Ubuntu\nPIKEENV\t/home/kan/.cc-work\nsome banner\n";
        assert_eq!(marker_value(out, "PIKEENV").as_deref(), Some("/home/kan/.cc-work"));
    }

    #[test]
    fn empty_marker_value_is_none() {
        assert_eq!(marker_value("PIKEENV\t\n", "PIKEENV"), None);
        assert_eq!(marker_value("banner only\n", "PIKEENV"), None);
    }

    #[test]
    fn extracts_and_expands_envrc_value() {
        let text = "use flake\n  export CLAUDE_CONFIG_DIR=\"$HOME/.claude-work\"\n";
        let raw = envrc_value(text).unwrap();
        assert_eq!(
            expand_value(raw, Some("/home/kan")).as_deref(),
            Some("/home/kan/.claude-work")
        );
    }

    #[test]
    fn ignores_unrelated_exports() {
        assert_eq!(envrc_value("export PATH=/x\nexport FOO=1\n"), None);
    }

    #[test]
    fn expands_tilde_and_strips_quotes() {
        assert_eq!(
            expand_value("'~/.claude-alt'", Some("/home/kan/")).as_deref(),
            Some("/home/kan/.claude-alt")
        );
    }

    #[test]
    fn rejects_values_needing_evaluation() {
        assert_eq!(expand_value("$(pwd)/.claude", Some("/home/kan")), None);
        assert_eq!(expand_value("`pwd`/.claude", Some("/home/kan")), None);
        assert_eq!(expand_value("$XDG_STATE_HOME/claude", Some("/home/kan")), None);
        assert_eq!(expand_value("~/.claude", None), None);
    }

    /// 行末コメントや連結で切り出しを誤ると、引用符が値の中に残る。そのまま使うと
    /// 存在しないパスになるので拾わない。
    #[test]
    fn rejects_unbalanced_quotes() {
        assert_eq!(expand_value("\"$HOME/.claude\" # メモ", Some("/home/kan")), None);
        assert_eq!(expand_value("'/opt/claude", Some("/home/kan")), None);
    }
}
