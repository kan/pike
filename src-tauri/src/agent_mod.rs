//! Claude Code の mod を同梱し、Pike のターミナルで動く claude に読み込ませる（#437）。
//!
//! mod は Claude Code のプロセス内で動くイベントハンドラで、**`settings.json` を書き換えずに**
//! アカウントの申告・入力待ちの知らせ・レート制限を受け取れる。読み込ませ方は環境変数
//! `CLAUDE_CODE_PLUGIN_DIRS` に mod のフォルダを渡すだけ（確認のプロンプトは出ない。WSL と
//! Windows の対話セッションで実測）。mod の本体は `src-tauri/claude-mod/pike/` で、受け口は
//! `agent_hook.rs`（mod は `pike agent-hook` を起こすだけ）。
//!
//! ## 置き場はデータフォルダ
//!
//! **バイナリに埋め込み、起動時にデータフォルダへ書き出す。** インストール先やリソースを
//! そのまま指さないのは、Claude Code が mod を読み込むたびに**そのフォルダへ型定義を
//! 書き足す**ため（`.claude-plugin/types/`）。インストール先を汚すうえ、書けない場所だと
//! 読み込みごと失敗しうる。埋め込みなら開発版・インストール版・更新のあとで扱いが変わらず、
//! バンドラが隠しフォルダ（`.claude-plugin`）を落とす心配も無い。
//!
//! ## 古い Claude Code と、mod を止めている環境
//!
//! mod は 2.1.287 以降が要る。**それより古い版や、`disableAllHooks`・組織のポリシーで mod が
//! 止まる環境では、環境変数が無視されるだけ**で、`settings.json` に登録した hook（#299 /
//! #265）がこれまでどおり動く。両方が動く環境で通知が二重にならないよう、mod は自分が
//! 動いている目印（`agent_hook::MOD_ENV`）を立て、settings 側の hook はそれを見て黙る。
//!
//! ## 届かないもの
//!
//! - **Pike の外で起動した claude**。環境変数を渡すのが PTY の spawn なので
//! - **利用者がシェルの rc で `CLAUDE_CODE_PLUGIN_DIRS` を上書きしている場合**。Pike の
//!   プロセスが継いだ値には足すが、シェルが起動してから代入されたものは見えない

use crate::types::ShellConfig;
use std::path::PathBuf;
use std::sync::OnceLock;

/// Claude Code が mod のフォルダを読む環境変数。パスの並び（区切りは OS のもの）。
const PLUGIN_DIRS_ENV: &str = "CLAUDE_CODE_PLUGIN_DIRS";
/// mod が起こす `pike` の実行ファイル。**PATH に頼らない**: 開発版とインストール版が
/// 並んでいるとき、PATH の `pike.exe` は常にインストール版になる。
const HOOK_EXE_ENV: &str = "PIKE_HOOK_EXE";
/// どのインストールの claude か（`types::install_key`）。mod は自分がどの distro の中で
/// 動いているかを知らないので、spawn する側が渡す（`Declaration::install` と同じ事情）。
const INSTALL_KEY_ENV: &str = "PIKE_INSTALL_KEY";

/// 走っている Pike へ届ける配送があるか（`wait::DELIVERS_NOTICES`）。**無い OS では立てない。**
/// mod はこれを見て、知らせと状態の報告のために `pike` を起こすかを決める: 届け先が無いのに
/// 起こすと、ターンのたびにプロセスだけが立って何もせずに終わる。申告とレートの報告は
/// ファイルに書くものなので、この変数に依らず送る。
const LIVE_ENV: &str = "PIKE_HOOK_LIVE";

/// mod のファイル。**足したらここにも 1 行**（埋め込みなので、漏れると配られない）。
const FILES: &[(&str, &str)] = &[
    (
        ".claude-plugin/plugin.json",
        include_str!("../claude-mod/pike/.claude-plugin/plugin.json"),
    ),
    (
        "hooks/hooks.json",
        include_str!("../claude-mod/pike/hooks/hooks.json"),
    ),
    (
        "hooks/register.ts",
        include_str!("../claude-mod/pike/hooks/register.ts"),
    ),
];

/// 書き出した mod のフォルダ。書けなかったら `None`（mod 無しで動く）。
static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

/// mod をデータフォルダへ書き出す。**起動時に 1 回**（`setup`）。
///
/// **中身が同じなら書かない。** 走っている claude はこのフォルダを見張っていて、保存の
/// たびに mod を読み直す。Pike を起動し直すだけで全セッションの mod が読み直されるのは
/// 余計なので、変わったファイルだけを書く。
pub fn install(identifier: &str) {
    DIR.get_or_init(|| {
        let dir = crate::types::pike_config_dir_for(identifier)?
            .join("claude-mod")
            .join("pike");
        for (rel, content) in FILES {
            let path = dir.join(rel);
            if std::fs::read_to_string(&path).is_ok_and(|current| current == *content) {
                continue;
            }
            let written = path
                .parent()
                .map_or(Ok(()), std::fs::create_dir_all)
                .and_then(|()| std::fs::write(&path, content));
            if let Err(e) = written {
                log::warn!("[agent-mod] failed to write {}: {e}", path.display());
                return None;
            }
        }
        Some(dir)
    });
}

/// `pty_env` の変数を WSL へ渡すために `WSLENV` へ足す綴り。
///
/// - **フォルダの並びだけ `/l`（パスの並びとして変換）を付ける**。Windows のパスが
///   `/mnt/c/...` になり、区切りも `:` に直る（実測）
/// - `LIVE_ENV` は WSL の中の mod が読む（配送は Windows 側にあるので、WSL でも立てる）
/// - **mod が立てる目印（`agent_hook::MOD_ENV`）も並べる。** WSL の settings の hook が
///   起こすのは interop 越しの `pike.exe`（Windows プロセス）で、そこへ渡るのは `WSLENV` に
///   載せた変数だけ。載せないと目印が届かず、mod と hook の両方が知らせて通知が二重になる
pub const WSLENV_NAMES: [&str; 5] = [
    "CLAUDE_CODE_PLUGIN_DIRS/l",
    HOOK_EXE_ENV,
    INSTALL_KEY_ENV,
    LIVE_ENV,
    crate::agent_hook::MOD_ENV,
];

/// そのシェルのターミナルに mod を読み込ませるための環境変数（`(名前, 値)`）。
/// 書き出せていなければ `None`。WSL へは `WSLENV_NAMES` も要る。
pub fn pty_env(shell: Option<&ShellConfig>) -> Option<Vec<(&'static str, String)>> {
    let dir = DIR.get()?.as_ref()?;
    // 利用者が既に指定しているフォルダは残し、後ろへ足す。
    let mut dirs: Vec<PathBuf> = std::env::var_os(PLUGIN_DIRS_ENV)
        .map(|current| std::env::split_paths(&current).collect())
        .unwrap_or_default();
    if !dirs.contains(dir) {
        dirs.push(dir.clone());
    }
    let joined = std::env::join_paths(dirs).ok()?;
    let mut vars = vec![
        (PLUGIN_DIRS_ENV, joined.to_string_lossy().into_owned()),
        (HOOK_EXE_ENV, crate::agent_hook::exe_argv0_for(shell)),
    ];
    // シェルが決まっていないターミナル（既定の distro）は、どのインストールかを名乗れない。
    // 通知は届くが、申告とレートの報告はどのプロジェクトにも一致しない（どちらも
    // インストールで突き合わせる）。プロジェクトのターミナルは必ずシェルを持つ。
    if let Some(shell) = shell {
        vars.push((INSTALL_KEY_ENV, crate::types::install_key(shell)));
    }
    if crate::wait::DELIVERS_NOTICES {
        vars.push((LIVE_ENV, "1".to_owned()));
    }
    Some(vars)
}
