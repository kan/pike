/**
 * git のエラー文から、よくある原因を見分ける（#436）。Git パネルのエラー表示が、概要と
 * 直し方の案内を UI 言語で出すために引く。
 *
 * **見分けられなくてよい。** 当たらなければ `null` を返し、パネルは「エラーが発生しました」と
 * コピー・エージェントへの依頼だけを出す。原文は常にコピーできるので、ここで無理に
 * 当てに行く理由が無い（誤った案内は、案内が無いより悪い）。
 *
 * **照合するのは git の英語の出力だけ。** 利用者が `LANG` で git を翻訳表示にしていると
 * 当たらないが、それは上の「見分けられなくてよい」に落ちるだけで済む。
 *
 * 純粋な計算だけを置く（文言は i18n の `git.err.<種別>` / `git.errFix.<種別>`）。
 */

/** 見分けられる原因。i18n キーの末尾にそのまま使う。 */
export type GitErrorKind =
  | 'auth'
  | 'hostKey'
  | 'network'
  | 'pushRejected'
  | 'noUpstream'
  | 'divergent'
  | 'localChanges'
  | 'untrackedOverwrite'
  | 'conflict'
  | 'lock'
  | 'identity'
  | 'signing'
  | 'dubiousOwnership'
  | 'nothingToCommit'
  | 'branchExists'
  | 'timeout'

/**
 * 上から順に試す。**並びが優先順位**: ssh の失敗は末尾に必ず
 * `Could not read from remote repository` を伴うので、認証とホスト鍵を `network` より
 * 先に置く。逆にすると、鍵が拒否された失敗が「ネットワークを確認」になる。
 */
const RULES: readonly (readonly [GitErrorKind, RegExp])[] = [
  ['hostKey', /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i],
  // https の 401 / 403 は `unable to access '…'` で始まるので、`network` より先に拾う。
  [
    'auth',
    /Permission denied \(|Authentication failed|could not read Username|could not read Password|terminal prompts disabled|invalid credentials|Repository not found|returned error: 40[13]/i,
  ],
  // **`failed to push some refs` では当てない。** push の失敗のほぼ全部に付く末尾行で、
  // 保護ブランチや hook の拒否（`[remote rejected]`）まで「pull してから push」になる。
  ['pushRejected', /! \[rejected\]|non-fast-forward|Updates were rejected|\(fetch first\)/i],
  ['noUpstream', /has no upstream branch|no tracking information for the current branch/i],
  ['divergent', /Need to specify how to reconcile divergent branches|Not possible to fast-forward/i],
  ['untrackedOverwrite', /untracked working tree files would be overwritten/i],
  ['localChanges', /Your local changes to the following files would be overwritten|commit your changes or stash them/i],
  ['conflict', /CONFLICT \(|Automatic merge failed|you have unmerged (paths|files)|unresolved conflict/i],
  ['lock', /\.lock': File exists|Another git process seems to be running/i],
  ['identity', /Please tell me who you are|empty ident name|unable to auto-detect email address/i],
  ['signing', /gpg failed to sign|failed to sign the data|Couldn't sign|signing failed/i],
  ['dubiousOwnership', /detected dubious ownership/i],
  ['nothingToCommit', /nothing to commit|nothing added to commit|no changes added to commit/i],
  ['branchExists', /a branch named '.*' already exists/i],
  // Pike 自身の打ち切り（`types.rs` の `wait_with_timeout`）。**`after` まで見る**:
  // ssh の `Connection timed out` は下の `network` で、直し方が違う。
  ['timeout', /timed out after \d+s/i],
  [
    'network',
    /Could not resolve host|Connection timed out|Connection refused|Network is unreachable|unable to access '|Could not read from remote repository|Connection reset/i,
  ],
]

/** エラー文の原因を見分ける。当たらなければ `null`。 */
export function classifyGitError(message: string): GitErrorKind | null {
  for (const [kind, pattern] of RULES) {
    if (pattern.test(message)) return kind
  }
  return null
}
