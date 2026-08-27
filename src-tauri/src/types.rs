use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

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

/// Pike が ACP エージェントの npm パッケージを入れる先。**入れる側（`agent/commands.rs`
/// の `npm install -g --prefix`）と PATH に足す側（`augmented_path_with`）が必ず同じ場所を
/// 指すよう、綴りはここ 1 つに置く。** 食い違うと、インストール直後の `which` が永久に
/// 外れる（`UNIX_INSTALL_BIN` の doc に書いた症状）。
pub const UNIX_NPM_PREFIX: &str = "$HOME/.local";

/// `UNIX_NPM_PREFIX` に npm が作る bin ディレクトリ。**まだ無くても PATH に入れる**のが
/// 要点で、これだけは `exists` の対象外にする（理由は `augmented_path_with`）。
#[cfg(not(windows))]
const UNIX_INSTALL_BIN: &str = "$HOME/.local/bin";

/// `augment_process_path` の判断部分。プロセスの環境を触らないので単体で確かめられる
/// （`set_var` はテスト同士が干渉する）。`exists` が真になったものだけを足す: 存在しない
/// ディレクトリを並べても動作は変わらないが、PATH が長いほど毎回の exec 探索が伸びる。
///
/// **例外は `UNIX_INSTALL_BIN` の 1 つだけ。** ここは Pike が ACP エージェントを入れる先で、
/// **入れるまで存在しない**。存在するものだけを足す規則をそのまま当てると、まっさらな
/// macOS で「インストールは成功したのに直後の `which` が見つけられず失敗を返す」形になり
/// （`check_acp_available`）、`AcpProcessRuntime::spawn` も PATH 解決に失敗するので、
/// Pike を再起動するまでインストールボタンが延々と成功しない。WSL 側が同じ穴に落ちないのは、
/// あちらがコマンドごとに `WSL_EXTRA_PATH` を前置していて存在を問わないため。
#[cfg(not(windows))]
fn augmented_path_with(current: &str, home: &str, exists: impl Fn(&str) -> bool) -> String {
    let mut dirs: Vec<String> = current
        .split(':')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    for entry in UNIX_EXTRA_PATH.split(':') {
        let dir = entry.replace("$HOME", home);
        if !dirs.iter().any(|d| d == &dir) && (entry == UNIX_INSTALL_BIN || exists(&dir)) {
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
pub fn os_open(arg: &str) -> Result<(), String> {
    silent_command(os_open_program())
        .arg(arg)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Quote a string for safe interpolation into a `bash -c` command.
/// Bash-specific (single-quote wrapping); NOT safe for cmd.exe or PowerShell.
pub fn bash_quote(s: &str) -> String {
    if s.is_empty() {
        return "''".to_string();
    }
    if s.chars().all(|c| c.is_alphanumeric() || "-_./=@:+".contains(c)) {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ShellConfig {
    Wsl { distro: String },
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
        let output = self.run_with_timeout(program, args, Duration::from_secs(30))?;
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
    pub fn run_stdout_with_user_path(&self, program: &str, args: &[&str]) -> Result<String, String> {
        let cmd = match self {
            ShellConfig::Wsl { distro } => {
                let mut parts = Vec::with_capacity(1 + args.len());
                parts.push(bash_quote(program));
                for a in args {
                    parts.push(bash_quote(a));
                }
                let script = format!("PATH=\"{WSL_EXTRA_PATH}:$PATH\" {}", parts.join(" "));
                let mut cmd = silent_command("wsl.exe");
                cmd.arg("-d").arg(distro).arg("-e").arg("bash").arg("-c").arg(script);
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
        self.run_with_timeout(program, args, Duration::from_secs(30))
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
    /// quoting differs per shell (`VAR=v cmd` under bash, `set "VAR=v" && cmd`
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
                let assigns: String = env
                    .iter()
                    .map(|(k, v)| format!("{k}={} ", bash_quote(v)))
                    .collect();
                let path_prefix = match s {
                    ShellConfig::Wsl { .. } => format!("PATH=\"{WSL_EXTRA_PATH}:$PATH\" "),
                    _ => String::new(),
                };
                let script = format!("cd {} && {assigns}{path_prefix}{line}", bash_quote(dir));
                match s {
                    ShellConfig::Wsl { distro } => {
                        let mut c = silent_command("wsl.exe");
                        c.arg("-d").arg(distro).arg("-e").arg("bash").arg("-c").arg(script);
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
                let assigns: String =
                    env.iter().map(|(k, v)| format!("set \"{k}={v}\" && ")).collect();
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
}

/// Pipe stdout/stderr, spawn `cmd`, and wait up to `timeout`, returning the raw
/// Output regardless of exit status (the process tree is killed on timeout).
fn spawn_with_timeout(
    mut cmd: Command,
    label: &str,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    let child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run {label}: {e}"))?;
    let pid = child.id();
    wait_with_timeout(pid, timeout, label, move || child.wait_with_output())
}

/// Spawn a prepared Command, wait up to 30 s, and return stdout on success.
fn spawn_stdout(cmd: Command, label: &str) -> Result<String, String> {
    let output = spawn_with_timeout(cmd, label, Duration::from_secs(30))?;
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
    let home = raw.lines().last().unwrap_or_default().trim().trim_end_matches('/');
    if home.is_empty() {
        return None;
    }
    cache.lock().ok()?.insert(distro.to_string(), home.to_string());
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
            && !distro.chars().any(|c| c.is_control() || c == '"' || c == '\\');
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

    #[test]
    fn shell_from_id_round_trips_menu_ids() {
        assert!(matches!(shell_from_id("powershell"), Some(ShellConfig::Powershell)));
        assert!(matches!(shell_from_id("git-bash"), Some(ShellConfig::GitBash)));
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
        let relative = ShellConfig::Unix { program: "zsh".to_string() };
        assert_eq!(relative.unix_program(), default_unix_shell());
        // 空は「既定に任せる」の意味。
        let empty = ShellConfig::Unix { program: String::new() };
        assert_eq!(empty.unix_program(), default_unix_shell());
        // 絶対パスはそのまま通る。
        let absolute = ShellConfig::Unix { program: "/bin/bash".to_string() };
        assert_eq!(absolute.unix_program(), "/bin/bash");
    }

    #[test]
    fn unix_shell_deserializes_without_program() {
        let shell: ShellConfig = serde_json::from_str(r#"{"kind":"unix"}"#).unwrap();
        assert!(matches!(shell, ShellConfig::Unix { program } if program.is_empty()));
        let shell: ShellConfig = serde_json::from_str(r#"{"kind":"unix","program":"/bin/bash"}"#).unwrap();
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
        assert_eq!(dirs.iter().filter(|d| **d == "/opt/homebrew/bin").count(), 1);
        // $HOME は展開される。
        assert!(dirs.contains(&"/Users/me/.cargo/bin"));
    }

    /// 実在しないものは足さない。**ただし Pike 自身のインストール先は例外**で、
    /// まだ無くても入る（無いと ACP のインストール直後の `which` が外れる）。
    #[cfg(not(windows))]
    #[test]
    fn augmented_path_skips_missing_dirs_except_install_bin() {
        let got = augmented_path_with("/usr/bin", "/Users/me", |_| false);
        assert_eq!(got, "/usr/bin:/Users/me/.local/bin");
    }

    /// 既に PATH にあるインストール先は重複しない（例外扱いが二重登録にならないこと）。
    #[cfg(not(windows))]
    #[test]
    fn augmented_path_keeps_install_bin_once() {
        let got = augmented_path_with("/Users/me/.local/bin:/usr/bin", "/Users/me", |_| false);
        assert_eq!(got, "/Users/me/.local/bin:/usr/bin");
    }
}
