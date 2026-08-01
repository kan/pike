import { fuzzyMatch } from './paths'

// Emoji palette for project icons (#203). Kept in-repo instead of pulling an
// emoji dataset: a curated dev-flavored set is a fraction of the size, and the
// keywords can be bilingual, which the published sets are not.
//
// Unlike the color preset (a name resolved to a hex at render time), the emoji
// character IS the stored value — emoji are stable across themes and machines,
// so there is nothing to resolve.

export interface ProjectIcon {
  /** The emoji itself; this is what lands in ProjectConfig.icon. */
  char: string
  /** Search terms, English then Japanese. Matched with fuzzyMatch. */
  keywords: string[]
}

export const PROJECT_ICONS: ProjectIcon[] = [
  // Code & build
  { char: '💻', keywords: ['laptop', 'code', 'dev', 'パソコン', 'かいはつ'] },
  { char: '🖥️', keywords: ['desktop', 'pc', 'デスクトップ'] },
  { char: '⌨️', keywords: ['keyboard', 'キーボード'] },
  { char: '🧑‍💻', keywords: ['developer', 'programmer', 'エンジニア'] },
  { char: '📦', keywords: ['package', 'box', 'release', 'パッケージ', 'はこ'] },
  { char: '🧩', keywords: ['plugin', 'puzzle', 'extension', 'プラグイン', 'パズル'] },
  { char: '⚙️', keywords: ['settings', 'config', 'gear', 'せってい', 'はぐるま'] },
  { char: '🔧', keywords: ['tool', 'wrench', 'fix', 'ツール', 'スパナ'] },
  { char: '🔨', keywords: ['build', 'hammer', 'ビルド', 'かなづち'] },
  { char: '🛠️', keywords: ['tools', 'maintenance', 'こうぐ'] },
  { char: '🧪', keywords: ['test', 'experiment', 'lab', 'テスト', 'じっけん'] },
  { char: '🔬', keywords: ['research', 'microscope', 'けんきゅう'] },
  { char: '🐛', keywords: ['bug', 'issue', 'バグ', 'ふぐあい'] },
  { char: '🩹', keywords: ['patch', 'fix', 'hotfix', 'しゅうせい'] },
  { char: '🚀', keywords: ['launch', 'release', 'deploy', 'ロケット', 'リリース'] },
  { char: '✨', keywords: ['feature', 'new', 'sparkles', 'しんきのう'] },
  { char: '🔥', keywords: ['hot', 'urgent', 'ほのお', 'きんきゅう'] },
  { char: '⚡', keywords: ['fast', 'performance', 'かみなり', 'こうそく'] },
  { char: '🧠', keywords: ['ai', 'brain', 'ml', 'のうみそ', 'じんこうちのう'] },
  { char: '🤖', keywords: ['bot', 'robot', 'agent', 'ロボット', 'エージェント'] },
  { char: '👾', keywords: ['game', 'retro', 'ゲーム'] },
  { char: '🎮', keywords: ['game', 'controller', 'ゲーム'] },

  // Web, network & data
  { char: '🌐', keywords: ['web', 'internet', 'site', 'ウェブ', 'インターネット'] },
  { char: '🕸️', keywords: ['web', 'crawler', 'スクレイピング'] },
  { char: '📡', keywords: ['api', 'network', 'signal', 'つうしん'] },
  { char: '🔌', keywords: ['plugin', 'connect', 'せつぞく'] },
  { char: '🛰️', keywords: ['satellite', 'remote', 'えいせい'] },
  { char: '☁️', keywords: ['cloud', 'saas', 'クラウド', 'くも'] },
  { char: '🗄️', keywords: ['database', 'storage', 'データベース', 'ほかん'] },
  { char: '💾', keywords: ['save', 'disk', 'ほぞん', 'ディスク'] },
  { char: '📊', keywords: ['chart', 'analytics', 'グラフ', 'ぶんせき'] },
  { char: '📈', keywords: ['growth', 'metrics', 'うりあげ', 'グラフ'] },
  { char: '🧮', keywords: ['calc', 'abacus', 'けいさん', 'そろばん'] },
  { char: '🔍', keywords: ['search', 'find', 'けんさく'] },
  { char: '🗂️', keywords: ['files', 'index', 'ファイル', 'せいり'] },
  { char: '📁', keywords: ['folder', 'directory', 'フォルダ'] },
  { char: '📚', keywords: ['docs', 'library', 'books', 'ドキュメント', 'ほん'] },
  { char: '📝', keywords: ['notes', 'writing', 'memo', 'メモ', 'ぶんしょ'] },
  { char: '📰', keywords: ['blog', 'news', 'ブログ', 'ニュース'] },
  { char: '📋', keywords: ['todo', 'clipboard', 'タスク', 'いちらん'] },
  { char: '🏷️', keywords: ['tag', 'label', 'ラベル', 'タグ'] },

  // Infra & security
  { char: '🐳', keywords: ['docker', 'container', 'whale', 'ドッカー', 'くじら'] },
  { char: '🐧', keywords: ['linux', 'penguin', 'リナックス', 'ペンギン'] },
  { char: '🪟', keywords: ['windows', 'ウィンドウズ'] },
  { char: '🍎', keywords: ['mac', 'apple', 'マック', 'りんご'] },
  { char: '🏗️', keywords: ['infra', 'construction', 'wip', 'インフラ', 'こうじちゅう'] },
  { char: '🧱', keywords: ['brick', 'foundation', 'きばん'] },
  { char: '🔐', keywords: ['auth', 'security', 'lock', 'にんしょう', 'セキュリティ'] },
  { char: '🔑', keywords: ['key', 'secret', 'かぎ'] },
  { char: '🛡️', keywords: ['security', 'shield', 'ぼうぎょ'] },
  { char: '🧯', keywords: ['incident', 'firefighting', 'しょうか'] },
  { char: '⏱️', keywords: ['timer', 'benchmark', 'タイマー'] },
  { char: '📅', keywords: ['schedule', 'calendar', 'カレンダー', 'よてい'] },
  { char: '🔔', keywords: ['notification', 'alert', 'つうち'] },
  { char: '📮', keywords: ['mail', 'queue', 'メール', 'キュー'] },
  { char: '🧵', keywords: ['thread', 'concurrency', 'スレッド'] },
  { char: '♻️', keywords: ['refactor', 'recycle', 'リファクタ'] },

  // Work & organization
  { char: '🏢', keywords: ['work', 'company', 'office', 'かいしゃ', 'しごと'] },
  { char: '🏠', keywords: ['home', 'personal', 'いえ', 'こじん'] },
  { char: '🎓', keywords: ['school', 'study', 'course', 'がっこう', 'がくしゅう'] },
  { char: '💼', keywords: ['business', 'client', 'ビジネス', 'あんけん'] },
  { char: '💰', keywords: ['money', 'billing', 'おかね', 'かいけい'] },
  { char: '🛒', keywords: ['shop', 'ec', 'cart', 'かいもの'] },
  { char: '🎯', keywords: ['goal', 'target', 'もくひょう'] },
  { char: '🧭', keywords: ['compass', 'direction', 'ほうこう'] },
  { char: '🗺️', keywords: ['map', 'roadmap', 'ちず', 'ロードマップ'] },
  { char: '🚧', keywords: ['wip', 'construction', 'さぎょうちゅう'] },
  { char: '🧹', keywords: ['cleanup', 'chore', 'そうじ'] },
  { char: '🗑️', keywords: ['trash', 'deprecated', 'ごみばこ', 'はいし'] },
  { char: '📌', keywords: ['pin', 'important', 'ピン', 'じゅうよう'] },
  { char: '⭐', keywords: ['star', 'favorite', 'おきにいり', 'ほし'] },
  { char: '❤️', keywords: ['love', 'favorite', 'ハート'] },

  // Nature, food & misc for personal projects
  { char: '🌱', keywords: ['seed', 'new', 'sprout', 'しんき', 'め'] },
  { char: '🌲', keywords: ['tree', 'forest', 'き', 'もり'] },
  { char: '🍀', keywords: ['luck', 'clover', 'しあわせ'] },
  { char: '🌸', keywords: ['sakura', 'spring', 'さくら'] },
  { char: '🌊', keywords: ['wave', 'ocean', 'なみ', 'うみ'] },
  { char: '🌙', keywords: ['night', 'moon', 'つき', 'よる'] },
  { char: '☀️', keywords: ['sun', 'day', 'たいよう', 'ひる'] },
  { char: '🎨', keywords: ['design', 'art', 'ui', 'デザイン', 'え'] },
  { char: '🎬', keywords: ['video', 'movie', 'どうが', 'えいが'] },
  { char: '🎵', keywords: ['music', 'audio', 'おんがく'] },
  { char: '📷', keywords: ['photo', 'camera', 'しゃしん'] },
  { char: '🍜', keywords: ['ramen', 'food', 'ラーメン', 'たべもの'] },
  { char: '☕', keywords: ['coffee', 'java', 'break', 'コーヒー'] },
  { char: '🍺', keywords: ['beer', 'fun', 'ビール'] },
  { char: '🐱', keywords: ['cat', 'ねこ'] },
  { char: '🐶', keywords: ['dog', 'いぬ'] },
  { char: '🐬', keywords: ['dolphin', 'いるか'] },
  { char: '🦀', keywords: ['rust', 'crab', 'ラスト', 'かに'] },
  { char: '🐍', keywords: ['python', 'snake', 'パイソン', 'へび'] },
  { char: '🦕', keywords: ['deno', 'dinosaur', 'きょうりゅう'] },
  { char: '🐘', keywords: ['php', 'postgres', 'ぞう'] },
  { char: '🕊️', keywords: ['peace', 'release', 'はと'] },
]

/** Longest icon we accept, in code points. One emoji can be several (a ZWJ
 *  sequence like 🧑‍💻 is three), so this is deliberately generous. */
const MAX_ICON_CODE_POINTS = 8

/**
 * Accept a stored icon only when it is short and printable. It reaches a text
 * node rather than a style binding, so a hand-edited config risks a broken row
 * rather than an injection — but a 200-character "icon" would still wreck the
 * list. Mirrors `projectColorValue`'s validate-before-render stance.
 */
export function projectIconValue(icon: string | undefined): string | undefined {
  if (!icon) return undefined
  const trimmed = icon.trim()
  if (!trimmed || [...trimmed].length > MAX_ICON_CODE_POINTS) return undefined
  // Cc only, not the whole C category: emoji legitimately carry format
  // characters (the ZWJ in 🧑‍💻 is Cf).
  return /\p{Cc}/u.test(trimmed) ? undefined : trimmed
}

/** Palette entries matching `query` (empty query = the whole palette). */
export function searchProjectIcons(query: string): ProjectIcon[] {
  const q = query.trim()
  if (!q) return PROJECT_ICONS
  // The emoji itself matches too, so pasting one finds its entry.
  return PROJECT_ICONS.filter((icon) => icon.char === q || icon.keywords.some((k) => fuzzyMatch(k, q)))
}
