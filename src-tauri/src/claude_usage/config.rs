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

use crate::types::{
    install_key, wsl_home_cached, wsl_home_subdir_cached, wsl_native_to_unc, ShellConfig,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

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

/// シェルが持っている `CLAUDE_CONFIG_DIR`。
///
/// WSL は **対話ログインシェル（`-lic`）で** 引く。Ubuntu の `.bashrc` は先頭で
/// 非対話なら `return` するので、`bash -lc` だと `.bashrc` の export を取りこぼす。
/// Pike のターミナルは対話シェルなので、そちらに合わせないと「端末の claude と
/// Pike の集計で別のアカウントを見る」ことになる。
///
/// **問い方もキャッシュも `shell_probe.rs` の担当**（#275 の宿題 3）。あちらは同じ
/// `-lic` の中でエージェントの `bin` も探すので、**同じ distro に対話ログインシェルが
/// 2 本上がらない**。値は rc ファイル由来なのでプロジェクトではなく**インストール単位**で、
/// ウィンドウを何枚開いていても distro につき 1 回で足りる。
fn shell_env_value(shell: &ShellConfig) -> Option<String> {
    let ShellConfig::Wsl { .. } = shell else {
        // Windows シェルは Pike のプロセス環境をそのまま見る（cmd / Git Bash は起動時に
        // 継承するので同じ値）。PowerShell のプロファイルの中だけで設定した場合は拾えない。
        // macOS のローカルシェルもここへ落ちる（`.claude/rules/platform.md`）。
        return std::env::var("CLAUDE_CONFIG_DIR")
            .ok()
            .filter(|v| !v.is_empty());
    };
    crate::shell_probe::config_dir_env(shell)
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

/// そのシェルのホームを、**シェルから見た形と Pike から読める形の対**で返す。
///
/// WSL は distro の中にホームがあり、Pike（Windows プロセス）が読むには UNC が要る、
/// という食い違いを吸収する 1 箇所。`agent_hook` の候補列挙も同じ対を要るので共有する
/// （別々に書くと、distro のホーム解決や UNC 化の規則を変えたとき片方だけが直る）。
pub(crate) fn shell_home(shell: &ShellConfig) -> Option<(String, PathBuf)> {
    match shell {
        ShellConfig::Wsl { distro } => {
            let native = wsl_home_cached(shell, distro)?;
            let read = wsl_native_to_unc(distro, &native)?;
            Some((native, read))
        }
        // WSL 以外はホスト自身。`USERPROFILE` を直接読むと macOS で None になる。
        _ => {
            let native = crate::types::host_home()?;
            let read = PathBuf::from(&native);
            Some((native, read))
        }
    }
}

/// `(HOME, .envrc の Windows から読めるパス)`。
fn home_and_envrc(shell: &ShellConfig, project_root: &str) -> (Option<String>, Option<PathBuf>) {
    let home = shell_home(shell).map(|(native, _)| native);
    let envrc = match shell {
        // `.envrc` はただのファイルなので UNC で直接読む。プロジェクトごとに違う
        // 唯一の入力がこれなので、ここを spawn 無しにできると解決全体が
        // インストール単位のキャッシュに乗る。
        ShellConfig::Wsl { distro } => wsl_native_to_unc(
            distro,
            &format!("{}/.envrc", project_root.trim_end_matches('/')),
        ),
        _ => Some(Path::new(project_root).join(".envrc")),
    };
    (home, envrc)
}

fn resolve_uncached(shell: &ShellConfig, project_root: &str) -> ClaudeConfig {
    let (home, envrc_path) = home_and_envrc(shell, project_root);
    let from_envrc = || {
        envrc_path
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|text| envrc_value(&text).and_then(|v| expand_value(v, home.as_deref())))
    };
    // 申告（#299）が最優先。**これだけが「実際に走った claude が見ていた場所」**で、
    // 残りの 2 つは起動前の予測（起動ラッパーがシェル関数で被せる構成では、どちらも
    // 空になる）。展開は通さない: hook が渡してくるのは既に解決済みの絶対パス。
    let native = crate::agent_hook::declared_config_dir(shell, project_root)
        .or_else(from_envrc)
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

/// キャッシュした解決 1 件。
struct CacheEntry {
    at: Instant,
    /// 読んだときの申告ファイルの更新時刻（#299）。
    declared_at: Option<SystemTime>,
    config: ClaudeConfig,
}

/// キー＝(インストール, プロジェクト root)。
type ResolveCache = Mutex<HashMap<(String, String), CacheEntry>>;

/// 設定ディレクトリを解決する。`RESOLVE_TTL` のあいだキャッシュする。
///
/// **期限内でも、申告（#299）が更新されていれば解き直す。** 時間だけで失効させると、
/// hook が新しいアカウントを申告しても最大 5 分は古い結果を返すので、走行中の Pike へ
/// 「捨てろ」と伝える IPC が要ることになる。入力そのものの更新時刻を見れば、その経路も、
/// 経路を持てない非 Windows との非対称も要らない。代償はローカルの小さいファイルへの
/// stat 1 回で、この関数が miss で払うもの（WSL の対話ログインシェル、UNC 越しの
/// `.claude.json`）に比べれば無視できる。
pub fn resolve(shell: &ShellConfig, project_root: &str) -> ClaudeConfig {
    static CACHE: OnceLock<ResolveCache> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = (install_key(shell), project_root.to_string());
    let declared_at = crate::agent_hook::declarations_mtime();

    // ロックはプローブ中も持ったまま。usage と rate のポーリングは同じ tick で走るので、
    // 手放すと期限切れのたびに 2 本が同時に解決を始める。
    let mut map = match cache.lock() {
        Ok(map) => map,
        Err(_) => return resolve_uncached(shell, project_root),
    };
    if let Some(entry) = map.get(&key) {
        if entry.at.elapsed() < RESOLVE_TTL && entry.declared_at == declared_at {
            return entry.config.clone();
        }
    }
    let config = resolve_uncached(shell, project_root);
    map.insert(
        key,
        CacheEntry {
            at: Instant::now(),
            declared_at,
            config: config.clone(),
        },
    );
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
    use super::{envrc_value, expand_value, ClaudeAccount, ClaudeJson};

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

    // マーカー行の拾い方（バナー混じり・空の値）は `types.rs` の `marker_values` の
    // テストが持つ。この 2 つはそこを薄く包んだ関数を試すだけだったので、
    // `shell_probe.rs` へ問い方ごと移したときに落とした。

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
        assert_eq!(
            expand_value("$XDG_STATE_HOME/claude", Some("/home/kan")),
            None
        );
        assert_eq!(expand_value("~/.claude", None), None);
    }

    /// 行末コメントや連結で切り出しを誤ると、引用符が値の中に残る。そのまま使うと
    /// 存在しないパスになるので拾わない。
    #[test]
    fn rejects_unbalanced_quotes() {
        assert_eq!(
            expand_value("\"$HOME/.claude\" # メモ", Some("/home/kan")),
            None
        );
        assert_eq!(expand_value("'/opt/claude", Some("/home/kan")), None);
    }
}
