use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// 外部コマンドの既定の待ち時間。`run` 系と検索が共有する。
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Create a Command with CREATE_NO_WINDOW on Windows to prevent console window flashing.
#[cfg_attr(not(windows), allow(unused_mut))]
pub fn silent_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    // 非 Windows にはコンソールウィンドウという概念が無いので何もしない。
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

/// User-local binary paths to prepend to PATH when invoking WSL commands that
/// may need to find user-installed binaries (signing programs, hooks,
/// credential helpers, language toolchains). `bash -l` would pick these up via
/// `.profile`, but we use `bash -c` (non-login) to avoid tty-related hangs.
///
/// `/usr/local/go/bin` is where the official Go tarball installs, and only
/// `.profile` puts it on PATH — without it `go vet` in the Problems panel found
/// no `go` and reported an empty (not failed) run.
pub const WSL_EXTRA_PATH: &str = "$HOME/.local/bin:$HOME/bin:$HOME/.bun/bin:$HOME/.local/share/fnm/aliases/default/bin:$HOME/.cargo/bin:$HOME/go/bin:/usr/local/bin:/usr/local/go/bin";

/// `-c core.quotePath=false`, which every git invocation carries (#300).
///
/// The default is `true`, and it makes git octal-escape non-ASCII paths
/// (`"7-\346\226\260\350\246\217.txt"`). Nothing downstream unquotes, so those
/// bytes reach the panel verbatim, and `fs::check_ignore`'s name matching
/// misses. It is **not** a macOS thing — the default is the same everywhere,
/// and the reporter simply had no `core.quotePath` in their config.
///
/// This only covers non-ASCII. A path holding `"`, `\` or a control character
/// stays C-quoted even with the flag; killing that needs `-z`, which changes
/// how porcelain v2 separates rename pairs and is left for its own change.
pub const QUOTEPATH_OFF: [&str; 2] = ["-c", "core.quotePath=false"];

/// The arguments that prefix every git invocation: `QUOTEPATH_OFF` and the
/// repository to run in. Callers append their own subcommand and arguments.
///
/// Lives here rather than in `git/` because `fs::check_ignore` needs the same
/// prefix; keeping only the const shared meant the *shape* was still written
/// twice, and the next flag added to it would land in one file only.
pub fn git_args<'a>(root: &'a str, args: &[&'a str]) -> Vec<&'a str> {
    [&QUOTEPATH_OFF[..], &["-C", root], args].concat()
}

/// `git_args` for the places that build a bash line instead of an argv —
/// the WSL helpers that fold several git calls into one `wsl.exe` spawn.
///
/// **Use it for every git call in those scripts, not just the ones that print
/// paths.** The flag is harmless on `rev-parse` and `remote get-url`, and
/// "all of them" is a rule the next editor cannot get wrong; "the ones I
/// reasoned about" silently reintroduces the escaping the moment someone adds
/// a `git diff --name-only` to the script.
pub fn git_bash_prefix(root: &str) -> String {
    format!("git {} -C {}", QUOTEPATH_OFF.join(" "), bash_quote(root))
}

/// `WSL_EXTRA_PATH` の macOS / Linux 版。**WSL 以上に必要**で、理由は
/// Finder / Dock から起動した GUI プロセスが `launchd` の最小 PATH
/// （`/usr/bin:/bin:/usr/sbin:/sbin`）しか継承しないこと。ターミナルから
/// `cargo tauri dev` したときは開発者のシェル PATH を継ぐので**開発中は再現せず、
/// インストール版だけで `git` も `rg` も `claude` も見つからない**という形になる。
/// Homebrew は Apple Silicon が `/opt/homebrew`、Intel が `/usr/local`。
///
/// **使うのは `augment_process_path` の 1 箇所だけ**。WSL 版と違い、個々のコマンドを
/// `sh -c 'PATH=... cmd'` で包む必要はない: WSL の `bash -c` が distro の素の PATH から
/// 始まるのに対し、こちらはプロセスの PATH をそのまま継ぐので、起動時に 1 回広げれば
/// 全経路に効く。**シェル経由で足す実装を再び入れないこと**（プロセス側と向きが食い違うと、
/// 同じツールが呼び出し経路によって別の実体に解決される）。
///
/// 唯一の読み手が `augmented_path_with`（非 Windows のみ）なので、Windows ビルドでは
/// `-D dead-code` に当たる。定数だけ残しても意味を持たないので、まとめて cfg で落とす。
///
/// 先頭の `$HOME/.local/bin` だけは `UNIX_INSTALL_BIN` として別扱いになる（実在しなくても
/// 足す）。並び順を変えるときはあちらの一致も一緒に見ること。
#[cfg(not(windows))]
pub const UNIX_EXTRA_PATH: &str = "$HOME/.local/bin:$HOME/bin:$HOME/.bun/bin:$HOME/.local/share/fnm/aliases/default/bin:$HOME/.cargo/bin:$HOME/go/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/go/bin";

/// GUI から起動したプロセスの PATH に、`UNIX_EXTRA_PATH` のうち実在するものを足す。
///
/// **Finder / Dock / `open` から起動した macOS の GUI プロセスは `launchd` の最小 PATH
/// （`/usr/bin:/bin:/usr/sbin:/sbin`）しか持たない。** そのため素の `Command::new("git")`
/// も `rg` も `claude` も解決できない。ターミナルから `cargo tauri dev` すると開発者の
/// シェル PATH を継ぐので**開発中はまったく再現せず、インストール版だけで壊れる**。
///
/// 呼び出し側で PATH を組み立てる（`run_shell_line_env` 等）だけでは、`ShellConfig` を
/// 通らない直接 spawn（PTY・エージェント・updater）が取り残される。プロセスの PATH を
/// 1 度だけ広げておけば全経路が同じ前提に乗る。
///
/// ログインシェルに `$PATH` を聞く方式（VS Code のやり方）は採らない。起動のたびに
/// 対話シェルを 1 本起こすことになり、rc が `exec tmux` するような環境で固まる。
/// 静的な一覧で足りなければ、ユーザーはターミナルから起動できる。
///
/// **スレッドを起こす前に呼ぶこと**（`set_var` はプロセス全体を触る）。
#[cfg(not(windows))]
pub fn augment_process_path() {
    let home = std::env::var("HOME").unwrap_or_default();
    let current = std::env::var("PATH").unwrap_or_default();
    let next = augmented_path_with(&current, &home, |dir| std::path::Path::new(dir).is_dir());
    std::env::set_var("PATH", next);
}

#[cfg(windows)]
pub fn augment_process_path() {}

/// `augment_process_path` の判断部分。プロセスの環境を触らないので単体で確かめられる
/// （`set_var` はテスト同士が干渉する）。**`exists` が真になったものだけを足す**: 存在しない
/// ディレクトリを並べても動作は変わらないが、PATH が長いほど毎回の exec 探索が伸びる。
///
/// 以前は `$HOME/.local/bin` だけ `exists` を免除していた。Pike 自身が
/// `npm install -g --prefix $HOME/.local` で ACP エージェントを入れており、**入れるまで
/// そのディレクトリが存在しない**ため、インストール直後の `which` が外れるのを避ける必要が
/// あったため。#275 でそのインストーラごと消えたので、例外の根拠も無くなった（ユーザー自身の
/// npm / pipx が作っていれば `exists` で普通に拾う）。
#[cfg(not(windows))]
fn augmented_path_with(current: &str, home: &str, exists: impl Fn(&str) -> bool) -> String {
    let mut dirs: Vec<String> = current
        .split(':')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    for entry in UNIX_EXTRA_PATH.split(':') {
        let dir = entry.replace("$HOME", home);
        if !dirs.iter().any(|d| d == &dir) && exists(&dir) {
            dirs.push(dir);
        }
    }
    dirs.join(":")
}

/// このプロセスを動かしているホストのホームディレクトリ。
///
/// **`USERPROFILE` は Windows にしか無い。** macOS / Linux で直に読むと `None` になり、
/// `~/.claude` や `~/.codex` の解決が黙って失敗する（エラーではなく「記録がありません」と
/// いう空の表示になるので気付きにくい）。WSL のホームは distro の中にあって別物なので、
/// ここではなく `wsl_home_cached` が解決する。
pub fn host_home() -> Option<String> {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

/// このビルドのアプリ identifier（`tauri.conf.json` の値）。
///
/// **`AppHandle` を持てない場所のためにある。** 唯一の利用者は single-instance の
/// ウィンドウ名（`wait.rs`）で、あれは WM_COPYDATA の経路なので Windows 専用。
/// **`cfg` を外すと macOS で dead code になる**（Windows でだけ使われる関数を
/// `cfg` 無しで置くと、手元の `just check` は通って macOS の CI だけが落ちる。
/// `.claude/rules/platform.md` が書いている死角の裏返し）。
///
/// アプリの中では `app.config().identifier` が正本なので、そちらを使えるなら使う。
/// `pike agent-hook`（#299）の申告の置き場はこれを引かない: あちらは開発版と
/// インストール版で 1 本を共有するので、identifier を固定してある。
///
/// 判定は `cfg!(debug_assertions)`。`tauri build --config tauri.dev.conf.json`
/// （identifier は `.debug` だが release プロファイル）だけは食い違うが、これは
/// CSP の切り分け用の一時ビルドで、`wait.rs` も前から同じ前提で動いている。
#[cfg(windows)]
pub fn app_identifier() -> &'static str {
    if cfg!(debug_assertions) {
        "com.pike.dev.debug"
    } else {
        "com.pike.dev"
    }
}

/// Tauri が `app_config_dir` に解決する場所を、`AppHandle` 無しで組み立てる。
///
/// **アプリが立ち上がる前**（`pike agent-hook`、`window_geom::prune_plugin_state`）と、
/// **`AppHandle` を受け取らない解決経路**（`claude_usage::config::resolve`）の両方から
/// 要る。identifier を引数で受けるのは、正しい値（`app.config().identifier`）を持って
/// いる呼び出し元がそれを渡せるようにするため。
pub fn pike_config_dir_for(id: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA").map(|d| PathBuf::from(d).join(id))
    }
    #[cfg(target_os = "macos")]
    {
        host_home().map(|h| {
            PathBuf::from(h)
                .join("Library")
                .join("Application Support")
                .join(id)
        })
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        std::env::var("XDG_CONFIG_HOME")
            .ok()
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| host_home().map(|h| PathBuf::from(h).join(".config")))
            .map(|d| d.join(id))
    }
}

/// `ShellConfig::Unix { program }` として受け付けてよい値か。
///
/// シェルは直接 spawn するので**絶対パスに限る**（PATH 探索させない）。空文字は
/// 「既定（`$SHELL`）に任せる」の意味なので、ここでは弾かれて `default_unix_shell()`
/// に落ちるのが正しい。長さと制御文字の制限は、id や設定ファイルから来る自由入力を
/// そのままコマンドラインに載せないため。
pub fn is_valid_unix_program(program: &str) -> bool {
    program.starts_with('/')
        && program.chars().count() <= 256
        && !program.chars().any(|c| c.is_control())
}

/// 対話 PTY で起動するローカルシェル。`$SHELL` があればそれ、無ければ
/// macOS の既定である zsh に落とす（`ShellConfig::Unix { program: "" }` の解決先）。
pub fn default_unix_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_string())
}

/// OS 標準の「これを開く」プログラム。URL でもフォルダでも同じものが受け取る。
///
/// **どれもシェルを介さず引数をそのまま受ける**ので、`cmd.exe /C start` のような
/// メタ文字インジェクションの経路にならない（Windows の `explorer.exe` は内部で
/// `ShellExecuteW` に委譲する）。
///
/// **呼び出し側で `explorer.exe` を直書きしないこと。** 以前は `open_url`・
/// `fs_open_in_explorer`・Codex の OAuth ログイン 2 箇所に同じリテラルが散っていて、
/// macOS 対応で片方だけ直したため、あちらでは外部リンクも ChatGPT ログインも
/// 「`explorer.exe` を起動できない」で失敗していた。
pub fn os_open_program() -> &'static str {
    if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer.exe"
    } else {
        "xdg-open"
    }
}

/// `os_open_program()` に 1 引数を渡して起動する。戻りを待たない（開くだけ）。
///
/// **URL には使わないこと**（`os_open_url` がある）。理由はそちらの doc を参照。
pub fn os_open(arg: &str) -> Result<(), String> {
    silent_command(os_open_program())
        .arg(arg)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// URL を既定のハンドラ（ブラウザ）で開く。
///
/// **Windows で `explorer.exe` に渡さないのが要点。** あれに URL を渡すのは文書化されていない
/// 使い方で、`explorer.exe` のコマンドラインはまず**シェルのオブジェクト（パス）**として
/// 解釈される。素の `https://example.com` はたまたま通るが、**クエリや fragment を含む URL は
/// パスとして解釈できず、ブラウザではなくエクスプローラーのウィンドウが開く**（実測）。
/// `ShellExecuteW` が「既定のハンドラで開く」の正規の API で、シェルを通さないので
/// メタ文字インジェクションの経路にもならない。
///
/// 非 Windows の `open` / `xdg-open` は URL をそのまま扱えるので、従来どおり `os_open` に乗る。
pub fn os_open_url(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows::core::{w, HSTRING};
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let file = HSTRING::from(url);
        // ShellExecuteW は成功したときだけ 32 より大きい値を返す（HINSTANCE 型なのは
        // 16 ビット時代の名残で、ハンドルとしての意味は持たない）。
        let rc = unsafe { ShellExecuteW(None, w!("open"), &file, None, None, SW_SHOWNORMAL) };
        if rc.0 as isize > 32 {
            Ok(())
        } else {
            Err(format!("ShellExecute failed ({})", rc.0 as isize))
        }
    }
    #[cfg(not(windows))]
    {
        os_open(url)
    }
}

/// `run_shell_line_env` が POSIX 側で `bash -c` / `sh -c` に渡すスクリプト。
///
/// **環境変数と PATH は `export` で置く（`VAR=v cmd` の前置ではない）。** あの形は
/// **単純コマンドにしか付けられない**ので、`line` が `for … do … done` のような複合
/// コマンドだと bash が構文エラーで落ちる。呼び出し側が渡せる行の形を、この関数の
/// 都合で狭めないための書き方。
///
/// 実害は今もある: `diagnostics` の `golangciCommand` は**利用者が書いた行**がそのまま
/// 来るので、`&&` で繋いだ 2 つ目のコマンドに `WSL_EXTRA_PATH` が効かなかった。
/// cmd 側（`set "K=V" && …`）はもともと行全体に効くので、この変更で 2 つの腕の意味が
/// 揃った（前置のころは POSIX だけ 1 コマンド限定というずれがあった）。
///
/// PATH の前置が要るのは WSL だけ。ローカル Unix は `augment_process_path` が
/// プロセス側で広げてある。
fn posix_script(dir: &str, env: &[&(&str, &str)], shell: &ShellConfig, line: &str) -> String {
    let exports: String = env
        .iter()
        .map(|(k, v)| format!("export {k}={}; ", bash_quote(v)))
        .collect();
    let path_export = match shell {
        ShellConfig::Wsl { .. } => format!("export PATH=\"{WSL_EXTRA_PATH}:$PATH\"; "),
        _ => String::new(),
    };
    format!("cd {} && {exports}{path_export}{line}", bash_quote(dir))
}

/// Quote a string for safe interpolation into a `bash -c` command.
/// Bash-specific (single-quote wrapping); NOT safe for cmd.exe or PowerShell.
pub fn bash_quote(s: &str) -> String {
    if s.is_empty() {
        return "''".to_string();
    }
    if s.chars()
        .all(|c| c.is_alphanumeric() || "-_./=@:+".contains(c))
    {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ShellConfig {
    Wsl {
        distro: String,
    },
    Cmd,
    Powershell,
    /// PowerShell 7+ (pwsh.exe) — Windows PowerShell 5 (`Powershell`) と併存
    Pwsh,
    GitBash,
    /// macOS / Linux でホスト上のシェルを直接使う。`program` は対話 PTY で起動する
    /// ログインシェルの絶対パス（空文字なら `default_unix_shell()` が決める）。
    ///
    /// **WSL と同じ POSIX 側だが、ファイル I/O は Windows 側と同じ `std::fs` を通る**
    /// という中間の性格を持つ。引用・パス区切り・null デバイスの分岐は `is_posix()` で
    /// 行い、ファイル操作は `fs/mod.rs` の `ShellConfig::Wsl` 以外の腕（`std::fs` 直接）に
    /// そのまま乗る。**`_ =>` を「Windows である」の意味で使わないこと。**
    ///
    /// `program` は **`serde(default)` が必須**。フロントは既定のシェルを
    /// `{ kind: 'unix' }` として送る（実体を焼き込まない方針）ので、これが無いと
    /// `shell: ShellConfig` を取る Tauri コマンドが軒並み「missing field `program`」で
    /// 落ちる。`shell_from_id_round_trips_unix` の隣の serde テストが見張っている。
    Unix {
        #[serde(default)]
        program: String,
    },
}

impl ShellConfig {
    /// パス区切り・引用規約・null デバイスが POSIX かどうか。`GitBash` は
    /// **含めない**: 引用こそ bash だが扱うパスは Windows のもので、既存の分岐は
    /// 一貫して Windows 側に置いている。
    pub fn is_posix(&self) -> bool {
        matches!(self, ShellConfig::Wsl { .. } | ShellConfig::Unix { .. })
    }

    /// Windows 側の作法（`\` 区切り・cmd の引用・管理者昇格）が当てはまるシェルか。
    /// フロントの `isWindowsShell`（`types/tab.ts`）と対。
    pub fn is_windows(&self) -> bool {
        !self.is_posix()
    }

    /// 対話 PTY で起動するシェルの実体パス（`Unix` 以外では意味を持たない）。
    ///
    /// **「絶対パスのみ」の検証はここで行う。** `shell_from_id` にも同じ規則があるが、
    /// あれはトレイ / ジャンプリスト / CLI の id 経由の入口だけで、`ShellConfig` は
    /// **serde 越しの IPC と `project.json` からも**そのまま届く。値が実際に
    /// `CommandBuilder::new` に渡るのはここ 1 箇所なので、経路が全部収束する。
    /// 妥当でなければ既定のログインシェルに落とす（PATH 探索させない）。
    pub fn unix_program(&self) -> String {
        match self {
            ShellConfig::Unix { program } if is_valid_unix_program(program) => program.clone(),
            _ => default_unix_shell(),
        }
    }

    /// このホストで既定にすべきシェル。Windows は従来どおり PowerShell、
    /// macOS / Linux はログインシェル。プロジェクト作成・CLI・診断の
    /// 「シェル指定が無いとき」がすべてここを通る。
    ///
    /// **`program` は空のままにすること**（実体は `unix_program()` が起動時に `$SHELL` から
    /// 解決する）。ここで焼き込むと `project/transient.rs` 経由でフロントへ渡り、
    /// `registerTransientProject` が `project.json` へそのまま保存するので、`pike <dir>` で
    /// 開いて登録したプロジェクトが `/bin/zsh` を恒久的に指す。さらに `shellId` が
    /// `unix:/bin/zsh` になり、シェルプロファイルの id（`unix`）と一致しなくなるため
    /// TabPane のドロップダウンでどれも既定として選ばれなくなる。
    pub fn host_default() -> ShellConfig {
        #[cfg(windows)]
        {
            ShellConfig::Powershell
        }
        #[cfg(not(windows))]
        {
            ShellConfig::Unix {
                program: String::new(),
            }
        }
    }

    /// Build a Command with WSL dispatch.
    /// WSL: `wsl.exe -d distro -e program args...` (bypasses bash, safe for special chars)
    /// Others: `program args...`
    pub fn command(&self, program: &str, args: &[&str]) -> Command {
        match self {
            ShellConfig::Wsl { distro } => {
                let mut cmd = silent_command("wsl.exe");
                cmd.arg("-d").arg(distro).arg("-e").arg(program);
                for a in args {
                    cmd.arg(a);
                }
                cmd
            }
            _ => {
                let mut cmd = silent_command(program);
                for a in args {
                    cmd.arg(a);
                }
                cmd
            }
        }
    }

    /// Execute with a 30 s timeout and return (exit_code, stdout, stderr).
    pub fn run(&self, program: &str, args: &[&str]) -> Result<(i32, String, String), String> {
        let output = self.run_with_timeout(program, args, DEFAULT_TIMEOUT)?;
        Ok((
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        ))
    }

    /// Execute with a 30 s timeout and return stdout on success, Err on failure.
    pub fn run_stdout(&self, program: &str, args: &[&str]) -> Result<String, String> {
        spawn_stdout(self.command(program, args), program)
    }

    /// WSL: route through `bash -c` with `WSL_EXTRA_PATH` prepended so user-installed
    /// binaries (signing programs, git hooks) resolve. Non-WSL shells run normally —
    /// their Pike-inherited PATH already covers most cases.
    pub fn run_stdout_with_user_path(
        &self,
        program: &str,
        args: &[&str],
    ) -> Result<String, String> {
        let cmd = match self {
            ShellConfig::Wsl { distro } => {
                let mut parts = Vec::with_capacity(1 + args.len());
                parts.push(bash_quote(program));
                for a in args {
                    parts.push(bash_quote(a));
                }
                let script = format!("PATH=\"{WSL_EXTRA_PATH}:$PATH\" {}", parts.join(" "));
                let mut cmd = silent_command("wsl.exe");
                cmd.arg("-d")
                    .arg(distro)
                    .arg("-e")
                    .arg("bash")
                    .arg("-c")
                    .arg(script);
                cmd
            }
            // macOS / Linux はここで包む必要が無い。`augment_process_path` が起動時に
            // 同じ一覧をプロセスの PATH へ入れており、子はそれを継ぐ（`/bin/sh` を
            // 挟むと引用の正しさを別途保たなければならないぶん損）。
            _ => self.command(program, args),
        };
        spawn_stdout(cmd, program)
    }

    /// Execute with a 30 s timeout and return raw Output (for binary data).
    pub fn run_raw(&self, program: &str, args: &[&str]) -> Result<std::process::Output, String> {
        self.run_with_timeout(program, args, DEFAULT_TIMEOUT)
    }

    /// Run a shell command line inside `dir`, returning (exit_code, stdout, stderr)
    /// regardless of exit status (build/lint tools exit non-zero when they find
    /// problems). PATH is augmented so user toolchains (cargo, go, npx) resolve.
    ///
    /// WSL routes through `bash -c` (with `WSL_EXTRA_PATH` prepended). Every
    /// Windows shell routes through `cmd /C` — diagnostic tools live on the
    /// Windows PATH regardless of the project's interactive shell, and cmd honors
    /// PATHEXT so `npx`/`tsc` shims (.cmd) resolve.
    pub fn run_shell_line(
        &self,
        dir: &str,
        line: &str,
        timeout: Duration,
    ) -> Result<(i32, String, String), String> {
        self.run_shell_line_env(dir, &[], line, timeout)
    }

    /// `run_shell_line` plus environment variables for that one command. The
    /// quoting differs per shell (`export VAR=v; cmd` under bash, `set "VAR=v" && cmd`
    /// under cmd), so it lives here next to the dispatch that decides which shell
    /// actually runs — a caller assembling the prefix itself breaks silently when
    /// this dispatch changes. Values containing `"` are dropped: cmd cannot quote
    /// them, and every current caller passes a path.
    pub fn run_shell_line_env(
        &self,
        dir: &str,
        env: &[(&str, &str)],
        line: &str,
        timeout: Duration,
    ) -> Result<(i32, String, String), String> {
        let env: Vec<&(&str, &str)> = env.iter().filter(|(_, v)| !v.contains('"')).collect();
        let cmd = match self {
            // WSL とローカル Unix はスクリプトの字面が同じで、違いは 2 つだけ:
            // PATH の前置（WSL は distro の素の PATH から始まるので要る。ローカルは
            // `augment_process_path` がプロセス側で広げてあるので要らない）と、
            // それを走らせるシェルの起こし方。**引用規約（`bash_quote`）を腕ごとに
            // 書き写さないこと** — この関数の doc が「呼び出し側で組み立てると無言で
            // 壊れる」と言っている当のものが 2 コピーになる。
            // `cd` は `current_dir` ではなくスクリプトに入れる。
            s if s.is_posix() => {
                let script = posix_script(dir, &env, s, line);
                match s {
                    ShellConfig::Wsl { distro } => {
                        let mut c = silent_command("wsl.exe");
                        c.arg("-d")
                            .arg(distro)
                            .arg("-e")
                            .arg("bash")
                            .arg("-c")
                            .arg(script);
                        c
                    }
                    _ => {
                        let mut c = silent_command("/bin/sh");
                        c.arg("-c").arg(script);
                        c
                    }
                }
            }
            _ => {
                // `current_dir` + `raw_arg` avoids the cmd.exe/Rust quoting clash
                // that `cmd /C "cd /d ..."` triggers; cmd starts in `dir`, so
                // relative tools (node_modules/.bin, npx) resolve correctly.
                let assigns: String = env
                    .iter()
                    .map(|(k, v)| format!("set \"{k}={v}\" && "))
                    .collect();
                let mut c = silent_command("cmd.exe");
                c.current_dir(dir);
                c.arg("/C");
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    c.raw_arg(format!("{assigns}{line}"));
                }
                #[cfg(not(windows))]
                {
                    c.arg(format!("{assigns}{line}"));
                }
                c
            }
        };
        let output = spawn_with_timeout(cmd, "shell", timeout)?;
        Ok((
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        ))
    }

    /// Path to the null device for this shell environment.
    pub fn null_device(&self) -> &'static str {
        if self.is_posix() {
            "/dev/null"
        } else {
            "NUL"
        }
    }

    fn run_with_timeout(
        &self,
        program: &str,
        args: &[&str],
        timeout: Duration,
    ) -> Result<std::process::Output, String> {
        spawn_with_timeout(self.command(program, args), program, timeout)
    }

    /// **対話ログインシェル（`-lic`）に 1 問聞く。** POSIX 側でしか意味を持たない
    /// （`None` を返す）。
    ///
    /// `run_shell_line` との違いは「どんな環境で走るか」。あちらは非対話で、rc ファイルを
    /// 読まない。**利用者の PATH は rc の中にある**ことが多く（nvm / fnm / asdf / mise /
    /// Homebrew はどれもそう）、Pike のターミナルは対話シェルなので、**ターミナルと同じ
    /// 答えが欲しい問いはこちらを通す**。
    ///
    /// 契約が 3 つあり、**呼び出し側に書かせない**（`claude_usage/config.rs` の環境変数
    /// プローブと `agents.rs` の検出が同じものを 2 回書いていた）:
    ///
    /// - **`unset HISTFILE` を先頭に置く。** 対話シェルは終了時に履歴を書き戻すので、
    ///   落とさないと `HISTSIZE` の設定次第でプローブが利用者の `.bash_history` を削りうる
    /// - **終了コードは見ない。** 対話シェルは job control の警告を出すし、`.bashrc` の
    ///   中身次第で非 0 で終わる
    /// - **起こすのは WSL なら distro の `bash`、ローカル Unix なら利用者のログインシェル**
    ///   （macOS の既定は zsh で、PATH は `.zshrc` にある）。`-lic` の綴りは bash と zsh で
    ///   同じ意味を持つ
    ///
    /// 拾い方は `marker_values` と対。`.bashrc` はバナーを出すことがある（この開発機の
    /// WSL は `git status` の結果を出す）ので、行の位置では選べない。
    pub fn run_login_script(&self, script: &str, timeout: Duration) -> Option<String> {
        if !self.is_posix() {
            return None;
        }
        let program = self.login_shell_program();
        let script = format!("unset HISTFILE\n{script}\nexit 0");
        let out = self
            .run_with_timeout(&program, &["-lic", &script], timeout)
            .ok()?;
        Some(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// `-lic` で起こすシェル。**WSL は distro の `bash`、ローカル Unix は利用者の
    /// ログインシェル**（PTY が起動するものと同じ。macOS の既定は zsh で、PATH は
    /// `.zshrc` にある）。`-lic` の綴りは bash と zsh で同じ意味を持つ。
    fn login_shell_program(&self) -> String {
        match self {
            ShellConfig::Wsl { .. } => "bash".to_string(),
            _ => self.unix_program(),
        }
    }
}

/// `run_login_script` に待てる時間。**呼び出し側に置かない**: rc を読ませるぶん非対話より
/// 長く要る、というのは問いの性質ではなくシェルの性質なので、起こし方の契約と同じ場所に置く。
pub const LOGIN_PROBE_TIMEOUT: Duration = Duration::from_secs(30);

/// 目印（`<tag>\t<値>`）の付いた行の値。**行の位置や「空でない行」では選べない**
/// （`run_login_script` の doc）ので、プローブの出力はこれで拾う。
pub fn marker_values(stdout: &str, tag: &str) -> Vec<String> {
    stdout
        .lines()
        .filter_map(|line| line.trim_start().strip_prefix(tag)?.strip_prefix('\t'))
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .collect()
}

/// Pipe stdout/stderr and spawn `cmd`.
fn spawn_piped(mut cmd: Command, label: &str) -> Result<std::process::Child, String> {
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run {label}: {e}"))
}

/// Pipe stdout/stderr, spawn `cmd`, and wait up to `timeout`, returning the raw
/// Output regardless of exit status (the process tree is killed on timeout).
fn spawn_with_timeout(
    cmd: Command,
    label: &str,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    let child = spawn_piped(cmd, label)?;
    let pid = child.id();
    wait_with_timeout(pid, timeout, label, move || child.wait_with_output())
}

/// `spawn_capped_lines` の結果。
pub struct CappedRun<T> {
    pub items: Vec<T>,
    pub code: i32,
    pub stderr: String,
}

/// stdout を 1 行ずつ読み、`cap` 件そろったところで打ち切る（#257）。
///
/// **出力を全部溜める `run` 系との違いはここだけ。** あちらは子の出力をメモリに溜めてから
/// 返すので、検索のように「大量に出るが先頭しか要らない」コマンドでは、作らせたものの
/// 大半を捨てることになる（`function` の検索で rg が 8.3MB を作り、実測 2,054ms。打ち切ると
/// 215ms で、検索そのものは 22ms しか使っていない）。rg には**全体**の件数上限にあたる
/// フラグが無い（`--max-count` はファイルごと）ので、受け取る側で止めるしかない。
///
/// 止め方は**パイプを閉じること**。読み手が居なくなれば書き手は失敗して自分から終わる。
/// `kill` も撃つが、WSL では `wsl.exe` を殺してもディストロの中のプロセスには届かないので、
/// 効いているのはパイプのほう。
///
/// stderr は別スレッドで吸う。読まずに放っておくと、エラーを大量に出すコマンドがパイプを
/// 埋めたところで止まり、こちらは stdout を待ち続ける。
pub fn spawn_capped_lines<T: Send + 'static>(
    cmd: Command,
    label: &str,
    cap: usize,
    parse: impl FnMut(&str) -> Option<T> + Send + 'static,
) -> Result<CappedRun<T>, String> {
    let mut child = spawn_piped(cmd, label)?;
    let pid = child.id();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("{label}: no stdout pipe"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("{label}: no stderr pipe"))?;

    let stderr_thread = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut buf);
        buf
    });

    wait_with_timeout(pid, DEFAULT_TIMEOUT, label, move || {
        // 読みで失敗しても後始末は必ず通す。`?` で抜けると、殺さないまま `Child` を drop
        // することになり、子とスレッドが残る。
        let read = read_capped(stdout, cap, parse);

        // もう終わっていれば kill は失敗するが、それは想定どおり。
        let _ = child.kill();
        let status = child.wait();
        let stderr = stderr_thread.join().unwrap_or_default();

        Ok(CappedRun {
            items: read?,
            code: status?.code().unwrap_or(-1),
            stderr,
        })
    })
}

/// `cap` 件そろうまで行を読む。抜けた時点で `stdout` は落ちている＝パイプが閉じている。
fn read_capped<T>(
    stdout: std::process::ChildStdout,
    cap: usize,
    mut parse: impl FnMut(&str) -> Option<T>,
) -> std::io::Result<Vec<T>> {
    let mut items = Vec::new();
    let mut reader = BufReader::new(stdout);
    let mut raw = Vec::new();
    while items.len() < cap {
        raw.clear();
        if reader.read_until(b'\n', &mut raw)? == 0 {
            break;
        }
        // 行ごとに lossy 変換する。grep は任意のバイトを流すので、不正な UTF-8 で全体を
        // 失敗させない（`run` 系も出力全体に対して同じことをしている）。
        let line = String::from_utf8_lossy(&raw);
        if let Some(item) = parse(line.trim_end_matches(['\n', '\r'])) {
            items.push(item);
        }
    }
    Ok(items)
}

/// Spawn a prepared Command, wait up to 30 s, and return stdout on success.
fn spawn_stdout(cmd: Command, label: &str) -> Result<String, String> {
    let output = spawn_with_timeout(cmd, label, DEFAULT_TIMEOUT)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("{label} error: {stderr}"));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Run a closure in a background thread with a timeout.
/// If the timeout expires, the process tree rooted at `pid` is killed via `taskkill`.
/// Used by both `ShellConfig::run_with_timeout` and `fs::write_bytes`.
pub fn wait_with_timeout<T: Send + 'static>(
    pid: u32,
    timeout: Duration,
    label: &str,
    f: impl FnOnce() -> std::io::Result<T> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    match rx.recv_timeout(timeout) {
        Ok(result) => result.map_err(|e| format!("Failed to run {label}: {e}")),
        Err(_) => {
            // Fire-and-forget so a slow kill doesn't block the caller
            let pid_str = pid.to_string();
            std::thread::spawn(move || {
                // Windows は taskkill /T がプロセスツリーごと落とす。Unix には
                // 相当するものが無いので、少なくとも当該プロセスは確実に落とす
                // （子まで追うには setsid してプロセスグループを作る必要があり、
                // portable-pty を通らないこの経路では割に合わない）。
                let (program, args): (&str, Vec<&str>) = if cfg!(windows) {
                    ("taskkill", vec!["/F", "/T", "/PID", &pid_str])
                } else {
                    ("kill", vec!["-9", &pid_str])
                };
                let _ = silent_command(program)
                    .args(args)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            });
            Err(format!("{label} timed out after {}s", timeout.as_secs()))
        }
    }
}

/// Canonicalize a Windows-style path for case-insensitive comparison: forward
/// slashes → backslashes, trailing separators stripped, lowercased.
fn normalize_win_path(p: &str) -> String {
    p.replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

/// Match a session/agent cwd against a project root. Windows paths compare
/// case-insensitively; WSL paths are case-sensitive (trailing `/` ignored).
/// Shared by `claude_usage` and `codex_usage` (the single comparison that
/// decides whether a tool session belongs to the current project).
pub fn cwd_matches_root(shell: &ShellConfig, cwd: &str, root: &str) -> bool {
    if shell.is_posix() {
        cwd.trim_end_matches('/') == root.trim_end_matches('/')
    } else {
        normalize_win_path(cwd) == normalize_win_path(root)
    }
}

/// エポック秒。時計が壊れているときは 0（比較に使うだけで、0 なら「最も古い」）。
///
/// `agent_usage` にある同名の関数は `Option` を返す別物で、あちらは「値が無い」を
/// そのまま欄の欠落として出す。こちらの 2 つの利用者（レート取得の試行時刻、hook の
/// 申告の時刻）はどちらも比較にしか使わないので、分岐を持たない。
pub fn epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `cwd` がプロジェクトの `root` そのものか、その配下か。
///
/// `cwd_matches_root` が完全一致しか見ないのは、あちらの用途（セッションの記録を
/// プロジェクトへ割り当てる）では配下まで拾うと隣のプロジェクトのぶんまで混ざる
/// ため。こちらは hook の申告（#299）の突き合わせ用で、**`cd src && claude` の
/// ように配下で起動された申告も拾いたい**。区切りと大小の扱いはあちらと共有する。
///
/// **`lib.rs` の `is_under_root` は別の答えを返す**（常に小文字化して `/` へ寄せる）。
/// あちらは CLI のファイル引数をどのウィンドウへ配るかの判定で、WSL でも大小を
/// 無視する。1 本にするなら、まずどちらの意味を採るかを決めることになる。
pub fn cwd_under_root(shell: &ShellConfig, cwd: &str, root: &str) -> bool {
    if cwd_matches_root(shell, cwd, root) {
        return true;
    }
    if shell.is_posix() {
        let root = root.trim_end_matches('/');
        !root.is_empty() && cwd.starts_with(&format!("{root}/"))
    } else {
        let root = normalize_win_path(root);
        !root.is_empty() && normalize_win_path(cwd).starts_with(&format!("{root}\\"))
    }
}

/// First non-empty line of `text`, clipped so a runaway error can't bloat the
/// payload. `None` when there is nothing to report.
///
/// **外部ツールの失敗をそのまま UI に出す側はここを通す。** 打ち切りが要るのは、
/// シェルの初期化や壊れたツールが 1 行に数 KB を吐くことがあり、それが IPC に載って
/// パネルを埋めるため（`diagnostics` の `ProviderRun.error` と `issues` が共有する）。
pub fn first_line(text: &str) -> Option<String> {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    Some(line.chars().take(200).collect())
}

/// Cache key for things that are per claude/codex *installation* rather than per
/// project — a WSL distro has its own home and its own tool config, the Windows
/// shells all share the host's. Shared so the several caches keyed this way
/// (`claude_usage::config`, `claude_usage::rate`) agree on what counts as one
/// installation.
pub fn install_key(shell: &ShellConfig) -> String {
    match shell {
        ShellConfig::Wsl { distro } => format!("wsl:{distro}"),
        // ホスト上のインストールは 1 つ。Unix と Windows でキーを分けているのは
        // 同じプロセスで両方が出てくることが無いためで、区別のためではない。
        ShellConfig::Unix { .. } => "host".to_string(),
        _ => "windows".to_string(),
    }
}

/// Resolve (and cache per distro) a WSL distro's `$HOME`, as its native Linux path.
pub fn wsl_home_cached(shell: &ShellConfig, distro: &str) -> Option<String> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(home) = cache.lock().ok()?.get(distro) {
        return Some(home.clone());
    }
    // `echo $HOME` → e.g. "/home/kan"; take the last line in case of any banner.
    let raw = shell.run_stdout("bash", &["-c", "echo $HOME"]).ok()?;
    let home = raw
        .lines()
        .last()
        .unwrap_or_default()
        .trim()
        .trim_end_matches('/');
    if home.is_empty() {
        return None;
    }
    cache
        .lock()
        .ok()?
        .insert(distro.to_string(), home.to_string());
    Some(home.to_string())
}

/// Map a WSL-native path to the Windows UNC that reaches it, probing the modern
/// `\\wsl.localhost\…` share and falling back to the legacy `\\wsl$\…` one. The
/// share name is decided once per distro (by looking at the distro root, so this
/// works for files as well as directories) and cached.
///
/// Existence of the *target* is not checked — callers that need it say so.
pub fn wsl_native_to_unc(distro: &str, native: &str) -> Option<PathBuf> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let host = match cache.lock().ok()?.get(distro) {
        Some(host) => host.clone(),
        None => ["wsl.localhost", "wsl$"]
            .into_iter()
            .find(|host| PathBuf::from(format!("\\\\{host}\\{distro}\\")).is_dir())?
            .to_string(),
    };
    cache.lock().ok()?.insert(distro.to_string(), host.clone());
    let tail = native.trim_end_matches('/').replace('/', "\\");
    Some(PathBuf::from(format!("\\\\{host}\\{distro}{tail}")))
}

/// Resolve (and cache per `(distro, subdir)`) a WSL home subdirectory — e.g.
/// `.claude`, `.codex` — as a Windows UNC path. Not cached on failure, so it keeps
/// retrying until the tool has actually written into the distro.
pub fn wsl_home_subdir_cached(shell: &ShellConfig, distro: &str, subdir: &str) -> Option<PathBuf> {
    static CACHE: OnceLock<Mutex<HashMap<(String, String), PathBuf>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = (distro.to_string(), subdir.to_string());
    if let Some(dir) = cache.lock().ok()?.get(&key) {
        return Some(dir.clone());
    }
    let home = wsl_home_cached(shell, distro)?;
    let dir = wsl_native_to_unc(distro, &format!("{home}/{subdir}")).filter(|p| p.is_dir())?;
    cache.lock().ok()?.insert(key, dir.clone());
    Some(dir)
}

pub fn validate_slug(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 64 {
        return Err(format!("{label} must be 1-64 characters"));
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("{label} must contain only [a-zA-Z0-9_-]"));
    }
    Ok(())
}

/// シェル識別子（フロントの `shellId`（`src/types/tab.ts`）と同じ表記:
/// `wsl:<distro>` / `cmd` / `powershell` / `pwsh` / `git-bash`）を `ShellConfig`
/// に戻す。ジャンプリストの `--shell=<id>` とトレイの `tray:new-terminal:<id>`
/// が同じ文字列を運ぶ（#240）。**信頼できない入力の入口**なので distro は形だけ
/// 検証する。
pub fn shell_from_id(id: &str) -> Option<ShellConfig> {
    if let Some(distro) = id.strip_prefix("wsl:") {
        // distro 名は `wsl.exe -d <distro>` へ引数として渡るだけでシェル展開はされない
        // ので、弾くのは名前として成立しないものだけにする。**ここを絞りすぎない**:
        // 検出側（`detect_wsl_distros`）は行を trim するだけで、インポートした distro は
        // `Ubuntu (dev)` のように空白も括弧も持てる。落とすとメニューには項目が出たまま
        // ジャンプリストは globalShell で開き（無言で別のシェル）、トレイは何も起きない。
        // 引用符と \ はジャンプリストの引数文字列の引用を壊すので除く。
        let ok = !distro.is_empty()
            && distro.chars().count() <= 64
            && !distro
                .chars()
                .any(|c| c.is_control() || c == '"' || c == '\\');
        return ok.then(|| ShellConfig::Wsl {
            distro: distro.to_string(),
        });
    }
    // `unix:<絶対パス>`（例 `unix:/bin/zsh`）。distro と違いここはシェルの実行ファイルを
    // 直接 spawn するので、絶対パスであることだけは確かめる（PATH 探索させない）。
    if let Some(program) = id.strip_prefix("unix:") {
        return is_valid_unix_program(program).then(|| ShellConfig::Unix {
            program: program.to_string(),
        });
    }
    match id {
        "cmd" => Some(ShellConfig::Cmd),
        "powershell" => Some(ShellConfig::Powershell),
        "pwsh" => Some(ShellConfig::Pwsh),
        "git-bash" => Some(ShellConfig::GitBash),
        // 実体はログインシェル。id に焼き込まないのは、`$SHELL` を変えたときに
        // 保存済みのタブが古いシェルを指し続けないようにするため。
        "unix" => Some(ShellConfig::Unix {
            program: String::new(),
        }),
        _ => None,
    }
}

/// メニュー（ジャンプリスト #160 / トレイ #161）に並べるシェル 1 つ分。
/// シェル一覧はフロントの localStorage（`pike:shell-profiles`、マシンローカル）に
/// あって Rust からは読めないので、`menus_refresh` の引数として受け取り、Rust は
/// 表示と `--shell=<id>` の組み立てだけを行う（#240）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuShell {
    /// `shell_from_id` が受け付ける識別子（フロントの `shellId`）
    pub id: String,
    /// 表示ラベル（フロントの `shellProfileLabel`。UI 言語には依存しない固有名）
    pub label: String,
}

/// macOS のメニューに並べる Pike 固有の項目 1 つ分（#254）。
///
/// ラベルはフロントの i18n、アクセラレータは `lib/shortcuts.ts` の `KEY_BINDINGS` に
/// あって、どちらも Rust からは読めない。**Rust に写しを持たせない**ために
/// `menus_refresh` の引数として受け取る（`MenuShell` と同じ理由・同じ経路）。
/// 写しを持っていたころは、同じ操作がメニューとショートカット一覧で別の名前で
/// 呼ばれていた（「コマンドパレット」対「クイックオープン」など 5 件）。
///
/// メニューの構造（サブメニュー・区切り・predefined 項目）は Rust 側が持つ。
/// あれは AppKit の作法であってフロントの持ち物ではない。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuAction {
    /// フロントの `AppActionId`。`pike://menu` の payload としてそのまま返る。
    pub id: String,
    /// 表示ラベル（UI 言語のもの）
    pub label: String,
    /// Tauri のアクセラレータ表記（`Cmd+T`）。無しの項目もある（`Cmd+K` 等、
    /// WebView 側の層が握るキーはメニューに載せてはいけない）
    pub accelerator: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **複合コマンドを渡しても構文が壊れないこと。** `VAR=v cmd` の前置は単純コマンド
    /// にしか付けられないので、以前の書き方では `for … do … done` を渡した瞬間に
    /// bash が `syntax error near unexpected token 'do'` で落ちていた（#275）。
    #[test]
    fn posix_script_exports_so_compound_commands_survive() {
        let script = posix_script(
            "/home/kan/proj",
            &[],
            &ShellConfig::Wsl {
                distro: "Ubuntu".into(),
            },
            "for c in claude; do command -v \"$c\"; done",
        );
        assert!(script.contains("export PATH="));
        // 代入の直後がループの先頭に来ない（`;` で切れている）。
        assert!(!script.contains("$PATH\" for "));
        assert!(script.contains("$PATH\"; for "));
    }

    /// **目印の付いた行だけを拾う。** `.bashrc` はバナーを出すことがある（この開発機の
    /// WSL は `git status` の結果を出す）ので、行の位置や「空でない行」では選べない。
    #[test]
    fn marker_values_ignores_shell_banners() {
        let out = "On branch main\nPIKE\tclaude\nnothing to commit\n  PIKE\tcodex  \nPIKE\t\n";
        assert_eq!(marker_values(out, "PIKE"), vec!["claude", "codex"]);
    }

    /// 対話シェルが `\r\n` で返しても値に混ぜない（`CLAUDE_CONFIG_DIR` の解決が
    /// これに依存している）。
    #[test]
    fn marker_values_trim_carriage_returns() {
        assert_eq!(
            marker_values("PIKE\t/home/kan/.claude-ai\r\n", "PIKE"),
            vec!["/home/kan/.claude-ai"]
        );
    }

    #[test]
    fn login_shell_is_bash_under_wsl_and_the_users_shell_locally() {
        assert_eq!(
            ShellConfig::Wsl {
                distro: "Ubuntu".into()
            }
            .login_shell_program(),
            "bash"
        );
        assert_eq!(
            ShellConfig::Unix {
                program: "/bin/zsh".into()
            }
            .login_shell_program(),
            "/bin/zsh"
        );
    }

    #[test]
    fn posix_script_exports_caller_env() {
        let env = ("CLAUDE_CONFIG_DIR", "/home/kan/.claude-ai");
        let script = posix_script(
            "/tmp",
            &[&env],
            &ShellConfig::Unix {
                program: String::new(),
            },
            "claude -p /usage",
        );
        assert!(script.contains("export CLAUDE_CONFIG_DIR=/home/kan/.claude-ai; "));
        // ローカル Unix は PATH を足さない（`augment_process_path` が済ませている）。
        assert!(!script.contains("export PATH="));
    }

    #[test]
    fn shell_from_id_round_trips_menu_ids() {
        assert!(matches!(
            shell_from_id("powershell"),
            Some(ShellConfig::Powershell)
        ));
        assert!(matches!(
            shell_from_id("git-bash"),
            Some(ShellConfig::GitBash)
        ));
        assert!(
            matches!(shell_from_id("wsl:Ubuntu-24.04"), Some(ShellConfig::Wsl { distro }) if distro == "Ubuntu-24.04")
        );
        // A distro name is required, and only name-shaped ones are accepted:
        // the id reaches us from CLI args and tray menu ids.
        assert!(shell_from_id("wsl").is_none());
        assert!(shell_from_id("wsl:").is_none());
        // Imported distros can carry spaces and punctuation — those must work.
        assert!(
            matches!(shell_from_id("wsl:Ubuntu (dev)"), Some(ShellConfig::Wsl { distro }) if distro == "Ubuntu (dev)")
        );
        assert!(shell_from_id("wsl:a\"b").is_none());
        assert!(shell_from_id("bash").is_none());
    }

    #[test]
    fn shell_from_id_round_trips_unix() {
        assert!(matches!(
            shell_from_id("unix"),
            Some(ShellConfig::Unix { program }) if program.is_empty()
        ));
        assert!(
            matches!(shell_from_id("unix:/bin/zsh"), Some(ShellConfig::Unix { program }) if program == "/bin/zsh")
        );
        // シェルは直接 spawn するので、PATH 探索させる相対名は受け付けない。
        assert!(shell_from_id("unix:zsh").is_none());
        assert!(shell_from_id("unix:").is_none());
    }

    /// フロントが送る既定のシェル（`{ kind: 'unix' }`）が受け取れること。`program` の
    /// `serde(default)` が外れると、`shell` を取る Tauri コマンドが全部落ちる。
    /// `shell_from_id` を通らない経路（serde / project.json）でも同じ規則が効くこと。
    #[test]
    fn unix_program_rejects_values_that_shell_from_id_would_reject() {
        // 相対名は PATH 探索になるので採らない。既定のログインシェルへ落ちる。
        let relative = ShellConfig::Unix {
            program: "zsh".to_string(),
        };
        assert_eq!(relative.unix_program(), default_unix_shell());
        // 空は「既定に任せる」の意味。
        let empty = ShellConfig::Unix {
            program: String::new(),
        };
        assert_eq!(empty.unix_program(), default_unix_shell());
        // 絶対パスはそのまま通る。
        let absolute = ShellConfig::Unix {
            program: "/bin/bash".to_string(),
        };
        assert_eq!(absolute.unix_program(), "/bin/bash");
    }

    #[test]
    fn unix_shell_deserializes_without_program() {
        let shell: ShellConfig = serde_json::from_str(r#"{"kind":"unix"}"#).unwrap();
        assert!(matches!(shell, ShellConfig::Unix { program } if program.is_empty()));
        let shell: ShellConfig =
            serde_json::from_str(r#"{"kind":"unix","program":"/bin/bash"}"#).unwrap();
        assert!(matches!(shell, ShellConfig::Unix { program } if program == "/bin/bash"));
    }

    /// GUI 起動の最小 PATH（launchd がくれるもの）に Homebrew 等が足され、
    /// 既にあるものは重複しない。
    #[cfg(not(windows))]
    #[test]
    fn augmented_path_appends_missing_dirs_once() {
        let current = "/usr/bin:/bin:/opt/homebrew/bin";
        let got = augmented_path_with(current, "/Users/me", |_| true);
        let dirs: Vec<&str> = got.split(':').collect();

        // 元の並びは先頭に残る（ユーザーの PATH の優先順を壊さない）。
        assert_eq!(&dirs[..3], &["/usr/bin", "/bin", "/opt/homebrew/bin"]);
        // 既にあるものは 1 回だけ。
        assert_eq!(
            dirs.iter().filter(|d| **d == "/opt/homebrew/bin").count(),
            1
        );
        // $HOME は展開される。
        assert!(dirs.contains(&"/Users/me/.cargo/bin"));
    }

    /// 実在しないものは 1 つも足さない（#275 で最後の例外が消えたので、規則は 1 本）。
    #[cfg(not(windows))]
    #[test]
    fn augmented_path_skips_missing_dirs() {
        let got = augmented_path_with("/usr/bin", "/Users/me", |_| false);
        assert_eq!(got, "/usr/bin");
    }
}
