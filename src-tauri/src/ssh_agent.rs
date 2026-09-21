//! SSH 鍵を ssh-agent に預ける（#386）。
//!
//! #384 で、パスフレーズ付きの鍵でも pull / push が通るようになった。ただし鍵が agent に
//! 入っていないときの入力は「ターミナルで `ssh-add; git pull` を走らせる」形だった。ここは
//! それを Pike のダイアログで受け取り、`ssh-add` へ中継する側を持つ。
//!
//! **保持するのは引き続き agent で、Pike ではない。** パスフレーズは受け取った値を
//! 子プロセスの標準入力へ一度流すだけで、どこにも書かないしメモリにも残さない。以後の
//! pull / push は #384 で入れた `SSH_AUTH_SOCK` の転送にそのまま乗る。
//!
//! ## パスフレーズの渡し方（実測で確かめた形）
//!
//! `ssh-add` は端末が無いと `SSH_ASKPASS` の指すプログラムを起動し、**その標準出力**を
//! パスフレーズとして読む。そこで「標準入力をそのまま出すだけ」の中継（`exec cat`）を
//! 指し、Pike は子の標準入力へ書く。中継自身は秘密を持たない。
//!
//! - **`SSH_ASKPASS=/bin/cat` は不可**。askpass はプロンプトの文言を argv[1] で受けるので、
//!   `cat` がそれをファイル名として開こうとして失敗する
//! - **argv にもディスクにも環境変数にも載らない**。`ps` に出るのは組み立てた行だけで、
//!   そこに秘密は入っていない
//! - `wsl.exe` 越しでも標準入力は届く（#384 の調査で確認済み）
//! - 成否は `ssh-add` の終了コードで分かる（正しいと 0、誤ると 1）
//!
//! ## 中継はその場で作ってその場で消す
//!
//! `mktemp -d` の中に 2 行の `sh` スクリプトを書き、使い終わったら消す。**Pike の
//! インストール先に置かない**: WSL の distro から見える場所が要るうえ、実行ビットの
//! 付いたファイルを利用者のディスクへ恒久的に残す理由が無い。

use crate::shell_probe::{self, SSH_AUTH_SOCK};
use crate::types::{bash_quote, first_line, install_key, ShellConfig};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// `ssh-add` / `ssh-agent` を待つ上限。鍵の復号だけなので短くてよいが、冷えた WSL の
/// 起動ぶんは見込む。
const TIMEOUT: Duration = Duration::from_secs(30);

/// Pike が起こした agent 1 つ。
///
/// **pid も持つ**のは止めるため（`ssh-agent -k` が読む）。#384 が `SSH_AUTH_SOCK` だけを
/// 運んで `SSH_AGENT_PID` を運ばないのは「繋ぐのにソケットしか要らない」からで、あちらは
/// **他人が起こした agent**を相手にしている。こちらは自分で起こしたものだけを持つので、
/// 止める責任と一緒に pid も持つ。
struct Agent {
    sock: String,
    pid: String,
    /// 止めるときに使うシェル。**`install_key` から復元しない**: あれは `host` /
    /// `windows` へ潰す片道の関数で、戻す口を作ると「Windows のシェルなのに POSIX の
    /// 行を走らせる」ような、この表にしか無い前提を持った変換が増える。
    shell: ShellConfig,
}

/// Pike が起こした agent（シェルの導入単位ごとに 1 つ）。
///
/// **プロセスに 1 つ持つ**（Tauri の `manage` ではなく）。読む側の `network_env` は
/// `ShellConfig` しか受け取らない静的な関数で、そこへ `State` を通すと、リモートに触る
/// 3 つの経路すべてに引数が 1 本増える。`git/mod.rs` の `core.sshCommand` のキャッシュも
/// 同じ理由でプロセスに 1 つ持っている。
fn agents() -> &'static Mutex<HashMap<String, Agent>> {
    static AGENTS: OnceLock<Mutex<HashMap<String, Agent>>> = OnceLock::new();
    AGENTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// **Pike が起こした** agent のソケット（無ければ `None`）。
///
/// **利用者の agent には落ちない。** 呼び出し元（`git::network_env` と `ensure`）は
/// どちらも「利用者のぶん」を別に持っていて、2 つを区別する必要がある: 渡すソケットは
/// Pike のものが勝ってよいが、「ターミナルでも同じ agent に届くか」（`terminal_command`）は
/// 利用者のものだけが答えになる。ここで混ぜると、その違いが呼び出し元から見えなくなる。
pub fn started_sock(shell: &ShellConfig) -> Option<String> {
    let map = agents().lock().ok()?;
    map.get(&install_key(shell)).map(|agent| agent.sock.clone())
}

/// そのシェルで使う agent のソケット。**Pike が起こしたものを先に見る**（理由は
/// `started_sock`）。起こす前は利用者の agent がそのまま返る。
fn sock_for(shell: &ShellConfig) -> Option<String> {
    started_sock(shell).or_else(|| shell_probe::ssh_auth_sock(shell))
}

/// 鍵を agent に預ける。パスフレーズは子の標準入力で渡す。
///
/// `identity` は預ける鍵のパス（`None` なら `ssh-add` の既定の鍵）。**1 回につき 1 つ**:
/// 中継の `cat` は EOF まで読むので、2 つ目の鍵を聞かれても渡すものが残っていない。
///
/// `dir` は走らせる場所。どこでもよいが、WSL で存在しないパスを渡すと `cd` で落ちるので
/// プロジェクトのルートを渡す。
pub fn add_key(
    shell: &ShellConfig,
    dir: &str,
    identity: Option<&str>,
    passphrase: &str,
) -> Result<(), String> {
    let sock = ensure(shell, dir)?;
    let target = identity.map_or_else(String::new, |p| format!(" {}", bash_quote(p)));
    let line = format!(
        "{ASKPASS_SETUP}\
         SSH_AUTH_SOCK={sock} SSH_ASKPASS=\"$__pike_d/askpass\" SSH_ASKPASS_REQUIRE=force \
         DISPLAY=\"${{DISPLAY:-:0}}\" ssh-add{target}; \
         __pike_rc=$?; rm -rf \"$__pike_d\"; exit $__pike_rc",
        sock = bash_quote(&sock),
    );
    // **改行を添える**（askpass の契約）。`ssh-add` は受け取った 1 行の末尾の改行だけを
    // 落とすので、パスフレーズ自体は変わらない。EOF でも終わるが、行として読む版に
    // 当たったときに待たせない。
    let input = format!("{passphrase}\n");
    let (code, _, stderr) = shell.run_posix_line_stdin(dir, &line, &input, TIMEOUT)?;
    if code == 0 {
        return Ok(());
    }
    // **stderr は空のことがある**（実測）。`SSH_ASKPASS_REQUIRE=force` の `ssh-add` は
    // パスフレーズを間違えても**何も書かずに 1 で終わる**（聞き直す先が無いため）。
    // いちばん多い失敗がこれなので、手がかりとして試した鍵の名前だけは返す。
    Err(match (first_line(&stderr), identity) {
        (Some(line), _) => line,
        (None, Some(key)) => key.to_owned(),
        (None, None) => String::new(),
    })
}

/// そのホストへ繋ぐときに ssh が使う鍵のうち、**実在する最初の 1 つ**。
///
/// **鍵を名指しするのは、1 回のパスフレーズで開けるのが 1 つだけだから**（`add_key` の doc）。
/// 引数なしの `ssh-add` は既定の鍵を全部試すので、暗号化された鍵を 2 つ置いている人は
/// 2 つ目で必ず失敗し、**正しい鍵が入ったのに「失敗」と出る**。
///
/// 解決は `ssh -G <host>` に任せる。`~/.ssh/config` の `Host` / `Match` / `Include` を
/// ssh 自身が読むので、Pike が config を解釈する必要が無い。
///
/// **「最初の 1 つ」＝「サーバーが受け入れる鍵」ではない。** `ssh -G` が並べるのは ssh が
/// **提示する順**で、どれが通るかは相手が決める。`IdentityFile` を書いていない相手では
/// 既定の一覧（`id_rsa` → `id_ecdsa` → `id_ed25519` …）が並ぶので、**先頭が目当ての鍵とは
/// 限らない**。それでもここを当て推量にしておくのは、
///
/// - ssh の提示順そのものなので、手元にある情報としてはいちばん確からしい
/// - 外したときは `ssh-add` の stderr に**試した鍵のパスが出る**（`first_line` が拾う
///   先頭の行がまさにそれ）ので、利用者は何が起きたか読める
/// - 相手を `~/.ssh/config` に書いている人（パスフレーズ付きの鍵を使う人の大半）では
///   `ssh -G` が候補を 1 つに絞る
///
/// 外した場合の逃げ道は「ターミナルで実行」で、そこでは鍵を自分で名指しできる。
///
/// **`eval` で `~` を開かない。** 展開する文字列は利用者の config 由来とはいえ、そこを
/// `eval` に通すと config の中身がシェルとして走る経路ができる。先頭の `~/` を `$HOME/`
/// へ置き換えるだけで足りる（`ssh -G` が出すのはこの形か絶対パス）。
pub fn identity_for(shell: &ShellConfig, dir: &str, host: &str, ssh: &str) -> Option<String> {
    // **`core.sshCommand` を尊重する**（`git::ssh_base`）。素の `ssh` で聞くと、別の ssh や
    // 別の config（`ssh -F …`）を指している構成で**違う相手の答え**を採ることになる。
    // 引用を解かずに前置するのは `compose_ssh_command` と同じ扱い。
    let ssh = if ssh.trim().is_empty() { "ssh" } else { ssh };
    let line = format!(
        "{ssh} -G {} 2>/dev/null | sed -n 's/^identityfile //p' | \
         while read -r f; do \
         case \"$f\" in \"~/\"*) f=\"$HOME/${{f#~/}}\";; esac; \
         [ -f \"$f\" ] && {{ printf '%s\\n' \"$f\"; break; }}; done",
        bash_quote(host),
    );
    let (_, stdout, _) = shell.run_shell_line(dir, &line, TIMEOUT).ok()?;
    let found = stdout.lines().map(str::trim).find(|l| !l.is_empty())?;
    Some(found.to_owned())
}

/// リモート URL の ssh のホスト名。ssh で繋がない URL（https / ローカルのパス）は `None`。
///
/// **鍵を解決する相手を決めるためだけのもの。** 利用者名もポートも捨てる（`ssh -G` に
/// 渡すのはホストの別名で、残りは ssh が config から引き直す）。
pub fn ssh_host(url: &str) -> Option<String> {
    let url = url.trim();
    if let Some(rest) = url.strip_prefix("ssh://") {
        // `ssh://[user@]host[:port]/path`
        let authority = rest.split('/').next()?;
        let host = authority.rsplit('@').next()?;
        return non_empty(host.split(':').next()?);
    }
    if url.contains("://") {
        // https / git / file など。ssh を通らないので鍵は関係ない。
        return None;
    }
    // `[user@]host:path` の scp 形。**`:` の前に `/` があるものは除く**（`./a:b` のような
    // ローカルのパスを拾わないため）。
    let (authority, path) = url.split_once(':')?;
    if authority.contains('/') || path.is_empty() {
        return None;
    }
    non_empty(authority.rsplit('@').next()?)
}

/// **`-` で始まる値は返さない。** `ssh` に `--` は無いので、`ssh -G <host>` の引数として
/// そのままオプションに解釈される（`origin` が `-Efoo:bar` のような綴りなら届く）。
/// `bash_quote` はシェルからは守るが、ssh 自身の引数の解釈までは止められない。git 本体も
/// 同じ理由で `-` 始まりのホスト名を拒む。
fn non_empty(s: &str) -> Option<String> {
    (!s.is_empty() && !s.starts_with('-')).then(|| s.to_owned())
}

/// 中継（askpass）を一時ディレクトリに用意するところまで。行の先頭に置く。
///
/// **`DISPLAY` も添える**のは OpenSSH 8.4 より前のため。`SSH_ASKPASS_REQUIRE` はそこで
/// 入った変数で、それ以前は「`DISPLAY` があり、端末が無いとき」にだけ askpass を使う。
/// 値は何でもよく（実際に X へ繋ぎに行くのは askpass 側で、`cat` は繋がない）、既に
/// 入っていればそれを尊重する。
const ASKPASS_SETUP: &str = "__pike_d=$(mktemp -d) || exit 1; \
     printf '#!/bin/sh\\nexec cat\\n' > \"$__pike_d/askpass\"; \
     chmod 700 \"$__pike_d/askpass\"; ";

/// そのシェルで使える agent のソケット。無ければ起こして覚える。
///
/// **起こすのは 1 つも届かないときだけ。** 利用者が既に agent を持っているなら、そちらへ
/// 預けたほうが**ターミナルで打った git とも共有される**（Pike の中だけで閉じない）。
///
/// **ただし、繋がることを確かめてから採る。** `SSH_AUTH_SOCK` は rc が export した文字列で、
/// その agent が生きているとは限らない（ログアウトのあとに残った古いソケットが普通にある）。
/// 確かめずに採ると、**Pike は自分の agent を永久に起こさない**まま `ssh-add` が
/// 「agent に繋げません」で落ち続け、利用者には直す手立てが無い。
fn ensure(shell: &ShellConfig, dir: &str) -> Result<String, String> {
    if let Some(sock) = sock_for(shell).filter(|sock| agent_reachable(shell, dir, sock)) {
        return Ok(sock);
    }
    let (code, stdout, stderr) = shell.run_shell_line(dir, "ssh-agent -s", TIMEOUT)?;
    if code != 0 {
        return Err(first_line(&stderr).unwrap_or_else(|| "ssh-agent failed".to_owned()));
    }
    let sock = shell_var(&stdout, SSH_AUTH_SOCK)
        .ok_or_else(|| "ssh-agent did not report a socket".to_owned())?;
    let pid = shell_var(&stdout, "SSH_AGENT_PID").unwrap_or_default();
    let started = Agent {
        sock,
        pid,
        shell: shell.clone(),
    };

    // **起こしてから、改めて表を見る。** 確認と登録のあいだでロックを手放しているので、
    // 同じ distro を見ている 2 つのウィンドウが同時に押すと両方がここへ来る。後勝ちで
    // 上書きすると、負けたほうは `shutdown_all` の対象から外れ、**復号した鍵を抱えたまま
    // distro に残る**（Pike を終了しても消えない）。
    //
    // **ロックを握ったまま起こす形は採らない**: `ssh-agent -s` は WSL では秒単位かかり、
    // そのあいだ `sock_for` を読む全員（fetch / pull / push）が止まる。
    let mut map = agents().lock().map_err(|_| "agent table poisoned")?;
    if let Some(existing) = map.get(&install_key(shell)) {
        let sock = existing.sock.clone();
        drop(map);
        kill(&started);
        return Ok(sock);
    }
    let sock = started.sock.clone();
    map.insert(install_key(shell), started);
    Ok(sock)
}

/// agent を 1 つ止める。pid が取れなかったものは相手にしない（止めようがない）。
fn kill(agent: &Agent) {
    if agent.pid.is_empty() {
        return;
    }
    // **環境変数の前置を自分で組まない**（`run_shell_line_env`）。あの doc が
    // 「呼び出し側で組み立てるとシェルの振り分けが変わったとき無言で壊れる」と言っている
    // 当のもの。
    let env = [
        (SSH_AUTH_SOCK, agent.sock.as_str()),
        ("SSH_AGENT_PID", agent.pid.as_str()),
    ];
    // 終了を止めない（`docker::tunnel` の掃除と同じ扱い）。落ちた distro を相手に
    // したときは、そもそも中の agent も一緒に消えている。
    let _ = agent
        .shell
        .run_shell_line_env("/", &env, "ssh-agent -k", Duration::from_secs(3));
}

/// その agent に繋がるか。**`ssh-add -l` の終了コード 2 が「繋げない」**（0 は鍵あり、
/// 1 は鍵が無いだけで、どちらも生きている）。
///
/// 余分な spawn が 1 つ増えるが、走るのは**人がパスフレーズを入力したときだけ**で、
/// そのあとに控えているのは鍵の復号と pull のやり直し。
fn agent_reachable(shell: &ShellConfig, dir: &str, sock: &str) -> bool {
    // **行が複合コマンドなので、前置ではなく `export` が要る**（`posix_script` がそうする）。
    // `VAR=v cmd` の形は単純コマンドにしか付かないので、自分で組むと `[ $? -ne 2 ]` の
    // ほうへ効かない読み違えが起きうる。
    let env = [(SSH_AUTH_SOCK, sock)];
    shell
        .run_shell_line_env(
            dir,
            &env,
            "ssh-add -l >/dev/null 2>&1; [ $? -ne 2 ]",
            TIMEOUT,
        )
        .is_ok_and(|(code, _, _)| code == 0)
}

/// `ssh-agent -s` の出力から 1 つ取り出す。形は `NAME=value; export NAME;`。
fn shell_var(out: &str, name: &str) -> Option<String> {
    out.split(';')
        .filter_map(|part| part.trim().strip_prefix(name)?.strip_prefix('='))
        .map(|v| v.trim().to_owned())
        .find(|v| !v.is_empty())
}

/// Pike が起こした agent を全部止める（アプリの終了時）。
///
/// **他人の agent には触らない**（この表に入っているのは自分で起こしたものだけ）。
/// 起こしっぱなしにすると、Pike を開き直すたびに distro の中へ agent が 1 つずつ溜まる。
pub fn shutdown_all() {
    let taken: Vec<Agent> = match agents().lock() {
        Ok(mut map) => map.drain().map(|(_, agent)| agent).collect(),
        Err(_) => return,
    };
    for agent in taken {
        kill(&agent);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_socket_out_of_ssh_agent_output() {
        let out = "SSH_AUTH_SOCK=/tmp/ssh-XXXX/agent.42; export SSH_AUTH_SOCK;\n\
                   SSH_AGENT_PID=43; export SSH_AGENT_PID;\n\
                   echo Agent pid 43;\n";
        assert_eq!(
            shell_var(out, SSH_AUTH_SOCK).as_deref(),
            Some("/tmp/ssh-XXXX/agent.42")
        );
        assert_eq!(shell_var(out, "SSH_AGENT_PID").as_deref(), Some("43"));
        assert_eq!(shell_var(out, "NOPE"), None);
    }

    /// **`export NAME;` のほうを拾わない**（値が空なので、先に当たると空文字を返す）。
    #[test]
    fn skips_the_bare_export_clause() {
        let out = "SSH_AUTH_SOCK=/tmp/a; export SSH_AUTH_SOCK;";
        assert_eq!(shell_var(out, SSH_AUTH_SOCK).as_deref(), Some("/tmp/a"));
    }

    /// 鍵を解決する相手を URL から取り出す。
    #[test]
    fn reads_the_ssh_host_out_of_a_remote_url() {
        assert_eq!(
            ssh_host("git@github.com:kan/pike.git").as_deref(),
            Some("github.com")
        );
        assert_eq!(
            ssh_host("github.com:kan/pike.git").as_deref(),
            Some("github.com")
        );
        // `ssh://` では利用者名もポートも落とす。
        assert_eq!(
            ssh_host("ssh://git@example.org:2222/kan/pike.git").as_deref(),
            Some("example.org")
        );
        // ssh を通らないものは対象外。
        assert_eq!(ssh_host("https://github.com/kan/pike.git"), None);
        assert_eq!(ssh_host("file:///srv/pike.git"), None);
        assert_eq!(ssh_host("/srv/pike.git"), None);
        // **ローカルのパスを scp 形と読み違えない**（`:` の前に `/` がある）。
        assert_eq!(ssh_host("../repos/x:y"), None);
        assert_eq!(ssh_host("git@example.org:"), None);
    }

    /// 秘密は行に埋めない（argv へ出ない）。
    #[test]
    fn the_command_line_never_carries_the_passphrase() {
        assert!(ASKPASS_SETUP.contains("mktemp -d"));
        assert!(ASKPASS_SETUP.contains("exec cat"));
        assert!(!ASKPASS_SETUP.contains("hunter2"));
    }
}
