//! エージェントの hook から Pike へ伝える口（#299 のアカウントの申告と、#265 の
//! 入力待ちの通知）。
//!
//! `claude_usage::config` の解決（`.envrc` → シェルの環境変数 → 既定）は「これから
//! 起動する `claude` がどの設定ディレクトリを見るか」を**起動前に予測する**もので、
//! 起動ラッパーがシェル関数で `CLAUDE_CONFIG_DIR` を被せる運用では両方の入力に
//! 現れない。**予測をやめ、起動した本人に申告させる**のがこのモジュール。
//!
//! ## 経路
//!
//! Claude Code の `SessionStart` hook が `pike agent-hook` を起動し、stdin の JSON を
//! 渡す。`transcript_path`（`<config dir>/projects/<slug>/<session_id>.jsonl`）から
//! 設定ディレクトリが確定するので、環境変数を読む必要すらない。
//!
//! **hook プロセスは Tauri を起動しない。** `main.rs` の先頭で分岐して、申告を
//! ファイルへ書いて終わる。プロセスの起動と数 KB の書き込みだけなので、セッション
//! 開始に体感できるコストを載せない。
//!
//! **申告は走っている Pike へ知らせない。** 反映は `claude_usage::config` の
//! キャッシュがこのファイルの mtime を見ることで起きる（`declarations_mtime`）。
//! IPC で「捨てろ」と伝える形も書けるが、(1) 受け側がメインスレッドなので、解決の
//! ロックを待つあいだ UI が止まりうる、(2) single-instance の WM_COPYDATA は Windows
//! にしか無いので非 Windows だけ遅れる、(3) 申告 1 件のために全プロジェクトの解決を
//! 捨てることになる。入力の更新時刻を見れば、3 つとも起きない。
//!
//! ## 入力待ちの通知（#265）
//!
//! `Notification` と `Stop` の hook は `--event=` 付きで登録し、**こちらは走っている
//! Pike へ届ける**（`notify_running_pike`）。通知は即時性が要るのでファイル越しでは
//! 間に合わず、上の 3 つの理由もここには当てはまらない（配送は解決のロックを取らない）。
//!
//! 経路は single-instance の WM_COPYDATA（`wait::send_to_first_instance`）で、**WSL の
//! 中からでも届く**: interop で起動された `pike.exe` は Windows プロセスなので
//! `FindWindowW` がそのまま効く（`pike --wait` と同じ）。**配送が Windows にしか無い
//! ぶん、通知の hook も Windows でだけ登録する**（`HookSpec::windows_only`）。
//!
//! どのターミナルかは `PIKE_PTY_ID`（`pty::apply_pike_env` が export し、WSL へは
//! `WSLENV` 経由で渡る）で決まる。cwd では紐付けられない: 同じディレクトリで 2 枚
//! 開くと区別できない。
//!
//! ## 守ること（`SessionStart` の作法）
//!
//! - **stdout に何も出さない。** exit 0 のときの stdout は Claude のコンテキストへ
//!   追加されるので、毎回プロンプトにゴミが混ざる
//! - **exit 2 を返さない。** `SessionStart` の exit 2 は**セッション開始をブロック**
//!   する。Pike が走っていない・書き込みに失敗した、といったときも 0 で返す

use crate::agent_usage::AgentId;
use crate::fs::{file_name_of, parent_dir_of};
use crate::types::{bash_quote, cwd_under_root, epoch_secs, pike_config_dir_for, ShellConfig};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// 申告の置き場。
const FILENAME: &str = "agent-hooks.json";

/// 申告を置く identifier。**ビルドで分けない**（`app_identifier()` を使わない）。
///
/// 申告は Pike のアプリ状態ではなく「この cwd はこの設定ディレクトリを使っている」と
/// いう**利用者の環境についての観測**なので、開発版とインストール版で 1 本を共有して
/// よい。分けていたころは、どちらのビルドで登録したかによってもう片方が申告を
/// 受け取れず、それを避けるために「`settings.json` に 2 行並べる」「開発ビルドだけ
/// コマンド行を変える」という特別扱いが要り、**そこから 2 つの不具合が出た**
/// （Git Bash がバックスラッシュを食う / 一致判定が厳しすぎて古い行を消せない）。
const STORE_IDENTIFIER: &str = "com.pike.dev";

/// このサブコマンドで hook を受ける。
const SUBCOMMAND: &str = "agent-hook";

/// 保持する申告の数。同じ (agent, cwd) は上書きするので、増えるのはディレクトリの
/// 種類ぶんだけ。上限に当たったら古いものから落とす。
const MAX_ENTRIES: usize = 200;

/// stdin から読む上限。hook の payload は数百バイトなので、これに当たるのは
/// 何かがおかしいとき。
const MAX_STDIN: u64 = 64 * 1024;

/// 今のところ hook を持つのは Claude Code だけ。**継ぎ目は `AgentId`**（`.claude/rules/
/// agent.md`）で、生の文字列を持たない: 綴りがずれても気付けないうえ、`agent_usage` 側の
/// `match` が持っている網羅性の保護から外れる。
const AGENT_CLAUDE: AgentId = AgentId::Claude;

/// どのエージェントの hook か。**`--event=` と同じく登録するコマンド行に書く**（#265）:
/// 受け側で定数を差し込むと、2 つ目のエージェントが hook を持った日や、利用者が別の
/// ラッパーからこのサブコマンドを呼んだ日に、**黙って「Claude Code」という嘘の表示名**を
/// 出す。表に無い値は捨てる（`parse_notice`）。
const AGENT_FLAG: &str = "--agent=";

/// 登録するコマンド行に載せる、どのインストールの hook かの目印
/// （`Declaration::install` を参照）。
const INSTALL_KEY_FLAG: &str = "--install-key=";

/// 通知の契機（#265）。**登録するコマンド行に書く。** `Notification` の stdin には
/// 12 個ある matcher のどれで発火したかが入らず（あるのは `message` の文言だけ）、
/// `Stop` と見分けられるのも `hook_event_name` までなので、登録するのが Pike 自身で
/// あることを使って、そのとき書いておく。
const EVENT_FLAG: &str = "--event=";

/// どの PTY から来たか。**送るときにだけ付ける**（hook プロセスは `PIKE_PTY_ID` から
/// 読むので、登録するコマンド行には書かない）。
const PTY_FLAG: &str = "--pty=";

/// フラグの値に受け入れる長さ。値は `install_key` や `pty_spawn` が作ったものだが、
/// argv は誰でも渡せるので、ファイルへ書く・別プロセスへ渡す前に丈だけ見る（一致
/// しない値は無視されるので、これ以上の検証は要らない）。
const MAX_FLAG_VALUE: usize = 128;

/// `SessionStart` hook の stdin JSON。使うのは 2 つだけなので、他は読み飛ばす。
#[derive(Debug, Deserialize)]
struct HookPayload {
    transcript_path: Option<String>,
    cwd: Option<String>,
}

/// 1 件の申告。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Declaration {
    /// どのエージェントか（`AGENT_CLAUDE` など）。
    pub agent: String,
    /// エージェントが動いていた cwd。**そのシェルから見た native パス**（WSL なら
    /// `/home/...`）で、Pike から読むためのパスではない。
    pub cwd: String,
    /// 申告された設定ディレクトリ。これも native パス。
    pub config_dir: String,
    /// どのインストールのものか（`types::install_key`）。**cwd だけでは足りない**:
    /// distro を 2 つ持っていて両方に `/home/kan/pike` があると、片方で記録した申告が
    /// もう片方のプロジェクトへ返る。hook プロセスは自分がどの distro の中から
    /// 呼ばれたかを知らない（`WSL_DISTRO_NAME` は `WSLENV` に載らない）ので、
    /// **登録するときにコマンド行へ書いておく**（`INSTALL_KEY_FLAG`）。
    ///
    /// **空を「どれにでも一致」にしない。** 目印が無いのは、利用者が hook の
    /// コマンド行から手で削ったときだけで、そこを緩くすると distro の隣へ漏れる。
    /// 空のまま一致しなければ、この機能が入る前と同じ推測の経路へ落ちるだけで済む。
    #[serde(default)]
    pub install: String,
    /// 申告の時刻（epoch 秒）。新しいものを採り、古いものから落とす。
    pub at: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Store {
    entries: Vec<Declaration>,
}

/// 通知の契機（#265）。**2 つしかないのは、これが利用者に見せる区別そのものだから**
/// （設定は `off` / 入力待ちのみ / 完了も の 3 択）。どの matcher で発火したかは、
/// 鳴らすか鳴らさないかを分けないので運ばない。
/// **綴りの正本はバリアント名。** `serde` の `lowercase`（フロントへ渡る形）と `as_flag`
/// （コマンド行に書く形）が同じ語になる。
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NoticeKind {
    /// 入力を待っている（`Notification` の `permission_prompt` 等）。
    Waiting,
    /// ターンが終わった（`Stop`）。
    Done,
}

impl NoticeKind {
    fn from_flag(value: &str) -> Option<Self> {
        [Self::Waiting, Self::Done]
            .into_iter()
            .find(|k| k.as_flag() == value)
    }

    fn as_flag(self) -> &'static str {
        match self {
            Self::Waiting => "waiting",
            Self::Done => "done",
        }
    }
}

/// 走っているウィンドウへ届ける 1 件（#265）。
///
/// **hook が受け取った本文（`message` / `last_assistant_message`）は運ばない。** 出す先が
/// 無い（知らせるのはタスクバーの点滅と画面内の印だけで、文を出す場所が無い）うえ、
/// single-instance の payload は `|` 区切りなので `|` を含みうる自由文をそのまま流せない。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentNotice {
    /// どのターミナルか（`PIKE_PTY_ID`）。フロントが pty id → タブ → プロジェクトと辿る。
    pub pty_id: String,
    /// どのエージェントか。**送り側が名乗る**（`AGENT_FLAG`）。フロントは表示名をこの id で
    /// `src/lib/agents.ts` の表から引く。
    pub agent: AgentId,
    /// `waiting` か `done`。
    pub event: NoticeKind,
}

fn store_path() -> Option<PathBuf> {
    pike_config_dir_for(STORE_IDENTIFIER).map(|dir| dir.join(FILENAME))
}

// --- hook プロセス側（Tauri は起動していない） ---

/// `pike agent-hook` として呼ばれていれば、申告を記録して**プロセスを終える**。
/// それ以外は何もせず戻る。
///
/// **`wait::try_forward_pty_origin_and_exit` より先に呼ぶこと。** hook は Pike の
/// ターミナルの中で走るので `PIKE_WINDOW_LABEL` を持っており、あちらが先に走ると
/// `--from-window` を付けて転送され、`agent-hook` という名前のファイルを開こうと
/// するアクションになる。
pub fn try_agent_hook_and_exit() {
    if std::env::args().nth(1).as_deref() != Some(SUBCOMMAND) {
        return;
    }
    run_hook();
    // 失敗しても 0。exit 2 はセッション開始をブロックする（モジュール doc）。
    std::process::exit(0);
}

fn run_hook() {
    // **契機が付いていれば通知（#265）、無ければ申告（#299）。** stdin は分岐の前に
    // 読み切る: 読まずに終えると、書いている側（Claude Code）が EPIPE を受ける。
    let text = read_stdin();
    match flag_value(EVENT_FLAG)
        .as_deref()
        .and_then(NoticeKind::from_flag)
    {
        Some(kind) => notify_running_pike(kind),
        None => record_declaration(&text),
    }
}

fn read_stdin() -> String {
    let mut text = String::new();
    let _ = std::io::stdin().take(MAX_STDIN).read_to_string(&mut text);
    text
}

/// 走っている Pike へ「このターミナルのエージェントが入力を待っている」と伝える（#265）。
///
/// **Pike のターミナルの外で走った claude では何もしない**（`PIKE_PTY_ID` が無い）。
/// 通知の宛先はタブなので、どのタブか分からないものを届ける先が無い。
///
/// **Pike が走っていなくても何もしない**（`FindWindowW` が空振りする）。hook は
/// エージェントの起動元とは無関係に走りうるので、これは異常ではない。
fn notify_running_pike(kind: NoticeKind) {
    let Some(pty_id) = std::env::var("PIKE_PTY_ID")
        .ok()
        .filter(|v| !v.is_empty() && safe_flag_value(v))
    else {
        return;
    };
    // 送るのは受け側（`try_handle_notice`）が読むぶんだけ。**自分の argv をそのまま
    // 転送しない**: `--install-key=` は申告のためのもので、通知には要らない。
    let mut args = vec![
        std::env::args().next().unwrap_or_default(),
        SUBCOMMAND.to_string(),
        format!("{EVENT_FLAG}{}", kind.as_flag()),
        format!("{PTY_FLAG}{pty_id}"),
    ];
    // 名乗りは受け取ったものをそのまま回す（登録行に無ければ付けない＝受け側が
    // 古い行として Claude に落とす）。
    if let Some(agent) = flag_value(AGENT_FLAG) {
        args.push(format!("{AGENT_FLAG}{agent}"));
    }
    crate::wait::send_notice_to_first_instance(&args);
}

/// アカウントの申告を記録する（#299）。
fn record_declaration(text: &str) {
    let Ok(payload) = serde_json::from_str::<HookPayload>(text) else {
        return;
    };
    let (Some(transcript), Some(cwd)) = (payload.transcript_path, payload.cwd) else {
        return;
    };
    let Some(config_dir) = config_dir_from_transcript(&transcript) else {
        return;
    };
    if cwd.is_empty() {
        return;
    }
    record(
        AGENT_CLAUDE.as_str(),
        &cwd,
        &config_dir,
        flag_value(INSTALL_KEY_FLAG).unwrap_or_default(),
    );
}

/// 自分の argv から `--name=値` を取る。**長すぎる値と制御文字を含む値は無かったことに
/// する**（ファイルへ書く / 別プロセスへ渡すものなので、丈だけは見る）。
fn flag_value(prefix: &str) -> Option<String> {
    find_flag(std::env::args(), prefix)
}

/// 受け取った argv から `--name=値` を取る（`flag_value` の、自分以外の argv 版）。
fn find_flag(args: impl IntoIterator<Item = impl AsRef<str>>, prefix: &str) -> Option<String> {
    args.into_iter()
        .find_map(|a| a.as_ref().strip_prefix(prefix).map(str::to_string))
        .filter(|v| safe_flag_value(v))
}

/// そのまま回してよい値か。**フラグから来た値も環境変数から来た値も同じ述語を通す**:
/// どちらもファイルへ書く / 別プロセスへ渡すもので、片方だけ緩いと、緩いほうが
/// WM_COPYDATA に載って出て行く（`PIKE_PTY_ID` がまさにそれ）。
fn safe_flag_value(value: &str) -> bool {
    value.len() <= MAX_FLAG_VALUE && !value.contains(char::is_control)
}

// --- Pike 側（通知を受ける、#265） ---

/// hook からの通知だったら、そのターミナルを持つウィンドウへ届けて `true` を返す。
///
/// **形が違っても、サブコマンドが一致したら `true`。** `CliAction` のディスパッチへ
/// 流すと引数なしの `pike` と同じ扱いになり、**グローバルターミナルウィンドウが開く**
/// （#299 で一度書いて消したのと同じ形）。
///
/// **ウィンドウが見つからないのは普通に起きる**（タブを閉じた直後、別のインスタンスの
/// ターミナルから届いた）ので、黙って捨てる。
pub fn try_handle_notice(app: &tauri::AppHandle, args: &[String]) -> bool {
    if args.get(1).map(String::as_str) != Some(SUBCOMMAND) {
        return false;
    }
    if let Some(notice) = parse_notice(args) {
        emit_notice(app, notice);
    }
    true
}

fn parse_notice(args: &[String]) -> Option<AgentNotice> {
    Some(AgentNotice {
        pty_id: find_flag(args, PTY_FLAG)?,
        // **表に無い id は捨てる**（`AgentId::Unknown` になる）。無いときだけ Claude に
        // 落とすのは、この機能より前に登録された行が `--agent=` を持たないため。
        agent: match find_flag(args, AGENT_FLAG) {
            Some(v) => agent_from_flag(&v)?,
            None => AGENT_CLAUDE,
        },
        event: find_flag(args, EVENT_FLAG).and_then(|v| NoticeKind::from_flag(&v))?,
    })
}

/// 表にある id なら `AgentId`。`serde` の変換に通すので、綴りの正本は enum 側 1 つ。
fn agent_from_flag(value: &str) -> Option<AgentId> {
    let id: AgentId = serde_json::from_value(serde_json::Value::String(value.to_string())).ok()?;
    (id != AgentId::Unknown).then_some(id)
}

fn emit_notice(app: &tauri::AppHandle, notice: AgentNotice) {
    use tauri::{Emitter, Manager};
    let Some(state) = app.try_state::<crate::pty::PtyState>() else {
        return;
    };
    let Some(label) = crate::pty::window_for_pty(&state, &notice.pty_id) else {
        return;
    };
    // **そのウィンドウにだけ送る**（`emit` だと全ウィンドウが同じ通知を出す）。
    let _ = app.emit_to(label, "agent_notice", notice);
}

/// `<config dir>/projects/<slug>/<session_id>.jsonl` から設定ディレクトリを取り出す。
///
/// **`projects` の位置を確かめてから採る。** 3 つ上をそのまま返すと、記録の置き場が
/// 変わったときに無関係なディレクトリを設定ディレクトリとして覚えてしまう。
///
/// **`Path` を使わない。** 区切りの解釈はターゲット依存で、macOS / Linux では `\` が
/// ただの文字になる。Windows で走る Pike には WSL の `/home/...` と Windows の
/// `C:\Users\...` の両方が届くので、どちらの区切りも受ける必要がある（`Path` で
/// 書いていたときは、Windows パスのテストが macOS の CI でだけ落ちる形になっていた）。
fn config_dir_from_transcript(transcript: &str) -> Option<String> {
    let slug = parent_dir_of(transcript.trim_end_matches(['/', '\\']));
    let projects = parent_dir_of(slug);
    if file_name_of(projects) != "projects" {
        return None;
    }
    let dir = parent_dir_of(projects);
    (!dir.is_empty()).then(|| dir.to_string())
}

/// 申告を書き足す。同じ (agent, インストール, cwd) は差し替える。
fn record(agent: &str, cwd: &str, config_dir: &str, install: String) {
    let Some(path) = store_path() else {
        return;
    };
    let mut store = read_store(&path);
    store
        .entries
        .retain(|e| !(e.agent == agent && e.cwd == cwd && e.install == install));
    store.entries.push(Declaration {
        agent: agent.to_string(),
        cwd: cwd.to_string(),
        config_dir: config_dir.to_string(),
        install,
        at: epoch_secs(),
    });
    store.entries.sort_by_key(|e| std::cmp::Reverse(e.at));
    store.entries.truncate(MAX_ENTRIES);
    let _ = write_store(&path, &store);
}

/// 読めない・壊れているときは空。「読めなかった」と「1 件も無い」を呼び出し側が
/// 区別する意味が無いので、`Option` にしない。
fn read_store(path: &Path) -> Store {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_store(path: &Path, store: &Store) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    write_atomic(path, serde_json::to_vec_pretty(store)?)
}

/// 一時ファイルへ書いてから置き換える。**同時に何本も走りうる**（hook プロセスは
/// セッション開始のたびに立つ）ので、途中まで書かれたファイルを次の読み手に見せない。
/// read-modify-write の取りこぼしは、次のセッション開始で直る程度なので許容する。
///
/// 名前に pid を入れるのは、同時に走る hook 同士が同じ一時ファイルを掴まないため。
fn write_atomic(path: &Path, bytes: Vec<u8>) -> std::io::Result<()> {
    let tmp = path.with_extension(format!("pike-{}.tmp", std::process::id()));
    std::fs::write(&tmp, bytes)?;
    let result = std::fs::rename(&tmp, path);
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

// --- Pike 側（解決に使う） ---

/// 申告が最後に書かれた時刻。**`claude_usage::config` のキャッシュがこれを見て、
/// 期限内でも入力が変わっていれば解き直す。** 走行中の Pike へ「捨てろ」と伝える
/// IPC の代わりで、あちらの doc が判断の正本。
pub fn declarations_mtime() -> Option<SystemTime> {
    std::fs::metadata(store_path()?)
        .and_then(|m| m.modified())
        .ok()
}

/// そのプロジェクトについて最後に申告された設定ディレクトリ（native パス）。
///
/// **配下の申告も拾う**（`cwd_under_root`）。`cd src && claude` は普通の操作で、
/// そこで起動しても設定ディレクトリは同じものを見ている。
///
/// **実在の確認はしない。** 呼び出し側（`claude_usage::config`）が `.envrc` 由来の
/// 値と同じ検証（そのシェルから読めるディレクトリか）に通すので、ここで先に
/// 落とすと「申告はあるが読めない」ときに `.envrc` へ落ちる経路が 2 箇所に散る。
///
/// **キャッシュしない。** 読むのは `resolve` が miss したときだけで、あちらが払う
/// もの（WSL の対話ログインシェル、UNC 越しの `.claude.json`）に比べれば、この
/// 数 KB の JSON を読み直すコストは誤差。
pub fn declared_config_dir(shell: &ShellConfig, project_root: &str) -> Option<String> {
    let path = store_path()?;
    let install = crate::types::install_key(shell);
    read_store(&path)
        .entries
        .into_iter()
        .filter(|e| matches_project(e, &install, shell, project_root))
        .max_by_key(|e| e.at)
        .map(|e| e.config_dir)
}

/// その申告がこのシェル・このプロジェクトのものか。
///
/// `install` を持たない古い申告は、インストールを問わず cwd だけで突き合わせる。
fn matches_project(
    e: &Declaration,
    install: &str,
    shell: &ShellConfig,
    project_root: &str,
) -> bool {
    e.agent == AGENT_CLAUDE.as_str()
        && e.install == install
        && cwd_under_root(shell, &e.cwd, project_root)
}

/// そのプロジェクトについての申告を捨てる。捨てたら `true`。
///
/// **要る理由は、申告が `.envrc` とシェルの環境変数より優先されるから。** hook を
/// 入れていないアカウントへ起動ラッパーを切り替えると、新しい申告は来ないので、
/// 古い申告がそのプロジェクトを恒久的に古いアカウントへ縛る（しかも、この機能が
/// 入る前は正しく答えていた 2 つの経路まで上書きする）。設定画面の「受け取った値」
/// を捨てるボタンと、hook を外したときの後始末がここを通る。
pub fn forget_declarations(shell: &ShellConfig, project_root: &str) -> bool {
    let Some(path) = store_path() else {
        return false;
    };
    let install = crate::types::install_key(shell);
    let mut store = read_store(&path);
    let before = store.entries.len();
    store
        .entries
        .retain(|e| !matches_project(e, &install, shell, project_root));
    if store.entries.len() == before {
        return false;
    }
    write_store(&path, &store).is_ok()
}

// --- hook の登録（設定画面から） ---

/// 登録先の `settings.json` のファイル名。Claude Code 自身も書き戻すファイルなので、
/// 丸ごと置き換えず `hooks` キーだけを足す。
const SETTINGS_FILE: &str = "settings.json";

/// hook の待ち時間（秒）。既定の 600 秒は起動フックには長すぎるので明示する。
/// Pike 側はファイルを 1 つ書く / メッセージを 1 通投げるだけなので、これに当たるのは
/// 何かがおかしいとき。
const HOOK_TIMEOUT_SECS: u64 = 10;

/// 登録する hook 1 つ。
struct HookSpec {
    /// `hooks` 直下のイベント名。
    event: &'static str,
    /// 絞り込み。`None` はそのイベントの全部で発火する。
    matcher: Option<&'static str>,
    /// コマンド行に書く契機。**`None` は申告（#299）の行**で、この違いがそのまま
    /// 「通知の hook か」を意味する（`windows_only`）。
    kind: Option<NoticeKind>,
}

impl HookSpec {
    /// 配送が WM_COPYDATA なので、通知の hook は Windows でだけ登録する（#265）。
    /// **届かない hook を利用者の `settings.json` に書かない**のが目的。
    ///
    /// **真偽のフィールドで持たない。** 「契機を持つ＝通知＝Windows 限定」は構造上の
    /// 同値なので、別々に書けるようにすると `kind: Some(..)` と `windows_only: false` の
    /// 組み合わせが書けてしまい、非 Windows で**何もしない hook を登録して終わる**。
    fn windows_only(&self) -> bool {
        self.kind.is_some()
    }

    /// この hook を呼ぶコマンド行（`hook_command` の基本行に契機を足したもの）。
    fn command(&self, base: &str) -> String {
        match self.kind {
            Some(kind) => format!("{base} {EVENT_FLAG}{}", kind.as_flag()),
            None => base.to_string(),
        }
    }
}

/// Pike が登録する hook。**足すときはここに 1 行**（判定・登録・削除の 3 つが同じ表を回る）。
const HOOKS: &[HookSpec] = &[
    // アカウントの申告（#299）。**matcher は付けない**: `SessionStart` の matcher
    // （`startup` / `resume` / `clear` / `compact` / `fork`）は絞り込みで、省略すると
    // 全部で発火する。申告は冪等なので、どの入口から始まったセッションでも受けてよい。
    HookSpec {
        event: "SessionStart",
        matcher: None,
        kind: None,
    },
    // 入力待ち（#265）。**12 個ある matcher のうち待っているものだけ**を拾う。残りは
    // 認証や quota の知らせ（`auth_success` / `quota_auto_resume_*` 等）で、見に行っても
    // 待っているものが無い。
    HookSpec {
        event: "Notification",
        matcher: Some("permission_prompt|idle_prompt|agent_needs_input|elicitation_dialog"),
        kind: Some(NoticeKind::Waiting),
    },
    // ターンの完了（#265）。`Stop` は matcher を持たない。
    HookSpec {
        event: "Stop",
        matcher: None,
        kind: Some(NoticeKind::Done),
    },
];

/// このマシンで登録する hook。
///
/// **設定（`agentNotify`）では絞らない。** 通知を出すかはフロントの持ち物で、切り替える
/// たびに `settings.json` を書き換えると、(1) 設定を変えるだけで他人も読むファイルが
/// 動く、(2) 「登録済み」の意味が設定によって変わる。off のあいだ hook プロセスが立つ
/// コストは、ファイルを 1 つも書かずに終わるぶんミリ秒で済む。
fn installable_hooks() -> impl Iterator<Item = &'static HookSpec> {
    HOOKS
        .iter()
        .filter(|spec| !spec.windows_only() || cfg!(windows))
}

/// 登録できる設定ディレクトリ 1 つ。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookTarget {
    /// そのシェルから見たパス（native）。表示と、`install` の宛先の指定に使う。
    pub config_dir: String,
    /// 書き込む `settings.json`（Pike から読めるパス。WSL なら UNC）。
    pub settings_path: String,
    /// このマシンで登録する hook が**全部**入っているか（`has_hook`）。
    pub registered: bool,
    /// Pike の行が**1 本でもある**か（#265）。**削除の導線はこちらで出す。** `registered`
    /// で出していると、#299 の版が書いた `SessionStart` だけのファイルは「未登録」に
    /// なるので、**一度「登録」を押して 3 本にしないと消せない**（`remove_hook` の doc に
    /// ある「古い行が UI から消せない」の再発）。
    pub has_any: bool,
    /// 今の解決結果がこのディレクトリを指しているか（表示の目印）。
    pub active: bool,
    /// このディレクトリを使うインストール（`types::install_key`）。**宛先ごとに違う**
    /// ので、install / uninstall はこれを受けて、そのシェル向けのコマンド行を組む。
    pub install_key: String,
    /// この宛先に書く（書いた）コマンド行。シェルによって違う（WSL は `/mnt/c/...`）。
    pub command: String,
}

/// 設定画面に出す、hook の登録の状態。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStatus {
    /// 登録できる設定ディレクトリ。**アカウントごと・シェルごとにある**。
    pub targets: Vec<HookTarget>,
    /// このプロジェクトについて最後に申告された設定ディレクトリ。hook が実際に
    /// 届いているかは、登録の有無ではなくこれで分かる。
    pub declared: Option<String>,
}

/// hook に書くコマンド行。
///
/// **exec 形式（`args` を分けて渡す形）は使わない。** その形を知らない版の Claude
/// Code に当たると `args` が落ちて `pike.exe` だけが走り、**引数なしの pike ＝
/// グローバルターミナルウィンドウ**が開く。1 文字列のシェル形式ならどの版でも
/// 同じ意味になる。
///
/// Windows と WSL はどちらも `pike.exe`（インストーラがユーザー PATH に置き、WSL は
/// Windows の PATH を継ぐ）。macOS には PATH に載る CLI が無いので、今動いている
/// 実行ファイルの絶対パスを書く。
fn hook_command(shell: &ShellConfig) -> String {
    // macOS には PATH に載る CLI が無い（インストーラが PATH を足すのは Windows
    // だけ）ので、常に自分自身の絶対パスを書く。
    //
    // Windows / WSL の開発ビルドも同じにする。**PATH の `pike.exe` はインストール版**
    // なので、開発中の変更を確かめられないため。申告の置き場は共有している
    // （`STORE_IDENTIFIER`）ので、どちらが走っても両方が受け取れる。
    //
    // **通知（#265）はここが共有にならない。** `send_to_first_instance` が探すのは
    // `app_identifier()` のウィンドウで、これは `cfg!(debug_assertions)` で分かれる。
    // つまり開発ビルドで登録した行は、インストール版しか走っていないときには何も
    // 届かない（申告のほうはファイル越しなので届く）。使う側のビルドで登録し直す。
    let own = matches!(shell, ShellConfig::Unix { .. }) || cfg!(debug_assertions);
    let program = own
        .then(|| current_exe_for(shell))
        .flatten()
        .unwrap_or_else(|| "pike.exe".to_string());
    // どのインストールの hook かを載せる（`Declaration::install`）。hook プロセスは
    // 自分がどの distro の中から呼ばれたかを知らないので、ここで書いておく。
    // エージェントも同じく、受け側で決め打ちにしない（`AGENT_FLAG`）。
    format!(
        "{program} {SUBCOMMAND} {INSTALL_KEY_FLAG}{} {AGENT_FLAG}{}",
        crate::types::install_key(shell),
        AGENT_CLAUDE.as_str()
    )
}

/// 今動いている実行ファイルを、そのシェルから起動できる形にする。
fn current_exe_for(shell: &ShellConfig) -> Option<String> {
    let exe = std::env::current_exe().ok()?.to_string_lossy().into_owned();
    Some(match shell {
        ShellConfig::Wsl { .. } => bash_quote(&windows_to_mnt(&exe)?),
        ShellConfig::Unix { .. } => bash_quote(&exe),
        // **バックスラッシュを残さない。** Windows で hook を走らせるのは Claude Code
        // 自身が選んだシェルで、既定は Git Bash。そこへ `C:\Users\...` を裸で渡すと
        // `\` がエスケープとして食われ、`C:Userskanfu...: command not found` になる
        // （実際に踏んだ）。スラッシュに直せば Windows API がそのまま解決するので、
        // Git Bash・cmd・PowerShell のどれでも通る（Git Bash で実測）。
        //
        // 引用符は空白があるときだけ。常に囲むと、PowerShell が引用符で始まる行を
        // 文字列式として評価してしまい（実行には `&` が要る）、何も起きなくなる。
        _ => {
            let slashed = exe.replace('\\', "/");
            if slashed.contains(' ') {
                format!("\"{slashed}\"")
            } else {
                slashed
            }
        }
    })
}

/// `C:\a\b` → `/mnt/c/a/b`。WSL の既定の自動マウントを前提にする。**当てにできない
/// ときは `None`**（UNC 上の実行ファイルなど）で、呼び出し側は PATH 頼みに落ちる。
fn windows_to_mnt(path: &str) -> Option<String> {
    let (drive, rest) = path.split_once(":\\")?;
    let mut chars = drive.chars();
    let letter = chars.next().filter(|c| c.is_ascii_alphabetic())?;
    if chars.next().is_some() {
        return None;
    }
    Some(format!(
        "/mnt/{}/{}",
        letter.to_ascii_lowercase(),
        rest.replace('\\', "/")
    ))
}

/// `hooks.<event>` の各コマンド行を舐める。
fn hook_commands<'a>(
    settings: &'a serde_json::Value,
    event: &'static str,
) -> impl Iterator<Item = &'a str> {
    settings
        .get("hooks")
        .and_then(|h| h.get(event))
        .and_then(|s| s.as_array())
        .into_iter()
        .flatten()
        .filter_map(|g| g.get("hooks")?.as_array())
        .flatten()
        .filter_map(|h| h.get("command")?.as_str())
}

/// その行がこの hook のものか。
///
/// **見るのはサブコマンドと契機だけ**（コマンド行の一致ではない）。申告の置き場を
/// ビルドで分けない（`STORE_IDENTIFIER`）ので、**どのビルドが書いた 1 行でも両方が
/// 受け取れる**。一致で見ていたころは、パスの綴りが変わっただけで「未登録」に化け、
/// 古い行が UI から消せなくなった。
///
/// 代償は、利用者が別のラッパー越しに呼ぶ形へ書き換えても「登録済み」と見えること。
/// 実際に走るのは利用者が書いた行なので、それで正しい。
///
/// **同じイベントの中では契機まで見る。** 1 つのイベントに 2 つの契機を載せる日
/// （`Notification` の `agent_completed` を完了として足す等）に、片方しか無い状態を
/// 「登録済み」と誤らないため。
fn matches_spec(command: &str, spec: &HookSpec) -> bool {
    is_pike_command(command)
        && match spec.kind {
            Some(kind) => command.contains(&format!("{EVENT_FLAG}{}", kind.as_flag())),
            None => !command.contains(EVENT_FLAG),
        }
}

/// Pike が足した行か。**`has_any_hook` と `remove_from_event` が同じ述語を読む**ので、
/// 削除ボタンを出す条件と、実際に消える範囲が食い違わない。
fn is_pike_command(command: &str) -> bool {
    command.contains(SUBCOMMAND)
}

fn has_spec(settings: &serde_json::Value, spec: &HookSpec) -> bool {
    hook_commands(settings, spec.event).any(|c| matches_spec(c, spec))
}

/// このマシンで登録する hook が**全部**入っているか。
///
/// **「1 つでもあるか」ではない（#265）。** #299 の版は `SessionStart` しか書かないので、
/// 緩く見ると通知の 2 つが永久に入らないまま「登録済み」と出る。全部揃って初めて
/// 登録済みとすれば、足りないぶんは登録ボタン 1 回で足される（`ensure_hook` は足りない
/// ものだけ足すので、既にある行は動かない）。
fn has_hook(settings: &serde_json::Value) -> bool {
    installable_hooks().all(|spec| has_spec(settings, spec))
}

/// Pike の行が 1 本でもあるか。**契機も `windows_only` も見ない**（`remove_hook` と同じ
/// 広さ）。これで消せる対象と、削除ボタンを出す条件が一致する。
fn has_any_hook(settings: &serde_json::Value) -> bool {
    HOOKS
        .iter()
        .any(|spec| hook_commands(settings, spec.event).any(is_pike_command))
}

/// 足りない hook を足す。全部入っていれば `false`（書かない）。
fn ensure_hook(settings: &mut serde_json::Value, command: &str) -> bool {
    let missing: Vec<&HookSpec> = installable_hooks()
        .filter(|spec| !has_spec(settings, spec))
        .collect();
    if missing.is_empty() {
        return false;
    }
    if !settings.is_object() {
        *settings = serde_json::json!({});
    }
    for spec in missing {
        add_hook(settings, spec, command);
    }
    true
}

/// `hooks.<event>` へ 1 グループ足す。契機は**コマンド行に書く**（`EVENT_FLAG` の doc）。
fn add_hook(settings: &mut serde_json::Value, spec: &HookSpec, command: &str) {
    let command = spec.command(command);
    let entries = serde_json::json!([{ "type": "command", "command": command, "timeout": HOOK_TIMEOUT_SECS }]);
    let entry = match spec.matcher {
        Some(matcher) => serde_json::json!({ "matcher": matcher, "hooks": entries }),
        None => serde_json::json!({ "hooks": entries }),
    };
    let hooks = settings
        .as_object_mut()
        .expect("object")
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));
    if !hooks.is_object() {
        *hooks = serde_json::json!({});
    }
    let events = hooks
        .as_object_mut()
        .expect("object")
        .entry(spec.event)
        .or_insert_with(|| serde_json::json!([]));
    match events.as_array_mut() {
        Some(groups) => groups.push(entry),
        // 配列でない値が入っていたら、読めない設定として作り直す（そのままでは
        // Claude Code 自身も読めない）。
        None => *events = serde_json::json!([entry]),
    }
}

/// Pike が足した hook を全部取り除く。消したら `true`。
///
/// **`has_hook` と同じ緩い一致**（サブコマンドを含む行）。要るのは、開発ビルドが書いた
/// 絶対パスが `target/debug` を消した時点で死んだ行になるため（hook が発火するたびに
/// Claude Code のトランスクリプトへエラーが出る）。コマンド行の一致で消していたころは、
/// **パスの綴りを直しただけで古い行に手が届かなくなった**。
///
/// **契機は見ない**（`matches_spec` と違うのはここだけ）。外すのは「Pike の hook を
/// やめる」操作なので、`--event=` の値が何であれ全部消す。**`windows_only` も見ない**:
/// 同じ設定ディレクトリを別の OS の Pike が触っていた可能性があるので、消す側は広く取る。
///
/// **空になった入れ物は畳む。** 足す前の形へ戻すのが目的で、`"SessionStart": []` や
/// `"hooks": {}` を残すと、Pike が触ったことが利用者のファイルに残り続ける。
fn remove_hook(settings: &mut serde_json::Value) -> bool {
    let mut removed = false;
    for spec in HOOKS {
        removed |= remove_from_event(settings, spec.event);
    }
    if settings
        .get("hooks")
        .and_then(|h| h.as_object())
        .is_some_and(|h| h.is_empty())
    {
        settings
            .as_object_mut()
            .expect("object")
            .shift_remove("hooks");
    }
    removed
}

fn remove_from_event(settings: &mut serde_json::Value, event: &str) -> bool {
    let Some(hooks) = settings.get_mut("hooks").and_then(|h| h.as_object_mut()) else {
        return false;
    };
    let Some(groups) = hooks.get_mut(event).and_then(|s| s.as_array_mut()) else {
        return false;
    };
    let mut removed = false;
    // 空になったグループを落とすのは**この呼び出しで空にしたときだけ**。元から
    // 空のグループは利用者が置いたものかもしれないので、そのまま残す。
    groups.retain_mut(|group| {
        let Some(entries) = group.get_mut("hooks").and_then(|h| h.as_array_mut()) else {
            return true;
        };
        let len = entries.len();
        entries.retain(|h| {
            !h.get("command")
                .and_then(|c| c.as_str())
                .is_some_and(is_pike_command)
        });
        let changed = entries.len() != len;
        removed |= changed;
        !(changed && entries.is_empty())
    });
    // **`remove` を使わないこと。** `preserve_order` 有効時のあれは `swap_remove` で、
    // 末尾のキーを削除位置へ動かす＝この feature を入れた理由（利用者のファイルの
    // キー順を保つ）を自分で壊す。
    //
    // 何も消していなければ `groups` は縮まないので、空なら元から空（触らない）。
    if groups.is_empty() && removed {
        hooks.shift_remove(event);
    }
    removed
}

fn settings_path(config_dir: &Path) -> PathBuf {
    config_dir.join(SETTINGS_FILE)
}

fn read_settings(path: &Path) -> Result<serde_json::Value, String> {
    match std::fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(serde_json::json!({})),
        Ok(text) => {
            serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.to_string_lossy()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
        Err(e) => Err(format!("{}: {e}", path.to_string_lossy())),
    }
}

/// ホームの直下で Claude Code の設定ディレクトリらしいものの名前か。
///
/// `CLAUDE_CONFIG_DIR` はどこでも指せるので、これは**候補を挙げるための当て推量**。
/// 中身で確かめる（`settings.json` / `projects` / `.claude.json` のどれかがある）ので、
/// 名前が似ているだけの空ディレクトリは挙げない。
fn looks_like_config_dir(read_path: &Path, name: &str) -> bool {
    name.starts_with(".claude")
        && ["settings.json", "projects", ".claude.json"]
            .iter()
            .any(|f| read_path.join(f).exists())
}

/// そのシェルから見える設定ディレクトリの候補（native パス, Pike から読めるパス）。
///
/// **1 つに絞らない。** 解決結果だけを宛先にすると、まだ何も申告が届いていないあいだは
/// 既定の `~/.claude` しか出てこない。実際に使っているのが `~/.claude-ai` なら、そこへ
/// hook が入らないまま「登録済み」に見えて、申告は永久に届かない（ニワトリと卵）。
/// アカウントごとに 1 つ登録する必要がある、というのは #299 の前提でもある。
fn candidate_dirs(shell: &ShellConfig) -> Vec<(String, PathBuf)> {
    // ホームの解決（distro の中か、ホスト自身か）と UNC 化は `claude_usage::config` の
    // 持ち物。解決経路とここで別々に書くと、規則を変えたとき片方だけが直る。
    let Some((home_native, home_read)) = crate::claude_usage::config::shell_home(shell) else {
        return Vec::new();
    };
    let sep = if shell.is_posix() { '/' } else { '\\' };
    let mut dirs: Vec<(String, PathBuf)> = std::fs::read_dir(&home_read)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_string();
            let read = e.path();
            looks_like_config_dir(&read, &name).then(|| {
                (
                    format!("{}{sep}{name}", home_native.trim_end_matches(sep)),
                    read,
                )
            })
        })
        .collect();
    dirs.sort_by(|a, b| a.0.cmp(&b.0));
    dirs
}

/// 候補を挙げるシェルの一覧。
///
/// **プロジェクトのシェルに絞らない。** hook はアカウント（設定ディレクトリ）ごとに
/// 持つもので、そこはマシン全体の話。Windows プロジェクトを開いているからといって
/// WSL の `~/.claude` を隠すと、**WSL で claude を使っている人が登録できない**
/// （Windows のパスしか出ない、という形で実際に出た）。
///
/// `distros` はフロントが渡す（設定タブは既に検出している）。ここで `wsl.exe` を
/// 起こさないのは、設定タブを開くたびに 1 本増やさないため。
fn shells_for_targets(project_shell: &ShellConfig, distros: &[String]) -> Vec<ShellConfig> {
    let mut shells = vec![ShellConfig::host_default()];
    shells.extend(
        distros
            .iter()
            .filter(|d| !d.is_empty())
            .map(|d| ShellConfig::Wsl { distro: d.clone() }),
    );
    // プロジェクトのシェルが一覧に無い（distro の検出が間に合っていない等）なら足す。
    if !shells
        .iter()
        .any(|s| crate::types::install_key(s) == crate::types::install_key(project_shell))
    {
        shells.push(project_shell.clone());
    }
    shells
}

fn status_for(shell: &ShellConfig, project_root: &str, distros: &[String]) -> HookStatus {
    let config = crate::claude_usage::config::resolve(shell, project_root);
    let mut targets: Vec<HookTarget> = Vec::new();
    for target_shell in shells_for_targets(shell, distros) {
        let mut dirs = candidate_dirs(&target_shell);
        // 解決結果がホームの外を指している（`CLAUDE_CONFIG_DIR` は任意の場所を指せる）
        // ときのために、一覧に無ければ足す。プロジェクトのシェルでしか解決していない
        // ので、その腕でだけ効く。
        if crate::types::install_key(&target_shell) == crate::types::install_key(shell) {
            if let Some(read) = config.read_path.as_deref() {
                if !dirs.iter().any(|(_, p)| p == read) {
                    let native = config
                        .native_override
                        .clone()
                        .unwrap_or_else(|| read.to_string_lossy().into_owned());
                    dirs.insert(0, (native, read.to_path_buf()));
                }
            }
        }
        let command = hook_command(&target_shell);
        let install_key = crate::types::install_key(&target_shell);
        targets.extend(dirs.into_iter().map(|(native, read)| {
            let path = settings_path(&read);
            // 読むのは 1 回（`settings.json` は候補の数だけ開く）。
            let settings = read_settings(&path).ok();
            HookTarget {
                registered: settings.as_ref().is_some_and(has_hook),
                has_any: settings.as_ref().is_some_and(has_any_hook),
                settings_path: path.to_string_lossy().into_owned(),
                active: config.read_path.as_deref() == Some(read.as_path()),
                config_dir: native,
                install_key: install_key.clone(),
                command: command.clone(),
            }
        }));
    }
    HookStatus {
        targets,
        declared: declared_config_dir(shell, project_root),
    }
}

/// 3 つのコマンドはどれも**ブロッキング**（`resolve` は WSL では対話ログインシェルを
/// 起こし、候補の列挙は UNC 越しの `read_dir`、書き込みはファイル I/O）なので、
/// `spawn_blocking` に逃がす（`rust.md`）。
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn agent_hook_status(
    shell: ShellConfig,
    project_root: String,
    distros: Vec<String>,
) -> Result<HookStatus, String> {
    blocking(move || Ok(status_for(&shell, &project_root, &distros))).await
}

/// そのプロジェクトについて受け取った申告を捨て、解決を推測（`.envrc` → シェルの
/// 環境変数 → 既定）へ戻す。
#[tauri::command]
pub async fn agent_hook_forget(
    shell: ShellConfig,
    project_root: String,
    distros: Vec<String>,
) -> Result<HookStatus, String> {
    blocking(move || {
        forget_declarations(&shell, &project_root);
        Ok(status_for(&shell, &project_root, &distros))
    })
    .await
}

/// `install_key` からシェルを戻す。**Windows の 4 つ（cmd / PowerShell / pwsh /
/// Git Bash）は区別しない**: どれも同じホームと同じ `pike.exe` を見るので、hook の
/// 登録先とコマンド行は変わらない。
///
/// 外から来た文字列なので、distro の検証は `types::shell_from_id` に通す（受けない
/// 値はホストの既定へ落ちるが、その先の宛先の照合で弾かれる）。
fn shell_from_install_key(key: &str) -> ShellConfig {
    crate::types::shell_from_id(key).unwrap_or_else(ShellConfig::host_default)
}

/// 宛先の `settings.json` を書き換える。
///
/// **宛先は候補の中からしか受けない。** 引数の文字列をそのままパスとして開くと、
/// IPC を投げられる誰でも任意の JSON ファイルを書き換えられる。**照合に `status_for` を
/// 通さないこと**: あちらは `resolve`（WSL では対話ログインシェル）と候補ぶんの
/// `settings.json` 読みを伴うので、宛先を確かめるためだけに払うには高すぎる。
fn edit_settings(
    target_shell: &ShellConfig,
    config_dir: &str,
    edit: impl FnOnce(&mut serde_json::Value, &str) -> bool,
) -> Result<(), String> {
    let path = candidate_dirs(target_shell)
        .into_iter()
        .find(|(native, _)| native == config_dir)
        .map(|(_, read)| settings_path(&read))
        .ok_or_else(|| format!("unknown config dir: {config_dir}"))?;
    let mut settings = read_settings(&path)?;
    if edit(&mut settings, &hook_command(target_shell)) {
        let mut bytes = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        // Claude Code が同じファイルを書き戻すので、途中まで書かれた状態を見せない。
        write_atomic(&path, bytes).map_err(|e| format!("{}: {e}", path.to_string_lossy()))?;
    }
    Ok(())
}

/// 指定した設定ディレクトリの `settings.json` へ hook を足す。
///
/// `install_key` は**宛先のシェル**（`HookTarget::install_key`）。プロジェクトの
/// シェルとは限らない: Windows のプロジェクトを開いたまま WSL のアカウントへ
/// 登録できる。
#[tauri::command]
pub async fn agent_hook_install(
    shell: ShellConfig,
    project_root: String,
    distros: Vec<String>,
    config_dir: String,
    install_key: String,
) -> Result<HookStatus, String> {
    blocking(move || {
        edit_settings(
            &shell_from_install_key(&install_key),
            &config_dir,
            ensure_hook,
        )?;
        Ok(status_for(&shell, &project_root, &distros))
    })
    .await
}

/// 未登録の候補すべてへまとめて登録する。起動時の提案（1 回きり）が使う。
///
/// **1 回の IPC にまとめる。** フロントから候補の数だけ `agent_hook_install` を呼ぶと、
/// そのたびに `status_for`（`resolve` ＋ 候補ぶんの `settings.json` 読み）が走る。
///
/// **1 つでも書ければ成功にする。** 片方の設定ディレクトリが読めない（WSL が止まって
/// いる等）ときに全部を巻き戻すより、書けたぶんを残すほうが利用者の意図に近い。
/// 何も書けなかったときだけ、最初の理由を返す。
#[tauri::command]
pub async fn agent_hook_install_missing(
    shell: ShellConfig,
    project_root: String,
    distros: Vec<String>,
) -> Result<HookStatus, String> {
    blocking(move || {
        let missing: Vec<(String, String)> = status_for(&shell, &project_root, &distros)
            .targets
            .into_iter()
            .filter(|t| !t.registered)
            .map(|t| (t.config_dir, t.install_key))
            .collect();
        let mut wrote = false;
        let mut first_error: Option<String> = None;
        for (config_dir, install_key) in missing {
            match edit_settings(
                &shell_from_install_key(&install_key),
                &config_dir,
                ensure_hook,
            ) {
                Ok(()) => wrote = true,
                Err(e) => {
                    first_error.get_or_insert(e);
                }
            }
        }
        match first_error {
            Some(e) if !wrote => Err(e),
            _ => Ok(status_for(&shell, &project_root, &distros)),
        }
    })
    .await
}

/// 足した hook を取り除く。**消すのはこのビルドが書いた行だけ**（`has_hook` と
/// 同じ一致の見方）で、隣に並ぶもう一方のビルドの行や、利用者が置いた hook は残る。
///
/// **受け取った申告も一緒に捨てる。** hook を外したのに申告だけ残ると、そのプロジェクトは
/// 以後も申告された設定ディレクトリに縛られ、`.envrc` とシェルの環境変数が効かない。
#[tauri::command]
pub async fn agent_hook_uninstall(
    shell: ShellConfig,
    project_root: String,
    distros: Vec<String>,
    config_dir: String,
    install_key: String,
) -> Result<HookStatus, String> {
    blocking(move || {
        edit_settings(
            &shell_from_install_key(&install_key),
            &config_dir,
            |s, _| remove_hook(s),
        )?;
        forget_declarations(&shell, &project_root);
        Ok(status_for(&shell, &project_root, &distros))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ShellConfig;

    #[test]
    fn takes_the_config_dir_from_a_transcript_path() {
        assert_eq!(
            config_dir_from_transcript(
                "/home/kan/.claude-ai/projects/-home-kan-dotfiles/2a6039dc.jsonl"
            )
            .as_deref(),
            Some("/home/kan/.claude-ai")
        );
        assert_eq!(
            config_dir_from_transcript(
                r"C:\Users\kanfu\.claude\projects\C--Users-kanfu-pike\abc.jsonl"
            )
            .as_deref(),
            Some(r"C:\Users\kanfu\.claude")
        );
    }

    /// 記録の置き場が変わったら、無関係なディレクトリを覚えるより何も覚えないほうがよい。
    #[test]
    fn ignores_a_transcript_path_that_is_not_under_projects() {
        assert_eq!(
            config_dir_from_transcript("/home/kan/.claude/sessions/foo/abc.jsonl"),
            None
        );
        assert_eq!(config_dir_from_transcript("abc.jsonl"), None);
    }

    /// 既存のキーを残したまま `hooks.SessionStart` に足す。2 回目は書かない。
    #[test]
    fn adds_the_hook_without_touching_the_rest() {
        let mut settings = serde_json::json!({ "theme": "dark" });
        assert!(ensure_hook(&mut settings, "pike.exe agent-hook"));
        assert_eq!(settings["theme"], "dark");
        assert!(has_hook(&settings));
        assert_eq!(
            settings["hooks"]["SessionStart"].as_array().unwrap().len(),
            1
        );
        assert_eq!(
            settings["hooks"]["SessionStart"][0]["hooks"][0]["command"],
            "pike.exe agent-hook"
        );

        assert!(!ensure_hook(&mut settings, "pike.exe agent-hook"));
        assert_eq!(
            settings["hooks"]["SessionStart"].as_array().unwrap().len(),
            1
        );
    }

    /// 他の hook が既に登録されているファイルでも、その隣に足す。
    #[test]
    fn keeps_existing_hooks() {
        let mut settings = serde_json::json!({
            "hooks": {
                "SessionStart": [{ "hooks": [{ "type": "command", "command": "echo hi" }] }],
                "PreToolUse": [{ "matcher": "Bash", "hooks": [] }]
            }
        });
        assert!(ensure_hook(&mut settings, "pike.exe agent-hook"));
        let groups = settings["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0]["hooks"][0]["command"], "echo hi");
        assert!(settings["hooks"]["PreToolUse"].is_array());
    }

    /// 通知の hook（#265）は matcher と契機を持ち、申告の行と混ざらない。
    #[cfg(windows)]
    #[test]
    fn registers_the_notice_hooks_with_a_matcher_and_an_event_flag() {
        let mut settings = serde_json::json!({});
        assert!(ensure_hook(&mut settings, "pike.exe agent-hook"));

        let notification = &settings["hooks"]["Notification"][0];
        assert!(notification["matcher"]
            .as_str()
            .unwrap()
            .contains("permission_prompt"));
        assert_eq!(
            notification["hooks"][0]["command"],
            "pike.exe agent-hook --event=waiting"
        );
        assert_eq!(
            settings["hooks"]["Stop"][0]["hooks"][0]["command"],
            "pike.exe agent-hook --event=done"
        );
        // `Stop` は matcher を持たない（Claude Code 側の仕様）。
        assert!(settings["hooks"]["Stop"][0].get("matcher").is_none());
        // 申告の行は契機を持たないまま。
        assert_eq!(
            settings["hooks"]["SessionStart"][0]["hooks"][0]["command"],
            "pike.exe agent-hook"
        );
    }

    /// #299 の版が書いた `SessionStart` だけの設定は「登録済み」ではない（#265）。
    /// 登録ボタン 1 回で足りない 2 つだけが足され、既にある行は動かない。
    #[cfg(windows)]
    #[test]
    fn treats_a_session_start_only_file_as_incomplete() {
        let mut settings = serde_json::json!({
            "hooks": {
                "SessionStart": [{ "hooks": [{ "type": "command", "command": "pike.exe agent-hook" }] }]
            }
        });
        assert!(!has_hook(&settings));

        assert!(ensure_hook(
            &mut settings,
            "pike.exe agent-hook --install-key=windows"
        ));
        assert!(has_hook(&settings));
        // 足りない 2 つだけ。元の行はそのまま（`--install-key` を持たないまま）。
        let groups = settings["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0]["hooks"][0]["command"], "pike.exe agent-hook");
        assert!(settings["hooks"]["Notification"].is_array());
        assert!(settings["hooks"]["Stop"].is_array());
    }

    /// 通知の argv から届け先が決まる。契機か pty id が欠けたら何も送らない。
    #[test]
    fn parses_a_notice_from_the_forwarded_argv() {
        let args = |rest: &[&str]| {
            let mut v = vec!["pike.exe".to_string(), "agent-hook".to_string()];
            v.extend(rest.iter().map(|s| s.to_string()));
            v
        };
        let notice =
            parse_notice(&args(&["--event=waiting", "--pty=abc", "--agent=claude"])).unwrap();
        assert_eq!(notice.pty_id, "abc");
        assert_eq!(notice.event, NoticeKind::Waiting);
        assert_eq!(notice.agent, AgentId::Claude);

        assert_eq!(
            parse_notice(&args(&["--event=done", "--pty=abc"]))
                .unwrap()
                .event,
            NoticeKind::Done
        );
        // 名乗りが無いのは、この機能より前に登録された行（Claude のものしかない）。
        assert_eq!(
            parse_notice(&args(&["--event=done", "--pty=abc"]))
                .unwrap()
                .agent,
            AgentId::Claude
        );
        // 知らない契機・欠けた pty id・申告の行（契機なし）・表に無いエージェントは
        // 届け先にならない。
        assert!(parse_notice(&args(&["--event=nope", "--pty=abc"])).is_none());
        assert!(parse_notice(&args(&["--event=waiting"])).is_none());
        assert!(parse_notice(&args(&["--install-key=windows"])).is_none());
        assert!(parse_notice(&args(&["--event=waiting", "--pty=abc", "--agent=nope"])).is_none());
    }

    /// **どのビルドが書いた行でも 1 本で足りる**（申告の置き場を共有するため）。
    /// 別のパスで登録済みなら足さず、消すときは綴りが違っても手が届く。
    #[test]
    fn recognizes_a_hook_written_by_another_build() {
        let dev =
            "C:/Users/kan/pike/src-tauri/target/debug/pike.exe agent-hook --install-key=windows";
        let mut settings = serde_json::json!({});
        assert!(ensure_hook(&mut settings, dev));

        // インストール版から見ても「登録済み」で、二重に足さない。
        assert!(has_hook(&settings));
        assert!(!ensure_hook(
            &mut settings,
            "pike.exe agent-hook --install-key=windows"
        ));
        assert_eq!(
            settings["hooks"]["SessionStart"].as_array().unwrap().len(),
            1
        );

        // 綴りの違う行にも手が届く（パス表記を直した版から古い行を消せる）。
        assert!(remove_hook(&mut settings));
        assert!(!has_hook(&settings));
    }

    /// 足す前の形に戻す（`"SessionStart": []` のような抜け殻を残さない）。
    #[test]
    fn removing_the_last_hook_restores_the_file() {
        let mut settings = serde_json::json!({ "theme": "dark" });
        assert!(ensure_hook(&mut settings, "pike.exe agent-hook"));
        assert!(remove_hook(&mut settings));
        assert_eq!(settings, serde_json::json!({ "theme": "dark" }));

        // 入っていない行を消しても、ファイルには触らない。
        assert!(!remove_hook(&mut settings));
    }

    /// 元から空だったグループは、こちらが空にしたものではないので残す。
    #[test]
    fn removal_keeps_a_group_that_was_already_empty() {
        let mut settings = serde_json::json!({
            "hooks": { "SessionStart": [{ "matcher": "startup", "hooks": [] }] }
        });
        assert!(ensure_hook(&mut settings, "pike.exe agent-hook"));
        assert!(remove_hook(&mut settings));
        let groups = settings["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0]["matcher"], "startup");
    }

    /// `preserve_order` を入れた目的（触っていないキーの順を保つ）を、削除の側でも守る。
    /// 素の `Map::remove` はこの feature の下では `swap_remove` なので、末尾のキーが
    /// 削除位置へ動いてしまう。
    #[test]
    fn removal_keeps_the_key_order() {
        let mut settings: serde_json::Value =
            serde_json::from_str(r#"{"theme":"dark","model":"opus","env":{}}"#).unwrap();
        assert!(ensure_hook(&mut settings, "pike.exe agent-hook"));
        assert!(remove_hook(&mut settings));
        assert_eq!(
            serde_json::to_string(&settings).unwrap(),
            r#"{"theme":"dark","model":"opus","env":{}}"#
        );
    }

    /// 隣に並ぶ利用者の hook は消さない。
    #[test]
    fn removal_keeps_other_hooks() {
        let mut settings = serde_json::json!({
            "hooks": {
                "SessionStart": [{ "hooks": [{ "type": "command", "command": "echo hi" }] }]
            }
        });
        assert!(ensure_hook(&mut settings, "pike.exe agent-hook"));
        assert!(remove_hook(&mut settings));
        let groups = settings["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0]["hooks"][0]["command"], "echo hi");
    }

    #[test]
    fn maps_a_windows_path_into_wsl() {
        assert_eq!(
            windows_to_mnt(r"C:\Users\kan\pike\src-tauri\target\debug\pike.exe").as_deref(),
            Some("/mnt/c/Users/kan/pike/src-tauri/target/debug/pike.exe")
        );
        // UNC やドライブでないものは当てにできない。
        assert_eq!(
            windows_to_mnt(r"\\wsl.localhost\Ubuntu\home\kan\pike"),
            None
        );
        assert_eq!(windows_to_mnt("/usr/local/bin/pike"), None);
    }

    #[test]
    fn matches_a_declaration_made_in_a_subdirectory() {
        let wsl = ShellConfig::Wsl {
            distro: "Ubuntu".to_string(),
        };
        assert!(cwd_under_root(&wsl, "/home/kan/pike/src", "/home/kan/pike"));
        assert!(cwd_under_root(&wsl, "/home/kan/pike", "/home/kan/pike/"));
        assert!(!cwd_under_root(
            &wsl,
            "/home/kan/pike-old",
            "/home/kan/pike"
        ));
    }
}
