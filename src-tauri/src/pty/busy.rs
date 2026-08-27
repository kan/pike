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

use std::collections::HashSet;
use std::time::Duration;

/// spawn するシェルの種別。どちらの判定を使うかだけを表す。
///
/// **`Host` を OS ごとに割らないこと。** 「PTY 直下のシェルに子がいるか」という問いは
/// Windows でも macOS でも同じで、違うのは数え方（Toolhelp スナップショットか
/// `pgrep -P` か）だけ。これは*ホスト*の話なので `has_child` の中の `cfg` が答える。
/// 種別を割ると、どちらのホストでも 2 つの実装のうち片方が到達不能なスタブになり、
/// さらに「macOS で `Cmd` シェル」のような噛み合わない組み合わせが黙って
/// スタブへ落ちる（実際 `ProbeKind::Windows` はそうなっていた）。
pub enum ProbeKind {
    /// ホスト上で直に動くシェル（Windows 系・macOS / Linux のローカルシェル）。
    Host,
    /// None なら既定ディストロ。
    Wsl(Option<String>),
}

/// セッションごとの判定方法。spawn 時に確定する。
#[derive(Clone)]
pub enum BusyProbe {
    /// ホスト上のシェル。値は PTY の直下プロセス (シェル) の PID。
    HostTree { pid: u32 },
    /// WSL シェル。`distro` が None なら既定ディストロ。
    Wsl { distro: Option<String>, marker: String },
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
            ProbeKind::Host => {
                shell_pid.map_or(BusyProbe::Unavailable, |pid| BusyProbe::HostTree { pid })
            }
        }
    }

    /// 単発の判定。`count_busy` と違いスナップショットをその場で取る。
    pub fn is_busy(&self) -> bool {
        match self {
            BusyProbe::HostTree { pid } => parent_pids().contains(pid),
            BusyProbe::Wsl { distro, marker } => wsl_has_extra_process(distro.as_deref(), marker),
            BusyProbe::Unavailable => false,
        }
    }
}

/// 何件が実行中か。**ホスト側のスナップショットは 1 回だけ取る**（`is_busy` を N 回
/// 呼ぶと、ターミナルの枚数だけプロセステーブルの走査 / `ps` の起動が走る）。
/// WSL は distro ごとに `wsl.exe` が要るので従来どおり並列に起こす。
pub fn count_busy(probes: &[BusyProbe]) -> usize {
    let host_pids: Vec<u32> = probes
        .iter()
        .filter_map(|p| match p {
            BusyProbe::HostTree { pid } => Some(*pid),
            _ => None,
        })
        .collect();
    let host_busy = if host_pids.is_empty() {
        0
    } else {
        let parents = parent_pids();
        host_pids.iter().filter(|pid| parents.contains(pid)).count()
    };

    let wsl: Vec<&BusyProbe> = probes
        .iter()
        .filter(|p| matches!(p, BusyProbe::Wsl { .. }))
        .collect();
    let wsl_busy = std::thread::scope(|scope| {
        let handles: Vec<_> = wsl.iter().map(|p| scope.spawn(move || p.is_busy())).collect();
        // join は handle を consume するので、filter ではなく map で受ける
        handles
            .into_iter()
            .map(|h| h.join().unwrap_or(false))
            .filter(|busy| *busy)
            .count()
    });

    host_busy + wsl_busy
}

/// 生きているプロセスの「親 PID」の集合。**1 回のスナップショットで全件に答える**のが
/// 要点で、`count_busy` はターミナルが何枚開いていてもこれを 1 度しか取らない。
///
/// 以前は判定 1 件につき 1 回、Windows は Toolhelp のプロセステーブル全走査、macOS は
/// `pgrep` の起動（＋見張りスレッド）を行っていた。`pty_busy_count` は終了時に全ウィンドウ
/// 分をまとめて呼ぶので、ターミナル N 枚で N 回になっていた。
///
/// 孫がいるなら子も必ずいるので、ツリーを降りずに直下だけ見れば「何か動いている」は
/// 判定できる。取れないときは空集合＝「実行中ではない」に倒す（モジュール冒頭の fail open）。
///
/// Windows の親 PID は親の終了後も更新されないため、死んだ親の PID が再利用されると
/// 無関係なプロセスを子と見なす可能性がある。判定対象のシェルは生存中で PID を
/// 再利用されないので、実害は「別の孤児プロセスがたまたま同じ PID を親に持つ」稀な
/// ケースに限られる。
#[cfg(windows)]
fn parent_pids() -> HashSet<u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let mut parents = HashSet::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return parents;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                if entry.th32ParentProcessID != entry.th32ProcessID {
                    parents.insert(entry.th32ParentProcessID);
                }
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    parents
}

/// `parent_pids` の macOS / Linux 版。`ps -Ao ppid=` は両方にあり、見出し無しで親 PID を
/// 1 行 1 つ出す。WSL 側のような環境変数マーカーが要らないのは、PID が同じ名前空間に
/// あるため。
#[cfg(not(windows))]
fn parent_pids() -> HashSet<u32> {
    probe_stdout(
        crate::types::silent_command("ps").args(["-Ao", "ppid="]),
        "ps busy probe",
    )
    .lines()
    .filter_map(|l| l.trim().parse::<u32>().ok())
    .filter(|ppid| *ppid > 0)
    .collect()
}

/// 判定用の子プロセスを起こし、stdout を返す。取れなければ空文字。
#[cfg(not(windows))]
fn probe_stdout(cmd: &mut std::process::Command, label: &'static str) -> String {
    let Ok(child) = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        return String::new();
    };
    let pid = child.id();
    crate::types::wait_with_timeout(pid, PROBE_TIMEOUT, label, move || child.wait_with_output())
        .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
        .unwrap_or_default()
}

/// 判定用の子プロセスを起こし、「正常終了したか」だけを返す。
///
/// タブを閉じる操作の途中で走るので、応答しないときは待たずに諦める。spawn 失敗も
/// タイムアウトも「実行中ではない」に倒す（モジュール冒頭の fail open）。
/// **タイムアウト値と fail open の規約をここ 1 つに置く**（WSL 版とホスト版で
/// 別々に持つと、閉じる操作のブロック時間を調整したとき片方だけ変わる）。
fn probe_exit_ok(cmd: &mut std::process::Command, label: &'static str) -> bool {
    let Ok(child) = cmd
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        return false;
    };
    let pid = child.id();
    crate::types::wait_with_timeout(pid, PROBE_TIMEOUT, label, move || child.wait_with_output())
        .map(|out| out.status.success())
        .unwrap_or(false)
}

/// 判定プロセスの待ち時間。タブを閉じる操作を人が待つので短く。
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

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
    probe_exit_ok(&mut cmd, "wsl busy probe")
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
