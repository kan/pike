//! ターミナルで「シェル以外のプロセスが動いているか」の判定 (#178)。
//!
//! シェルの種類で見る場所が変わる。
//!
//! - Windows シェル (cmd / PowerShell / pwsh / Git Bash): シェルプロセスの
//!   子孫がいれば実行中。ConPTY の下でもアイドル時の子孫は 0 件になる
//! - WSL: Linux 側のプロセスは Windows のプロセスツリーに出てこない
//!   （wsl.exe の子には wslhost.exe / conhost.exe が常駐するため、ツリーを
//!   見ると常に実行中になってしまう）。代わりに spawn 時に注入した
//!   `PIKE_PTY_ID` が子孫へ継承されることを利用し、そのマーカーを持つ
//!   プロセスがシェル自身より多ければ実行中と見なす
//!
//! いずれも判定できなかった場合は「実行中ではない」を返す（fail open）。
//! 確認ダイアログは操作を止めるものなので、判定不能を理由に毎回止めるより
//! 従来どおり閉じられる方に倒す。

use std::time::Duration;

/// spawn するシェルの種別。どちらの判定を使うかだけを表す。
pub enum ProbeKind {
    Windows,
    /// None なら既定ディストロ。
    Wsl(Option<String>),
    /// macOS / Linux のローカルシェル。
    Unix,
}

/// セッションごとの判定方法。spawn 時に確定する。
#[derive(Clone)]
pub enum BusyProbe {
    /// Windows シェル。値は PTY の直下プロセス (シェル) の PID。
    WindowsTree { pid: u32 },
    /// WSL シェル。`distro` が None なら既定ディストロ。
    Wsl { distro: Option<String>, marker: String },
    /// ローカルの Unix シェル。値は PTY 直下プロセス (シェル) の PID。
    UnixTree { pid: u32 },
    /// PID が取れなかった等で判定できない。
    Unavailable,
}

impl BusyProbe {
    /// spawn 直後のシェル PID と PTY id (WSL のマーカー) から作る。
    pub fn new(kind: ProbeKind, shell_pid: Option<u32>, pty_id: &str) -> Self {
        match kind {
            ProbeKind::Wsl(distro) => BusyProbe::Wsl {
                distro,
                marker: pty_id.to_string(),
            },
            // どちらも「PTY 直下のシェルの PID」から作る。子の数え方だけが違う。
            ProbeKind::Windows => {
                shell_pid.map_or(BusyProbe::Unavailable, |pid| BusyProbe::WindowsTree { pid })
            }
            ProbeKind::Unix => {
                shell_pid.map_or(BusyProbe::Unavailable, |pid| BusyProbe::UnixTree { pid })
            }
        }
    }

    pub fn is_busy(&self) -> bool {
        match self {
            BusyProbe::WindowsTree { pid } => has_child(*pid),
            BusyProbe::Wsl { distro, marker } => wsl_has_extra_process(distro.as_deref(), marker),
            BusyProbe::UnixTree { pid } => unix_has_child(*pid),
            BusyProbe::Unavailable => false,
        }
    }
}

/// root に子プロセスが 1 つでもあるか。孫がいるなら子も必ずいるので、
/// ツリーを降りずに直下だけ見れば「何か動いている」は判定できる。
///
/// Windows の親 PID は親の終了後も更新されないため、死んだ親の PID が
/// 再利用されると無関係なプロセスを子と見なす可能性がある。判定対象の
/// シェルは生存中で PID を再利用されないので、実害は「別の孤児プロセスが
/// たまたま同じ PID を親に持つ」稀なケースに限られる。
#[cfg(windows)]
fn has_child(root: u32) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return false;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut found = false;
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                if entry.th32ParentProcessID == root && entry.th32ProcessID != root {
                    found = true;
                    break;
                }
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
        found
    }
}

#[cfg(not(windows))]
fn has_child(_root: u32) -> bool {
    false
}

/// ローカル Unix シェルに子プロセスがいるか。`pgrep -P` は macOS・Linux の
/// どちらにもあり、直下の子だけを見れば足りるのは Windows 側と同じ理屈。
/// WSL 側のような環境変数マーカーが要らないのは、PID が同じ名前空間にあるため。
#[cfg(not(windows))]
fn unix_has_child(root: u32) -> bool {
    let Ok(child) = crate::types::silent_command("pgrep")
        .args(["-P", &root.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        return false;
    };
    let pid = child.id();
    // タブを閉じる操作の途中で走るので、応答しないときは待たずに諦める（WSL 側と同じ）
    crate::types::wait_with_timeout(pid, Duration::from_secs(3), "pgrep busy probe", move || {
        child.wait_with_output()
    })
    .map(|out| out.status.success())
    .unwrap_or(false)
}

#[cfg(windows)]
fn unix_has_child(_root: u32) -> bool {
    false
}

/// マーカーが `/proc/*/environ` 走査用のシェルスクリプトに埋め込んで安全か。
/// 実体は UUID なので、想定外の文字が混ざっていたら判定を諦める。
fn is_safe_marker(marker: &str) -> bool {
    !marker.is_empty()
        && marker.len() <= 64
        && marker
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// WSL 側に、マーカーを持つプロセスがシェル自身より多く存在するか。
fn wsl_has_extra_process(distro: Option<&str>, marker: &str) -> bool {
    if !is_safe_marker(marker) {
        return false;
    }
    // environ は NUL 区切りなので grep -z で 1 エントリを完全一致させる。
    // シェル自身も必ず 1 つ数えられるため、2 つ以上なら子プロセスがいる。
    let script = format!(
        "n=0; for p in /proc/[0-9]*; do grep -qz '^PIKE_PTY_ID={marker}$' \"$p/environ\" 2>/dev/null && n=$((n+1)); [ $n -gt 1 ] && exit 0; done; exit 1"
    );

    let mut cmd = crate::types::silent_command("wsl.exe");
    if let Some(d) = distro {
        cmd.arg("-d").arg(d);
    }
    cmd.args(["-e", "bash", "-c", &script]);
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());

    let Ok(child) = cmd.spawn() else {
        return false;
    };
    let pid = child.id();
    // タブを閉じる操作の途中で走るので、WSL が応答しないときは待たずに諦める
    crate::types::wait_with_timeout(
        pid,
        Duration::from_secs(3),
        "wsl busy probe",
        move || child.wait_with_output(),
    )
    .map(|out| out.status.success())
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_must_be_uuid_like() {
        assert!(is_safe_marker("2f1a9c4e-0b7d-4f11-9a3e-6c5d8e7f0a1b"));
        assert!(!is_safe_marker(""));
        assert!(!is_safe_marker("a'; rm -rf /; echo '"));
        assert!(!is_safe_marker("with space"));
        assert!(!is_safe_marker(&"x".repeat(65)));
    }

    #[test]
    fn unsafe_marker_reports_not_busy() {
        assert!(!wsl_has_extra_process(None, "bad marker"));
    }
}
