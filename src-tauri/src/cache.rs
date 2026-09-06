//! 同じ形で何度も書かれていたキャッシュに名前を付ける（#315）。
//!
//! 2 つある。**どちらも「キーごとに覚え、同じ問いを 2 回払わない」**という同じ目的だが、
//! 何をもって古いとみなすかが違う。
//!
//! - [`MtimeCache`] … **ファイルを読んだ結果**。mtime が同じなら読み直さない。終わった
//!   セッションのログのように、もう変わらないファイルを何度も読む経路のためのもの
//! - [`ProbeRegistry`] … **外部プロセスに聞いた結果**。古さの判定（TTL・入力の更新時刻）は
//!   消費者が持ち、ここが持つのは**キーごとの入れ物と 2 つのロック**だけ
//!
//! ## なぜ ProbeRegistry がロックを 2 つ持つか
//!
//! 素直に書くと `Mutex<HashMap<K, V>>` の 1 本になるが、その形は**キーの違う問い合わせ
//! まで直列化する**。probe は外部プロセスの起動を伴う（WSL なら `wsl.exe`、対話ログイン
//! シェルなら最長 30 秒）ので、待たされる側は無関係なプロジェクトの解決だったりする。
//!
//! - `entries` … エントリを取り出す一瞬だけ握る
//! - [`ProbeEntry::answer`] … 答えの読み書きのあいだだけ握る。**probe 中は握らない**
//! - [`ProbeEntry::probe`] … probe のあいだずっと握る。同じキーへの問い合わせを合流させる
//!   ため（前回のセッションを復元して複数のウィンドウが同時に立ち上がるときに、同じ
//!   プロセスが枚数ぶん起きるのを防ぐ）
//!
//! 元は `shell_probe.rs` がこの形を持っていて、`issues` と `claude_usage::config` は
//! 1 本のロックのままだった。**そちらの症状は「冷えた distro の probe を待つあいだ、
//! 別の導入単位の問い合わせも止まる」**。形をここに上げて 3 つとも同じにしてある。
//!
//! ## 載せる基準（#315 で 4 つ見送った）
//!
//! **キーで覚えているというだけでは載せない。** [`ProbeRegistry`] が解くのは
//! **「probe のあいだ他のキーが待つ」**という 1 つの問題なので、そうなっていないものを
//! 載せても、TTL の判定は消費者に残ったまま行数だけ増える。
//!
//! - `search::resolve_backend` と `agent_usage::opencode::query` … **probe 中にロックを
//!   握っていない**（読んで、解放して、probe して、書く）。同時に 2 本走りうるのは畳んで
//!   いないからだが、`rg --version` は軽く、opencode は前段の `agent_bins` が畳んでいる
//! - `claude_usage::rate` … 答えの表と fetch の直列化は**既に分かれている**。その
//!   直列化がキーに関わらず 1 本なのは意図的で、`claude -p "/usage"` は 10 秒超かかり
//!   時々ハングするので、アカウントが違っても同時に何本も起こしたくない
//! - `codex_usage::read_account` … ロックは握ったままだが、probe は小さな JSON の読み。
//!   外部プロセスの起動を伴わないので、待たせる相手が居ても数 ms で終わる
//!
//! ## 毒されたロックの扱い
//!
//! **`unwrap()` しない。** probe の途中で panic した別のスレッドのせいで、以後の
//! すべての問い合わせが道連れになるのは割に合わない（症状は「起動ボタンが二度と
//! 出ない」「アイコンが消えたまま戻らない」）。中身をそのまま使うか、キャッシュを
//! 諦めて素で確かめるかは消費者が決める。

use std::collections::HashMap;
use std::hash::Hash;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

/// 溢れたエントリの捨て方。**消費者ごとに本当に違う**ので選ばせる。
pub enum Evict {
    /// mtime がこの長さより古いものを捨てる。**集計のように新しいファイルだけを読む**
    /// 経路向け（走査の窓と同じ長さを渡す）。
    OlderThan(Duration),
    /// この件数を超えたら**丸ごと**捨てる（超えたぶんだけではない。名前がそう言っている）。
    /// **一覧のように古いファイルも読む**経路向けで、古さで捨てると一度も当たらなくなる。
    /// 走査の上限が決まっているので、溢れたら捨ててよい。
    ClearOver(usize),
}

/// ファイルを読んだ結果を mtime で覚える。
///
/// **`None` も覚える**（値を `Option<T>` にする消費者が多い）。読めなかったファイルこそ
/// 毎回読み直すことになるので、覚えないと「一致しなかったものだけ何度も開く」形になる。
/// ファイルが後から作られたり直ったりすれば mtime が変わるので、読み直しは効く。
pub struct MtimeCache<T> {
    entries: Mutex<HashMap<PathBuf, (SystemTime, T)>>,
    evict: Evict,
}

impl<T: Clone> MtimeCache<T> {
    pub fn new(evict: Evict) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            evict,
        }
    }

    /// 覚えていればそれを、無ければ `read()` の結果を返す（そして覚える）。
    ///
    /// **`read` はロックの外で呼ぶ。** ファイルを読むあいだ握ったままだと、別のファイル
    /// を見に来たスレッドまで待つ（WSL では UNC 越しの読みなので無視できない）。同じ
    /// ファイルを 2 つのスレッドが同時に読むことはありうるが、読みは副作用を持たないので
    /// 二重に払うだけで済む。
    pub fn get_or_read(&self, path: &Path, modified: SystemTime, read: impl FnOnce() -> T) -> T {
        if let Ok(map) = self.entries.lock() {
            if let Some((at, value)) = map.get(path) {
                if *at == modified {
                    return value.clone();
                }
            }
        }
        let value = read();
        if let Ok(mut map) = self.entries.lock() {
            match self.evict {
                Evict::OlderThan(window) => {
                    let cutoff = SystemTime::now() - window;
                    map.retain(|_, (at, _)| *at >= cutoff);
                }
                Evict::ClearOver(max) => {
                    if map.len() > max {
                        map.clear();
                    }
                }
            }
            map.insert(path.to_path_buf(), (modified, value.clone()));
        }
        value
    }
}

/// キーごとの答えと、probe の合流点（モジュール doc を参照）。
pub struct ProbeEntry<V> {
    /// 答え。**probe 中は握らない**（握ると、走っている probe が読み出しを止める）。
    answer: Mutex<V>,
    /// probe のあいだずっと握るロック。同じキーへの問い合わせを 1 本に畳む。
    probe: Mutex<()>,
}

impl<V> ProbeEntry<V> {
    /// 答えを読み書きする。**毒されていても中身をそのまま使う**（モジュール doc）。
    pub fn answer(&self) -> MutexGuard<'_, V> {
        self.answer.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// probe に入る（同じキーの先客が居れば待つ）。**戻り値を保持しているあいだが
    /// probe 中**なので、`let _ = entry.probing()` と書かないこと（その場で解放される）。
    pub fn probing(&self) -> MutexGuard<'_, ()> {
        self.probe.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 先客が居なければ probe に入る。**待つより古い答えを返したい呼び出し元のため。**
    ///
    /// 唯一の消費者は `shell_probe::config_dir_env` で、あちらは自分も probe ロックの
    /// 内側（`claude_usage::config::resolve`）から呼ばれる。待つと、同じキーの解決を
    /// 待っている者まで数珠つなぎになる —— しかも走っているのは同じ `-lic` 1 本なので、
    /// 次のポーリング（30 秒後）には答えが入っている。**一度も答えを持たないときは
    /// あちらが `probing()` で待つ**（古い答えすら無いなら、返すものが無い）。
    pub fn try_probing(&self) -> Option<MutexGuard<'_, ()>> {
        match self.probe.try_lock() {
            Ok(guard) => Some(guard),
            Err(std::sync::TryLockError::Poisoned(e)) => Some(e.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) => None,
        }
    }
}

impl<V: Default> Default for ProbeEntry<V> {
    fn default() -> Self {
        Self {
            answer: Mutex::new(V::default()),
            probe: Mutex::new(()),
        }
    }
}

/// キーごとに [`ProbeEntry`] を配るレジストリ。
pub struct ProbeRegistry<K, V> {
    entries: Mutex<HashMap<K, Arc<ProbeEntry<V>>>>,
}

impl<K: Eq + Hash, V: Default> ProbeRegistry<K, V> {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// そのキーの入れ物。**レジストリのロックは取り出す一瞬だけ握る**（probe まで
    /// 抱えると、キーの違う probe まで直列化して待ちが伸びる）。
    pub fn entry(&self, key: K) -> Arc<ProbeEntry<V>> {
        let mut map = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        map.entry(key).or_default().clone()
    }
}

impl<K: Eq + Hash, V: Default> Default for ProbeRegistry<K, V> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn reads_once_per_mtime() {
        let cache = MtimeCache::new(Evict::ClearOver(8));
        let reads = AtomicUsize::new(0);
        let path = Path::new("a.jsonl");
        let at = SystemTime::UNIX_EPOCH + Duration::from_secs(100);
        let read = || {
            reads.fetch_add(1, Ordering::SeqCst);
            Some(1u32)
        };

        assert_eq!(cache.get_or_read(path, at, read), Some(1));
        assert_eq!(cache.get_or_read(path, at, read), Some(1));
        assert_eq!(reads.load(Ordering::SeqCst), 1);

        // mtime が動いたら読み直す。
        let later = at + Duration::from_secs(1);
        assert_eq!(cache.get_or_read(path, later, read), Some(1));
        assert_eq!(reads.load(Ordering::SeqCst), 2);
    }

    /// 読めなかったファイルこそ何度も開くことになるので、`None` も覚える。
    #[test]
    fn remembers_a_failed_read() {
        let cache = MtimeCache::<Option<u32>>::new(Evict::ClearOver(8));
        let reads = AtomicUsize::new(0);
        let path = Path::new("gone.jsonl");
        let at = SystemTime::UNIX_EPOCH;
        let read = || {
            reads.fetch_add(1, Ordering::SeqCst);
            None
        };

        assert_eq!(cache.get_or_read(path, at, read), None);
        assert_eq!(cache.get_or_read(path, at, read), None);
        assert_eq!(reads.load(Ordering::SeqCst), 1);
    }

    /// 件数で捨てる側は、超えた時点で丸ごと空にする（走査の上限が決まっているため）。
    #[test]
    fn drops_everything_over_the_count() {
        let cache = MtimeCache::new(Evict::ClearOver(2));
        let at = SystemTime::UNIX_EPOCH;
        for i in 0..4u32 {
            cache.get_or_read(&PathBuf::from(format!("{i}.jsonl")), at, || Some(i));
        }
        let map = cache.entries.lock().unwrap();
        // 3 件目の挿入前は 2 件（上限ちょうど）なので残り、4 件目の前に空になる。
        assert!(map.len() <= 2, "溢れたら捨てる: {}", map.len());
    }

    /// 古さで捨てる側は、窓の外に出た mtime のエントリだけを落とす。
    #[test]
    fn drops_entries_older_than_the_window() {
        let cache = MtimeCache::new(Evict::OlderThan(Duration::from_secs(60)));
        let old = SystemTime::now() - Duration::from_secs(600);
        let fresh = SystemTime::now();
        cache.get_or_read(Path::new("old.jsonl"), old, || Some(1u32));
        cache.get_or_read(Path::new("fresh.jsonl"), fresh, || Some(2u32));
        let map = cache.entries.lock().unwrap();
        assert!(!map.contains_key(Path::new("old.jsonl")));
        assert!(map.contains_key(Path::new("fresh.jsonl")));
    }

    /// 同じキーには同じ入れ物、違うキーには別の入れ物（＝別々に probe できる）。
    #[test]
    fn hands_out_one_entry_per_key() {
        let registry = ProbeRegistry::<String, u32>::new();
        let a = registry.entry("wsl:Ubuntu".to_string());
        let b = registry.entry("wsl:Ubuntu".to_string());
        let c = registry.entry("windows".to_string());
        assert!(Arc::ptr_eq(&a, &b));
        assert!(!Arc::ptr_eq(&a, &c));

        // 別のキーの probe は待たない。
        let _probing = a.probing();
        assert!(c.try_probing().is_some());
        // 同じキーの 2 人目は待つ側になる。
        assert!(b.try_probing().is_none());
    }
}
