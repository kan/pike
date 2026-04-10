# Pike Codex Delegation — Windows Sandbox 修正指示書

> `pike-codex-delegation-implementation.md` を元に実装を進めた結果、Windows native runtime使用時にsandboxが原因でPike自体が巻き添え終了する問題が発覚した。その修正指示書。

## 前提

- ブランチ: 既存の `feature/codex-delegation` で作業継続
- バージョン: `0.4.0` のまま(メジャー機能追加中のhotfixという位置づけ)
- Phase A〜E は実装済み。Phase F の途中、もしくは完了後の修正想定

## 問題

Windows native runtime でcodexがコマンド実行する際、以下のいずれかが発生:

1. Pike自体がプロセスツリーごと終了する(巻き添え)
2. `danger-full-access` に切り替えると上記は回避できるが、sandboxが完全に無効化される

## 根本原因

Pikeの実装ミスではなく、**Codex側のWindows sandboxがexperimental扱いで既知の不安定性がある**ことが原因。CodexのWindows sandboxは以下の仕組みで動いており:

- ローカルのsandbox用ユーザーアカウントを`codex-windows-sandbox-setup.exe`経由で作成
- ACL設定、firewallルール設定
- `CreateProcessAsUserW` / `CreateProcessWithLogonW` で制限付きトークンによりコマンドを起動

この初期化シーケンスが失敗するバグが複数報告されている(`CreateProcessWithLogonW failed: 5`、`setup refresh failed`、sandbox setup process 100% CPU hang、等)。Codex本体が安定版に至るまで時間がかかる見込み。

## 修正方針

Codex App Serverが公式に提供しているエスケープハッチ `sandboxPolicy.type = "externalSandbox"` を使い、Codex側のsandbox強制を無効化する。代わりに:

1. **Pikeの既存approval機構**(Phase Eで実装済み)でコマンド・ファイル変更を全てユーザー承認制にする
2. **Windows Job Object**でcodex processをPike管理下に封じ込め、プロセス終了時のクリーンアップ保証とリソース上限を付ける
3. **Windows spawn flags**(`CREATE_NEW_PROCESS_GROUP` / `CREATE_NO_WINDOW`)でconsole handle共有経由のクラッシュ伝播を防ぐ

WSL runtimeはLinux側のLandlock/Bubblewrap sandboxが安定しているため**変更不要**。分岐してWindows nativeだけ`externalSandbox`にする。

## 修正タスク

### タスク1: Windows spawn flagsの追加

**対象ファイル**: `src-tauri/src/codex/runtime_windows.rs`

Windows native runtimeの`spawn_app_server`で、プロセス起動時に以下のフラグを指定する。これはsandbox問題とは独立した基本的なハイジーンだが、今回のクラッシュの一因になっている可能性があるため必須。

```rust
use tokio::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

impl CodexRuntime for WindowsNativeRuntime {
    fn spawn_app_server(&self, working_dir: &Path) -> Result<tokio::process::Child> {
        let mut cmd = Command::new("codex.exe");
        cmd.arg("app-server")
           .current_dir(working_dir)
           .stdin(Stdio::piped())
           .stdout(Stdio::piped())
           .stderr(Stdio::piped());

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);

        let child = cmd.spawn()?;
        Ok(child)
    }
    // ...
}
```

**効果**:
- `CREATE_NEW_PROCESS_GROUP`: Ctrl+C等のconsole control eventがPikeに伝播しない
- `CREATE_NO_WINDOW`: console windowが作られず、console handle共有を避ける

### タスク2: CodexRuntime trait に default_sandbox_policy() を追加

**対象ファイル**: `src-tauri/src/codex/runtime.rs`

Runtimeごとに異なるsandbox戦略を取れるよう、traitに新メソッドを追加する。

```rust
use serde_json::{json, Value};

pub trait CodexRuntime: Send + Sync {
    fn spawn_app_server(&self, working_dir: &Path) -> Result<tokio::process::Child>;
    fn translate_path_from_codex(&self, codex_path: &str) -> PathBuf;
    fn translate_path_to_codex(&self, host_path: &Path) -> String;
    fn display_environment_name(&self) -> String;
    fn codex_version(&self) -> Result<String>;

    /// Runtime固有のデフォルトsandboxポリシー。
    /// thread/start や turn/start の sandboxPolicy として使う。
    fn default_sandbox_policy(&self) -> Value;

    /// このruntimeでCodexのsandboxが信頼できるか。
    /// false の場合、Pike UI で「Codexのsandboxは無効化されています」等の
    /// 注意喚起を表示する根拠になる。
    fn codex_sandbox_trusted(&self) -> bool;
}
```

**実装**:

```rust
// runtime_windows.rs
impl CodexRuntime for WindowsNativeRuntime {
    fn default_sandbox_policy(&self) -> Value {
        // Codex の Windows sandbox は experimental で不安定なため、
        // externalSandbox を指定して Codex 側の sandbox 強制を無効化する。
        // 安全性は Pike の approval 機構 + Job Object で担保する。
        json!({
            "type": "externalSandbox",
            "networkAccess": "restricted"
        })
    }

    fn codex_sandbox_trusted(&self) -> bool {
        false
    }
    // ...
}

// runtime_wsl.rs
impl CodexRuntime for WslRuntime {
    fn default_sandbox_policy(&self) -> Value {
        // WSL の Linux sandbox (Landlock/Bubblewrap) は安定しているため
        // 通常の workspace-write を使う。
        json!({
            "type": "workspaceWrite",
            "networkAccess": "restricted"
        })
    }

    fn codex_sandbox_trusted(&self) -> bool {
        true
    }
    // ...
}
```

### タスク3: thread/start と turn/start の sandbox指定をruntimeに委譲

**対象ファイル**: `src-tauri/src/codex/session.rs`(もしくはPhase Dで実装したsession管理ファイル)

`thread/start` と `turn/start` の呼び出し時に、ハードコードされている sandbox 指定を `runtime.default_sandbox_policy()` から取得するように変更する。

**変更前**:
```rust
let params = json!({
    "input": prompt,
    "sandboxPolicy": {
        "type": "workspaceWrite",  // ハードコード
        "networkAccess": "restricted"
    }
});
```

**変更後**:
```rust
let params = json!({
    "input": prompt,
    "sandboxPolicy": self.runtime.default_sandbox_policy()
});
```

`thread/start` 側も同様に修正する。`ThreadSession` が `Arc<dyn CodexRuntime>` を保持している前提(Phase Dで実装済みのはず)。

**重要**: ユーザーが明示的にsandbox policyを上書きできる設定項目を将来追加する場合は、「runtime default を尊重する」を初期値にする。強制的に全環境で `workspaceWrite` にするオプションは**提供しない**(Windows native で確実に壊れるため)。

### タスク4: Windows runtimeでのJob Object包囲

**対象ファイル**: `src-tauri/src/codex/runtime_windows.rs`

Codex processを Windows Job Object に入れ、以下を保証する:

- Pike プロセス終了時に codex と codex の子孫プロセスが確実にクリーンアップされる
- リソース上限(プロセス数、メモリ等)で暴走を防ぐ
- Pike 自体が巻き添えになる経路を減らす

**依存追加**: `Cargo.toml` に `windows` クレートを追加。必要なfeatureは `Win32_System_JobObjects`, `Win32_System_Threading`, `Win32_Foundation`。

```toml
[target.'cfg(windows)'.dependencies]
windows = { version = "0.58", features = [
    "Win32_System_JobObjects",
    "Win32_System_Threading",
    "Win32_Foundation",
] }
```

**実装**:

```rust
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use windows::Win32::{
    Foundation::HANDLE,
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
        JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    },
};

pub struct WindowsNativeRuntime {
    #[cfg(windows)]
    job_handle: std::sync::Mutex<Option<HANDLE>>,
}

impl WindowsNativeRuntime {
    pub fn new() -> Self {
        Self {
            #[cfg(windows)]
            job_handle: std::sync::Mutex::new(None),
        }
    }

    #[cfg(windows)]
    fn wrap_in_job_object(&self, child: &tokio::process::Child) -> Result<()> {
        unsafe {
            // 既にJob Objectがあれば再利用、なければ新規作成
            let mut job_guard = self.job_handle.lock().unwrap();
            let job = if let Some(h) = *job_guard {
                h
            } else {
                let h = CreateJobObjectW(None, None)?;
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags =
                    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                    | JOB_OBJECT_LIMIT_BREAKAWAY_OK
                    | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
                info.BasicLimitInformation.ActiveProcessLimit = 256;  // 必要に応じて調整

                SetInformationJobObject(
                    h,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )?;

                *job_guard = Some(h);
                h
            };

            let raw_handle = child.raw_handle()
                .ok_or_else(|| anyhow!("failed to get child raw handle"))?;
            AssignProcessToJobObject(job, HANDLE(raw_handle as isize))?;
        }
        Ok(())
    }
}

impl CodexRuntime for WindowsNativeRuntime {
    fn spawn_app_server(&self, working_dir: &Path) -> Result<tokio::process::Child> {
        let mut cmd = Command::new("codex.exe");
        cmd.arg("app-server")
           .current_dir(working_dir)
           .stdin(Stdio::piped())
           .stdout(Stdio::piped())
           .stderr(Stdio::piped());

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);

        let child = cmd.spawn()?;

        #[cfg(windows)]
        self.wrap_in_job_object(&child)?;

        Ok(child)
    }
    // ...
}
```

**注意点**:

- `tokio::process::Child` から Windows raw handle を取得する方法は tokio のバージョンによって異なる。`raw_handle()` が使えない場合は `as_raw_handle()` 経由で取る。
- `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` は「Job Objectへの全ハンドルが閉じた時点でJob内の全プロセスを終了する」という意味。Pike が Drop されるか、process が exit すると codex とその子孫が全部死ぬ。
- `JOB_OBJECT_LIMIT_BREAKAWAY_OK` を付けておくと、特定の子プロセスが必要に応じてJobから脱出できる。codex内部で何かしらの理由でサブプロセスをJob外に出したい場合に備えて付けておく(防御的措置)。
- Job ObjectはPike全体で1つを再利用する。複数のcodex processを同じJobに入れることで、統一的なクリーンアップが効く。

### タスク5: Approval dialogに環境別の注意書き

**対象ファイル**: `src/components/codex/ApprovalDialog.vue`(もしくはPhase Eで実装したapproval UI)

Windows native runtime使用時、approval dialogに「CodexのOSレベルsandboxは無効化されています」という注意書きを表示する。Pikeのapprovalが実質的な安全境界であることをユーザーに明示するため。

**実装方針**:

1. `CodexRuntime::codex_sandbox_trusted()` の結果をapproval request payloadに含めて渡す
2. UIでその値を見て、`false` の場合に警告バナーを表示

**UI文言例**(日本語・英語両対応推奨):

- 日本語: 「Windows環境ではCodex自身のsandboxは無効化されています。コマンドの内容を慎重にご確認ください。」
- 英語: "Codex's built-in sandbox is disabled on Windows. Please review commands carefully before approving."

WSL runtime使用時はこの警告は不要(`codex_sandbox_trusted() == true`)。

### タスク6: 動作確認

修正が完了したら、以下を手動で確認する:

- [ ] **Windows native project**: 単純なコマンド(`echo hello`、ファイル作成等)がapproval経由で実行でき、Pikeが巻き添えにならない
- [ ] **Windows native project**: 複数回のコマンド実行を連続で行ってもPikeがクラッシュしない
- [ ] **Windows native project**: Pike を強制終了した際、codex.exe および子プロセスが Task Manager から消えている(Job Object の KILL_ON_JOB_CLOSE が効いていることの確認)
- [ ] **Windows native project**: Approval dialog に警告バナーが表示されている
- [ ] **WSL project**: 従来通り `workspaceWrite` で動作し、approval の挙動も変わっていない
- [ ] **WSL project**: Approval dialog に警告バナーは**表示されない**
- [ ] **認証フロー**: Windows / WSL 両方で ChatGPT ログインが引き続き正常に動作する

## やらないこと(明示)

以下は今回の修正範囲外。将来検討するとしても別タスクで扱う:

- **WebSocket transport への移行**: 現時点では過剰。Windows sandbox 問題の根本解決にもならない
- **別プロセス化 / "agent host" の導入**: 同上
- **`danger-full-access` の使用**: Pikeの approval 機構を迂回される可能性があり不採用
- **Windowsプロジェクトの強制 WSL ルーティング**: WSL非前提のユーザー体験を壊す
- **Pike側での AppContainer / Integrity Level 操作**: 実装複雑度が高く、Job Object + approval で十分
- **Codex本体へのbug report / PR**: 有意義だが本修正とは別の作業。時間があれば別途

## 将来の方針

CodexのWindows sandboxが安定版になったら(experimental フラグが外れ、上記GitHub issue群が解決したら)、`WindowsNativeRuntime::default_sandbox_policy()` を `workspaceWrite` に戻すことを検討する。その時点でJob Objectは保険として残しておいて構わない(併用可能)。

Kanさん自身でCodexのchangelogをウォッチする、もしくは Pike の設定で `use_codex_sandbox: bool` のフラグを追加して手動切り替えできるようにする、という選択肢もある。ただしデフォルトは `false`(= externalSandbox)で維持するのが安全。

## 参考

- 元の実装指示書: `pike-codex-delegation-implementation.md`
- Codex App Server ドキュメント: `developers.openai.com/codex/app-server` の `sandboxPolicy` セクション
- 関連する Codex GitHub issue: #9062, #10090, #10601, #14094, #16643, Discussion #14758
