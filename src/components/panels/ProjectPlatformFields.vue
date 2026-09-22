<script setup lang="ts">
/**
 * プロジェクトの「プラットフォームと、それに応じたシェルの選択」欄。
 *
 * かつて作成フォーム 2 つと編集フォームが同じ 3 行を持っていたので 1 つにまとめた。
 * **プラットフォームを増やす変更は、以前は 3 ファイルを揃って直す必要があり、
 * コンパイラの助けが無かった**（実際 browse ボタンの条件は 2 ファイルだけ直されて
 * 1 つは条件そのものが無い、という状態になっていた）。
 *
 * **#373 で作成フォームが消え、消費者は編集フォーム 1 つになった。** 詰まった見た目
 * （`compact`）しか使われなくなったので、広いフォーム用の値ごと prop を落としてある。
 * モーダルにも置きたくなったら、そのとき差を戻す。
 *
 * WSL / Windows の選択は Windows ホストにしか意味が無い。macOS / Linux では
 * プラットフォームは `unix` 固定なので、ラジオの行ごと出さない。
 */
import { computed } from 'vue'
import { isWindowsHost } from '../../lib/host'
import type { ProjectPlatform } from '../../lib/projectPaths'
import { useSettingsStore } from '../../stores/settings'
import type { WindowsShellKind } from '../../types/tab'

const props = defineProps<{
  platform: ProjectPlatform
  distro: string
  winShell: WindowsShellKind
  /** 検出済みの WSL ディストロ。空でも欄は出す（現在値を失わせないため）。 */
  distros: readonly string[]
}>()

const emit = defineEmits<{
  'update:platform': [ProjectPlatform]
  'update:distro': [string]
  'update:winShell': [WindowsShellKind]
}>()

const settings = useSettingsStore()

// 非表示のプロファイルは除くが、現在値だけは残す（保存済みの選択を失わせない）。
const distroOptions = computed(() => settings.visibleWslDistros(props.distros, props.distro))
const shellOptions = computed(() => settings.windowsShellOptions(props.winShell))
</script>

<template>
  <div v-if="isWindowsHost" class="platform-row">
    <label class="radio-label">
      <input
        type="radio"
        value="wsl"
        :checked="platform === 'wsl'"
        @change="emit('update:platform', 'wsl')"
      />
      WSL
    </label>
    <label class="radio-label">
      <input
        type="radio"
        value="windows"
        :checked="platform === 'windows'"
        @change="emit('update:platform', 'windows')"
      />
      Windows
    </label>
  </div>
  <select
    v-if="platform === 'wsl'"
    class="field"
    :value="distro"
    @change="emit('update:distro', ($event.target as HTMLSelectElement).value)"
  >
    <option v-for="d in distroOptions" :key="d" :value="d">{{ d }}</option>
  </select>
  <select
    v-if="platform === 'windows'"
    class="field"
    :value="winShell"
    @change="emit('update:winShell', ($event.target as HTMLSelectElement).value as WindowsShellKind)"
  >
    <option v-for="s in shellOptions" :key="s.kind" :value="s.kind">{{ s.label }}</option>
  </select>
</template>

<style scoped>
/* 親の scoped CSS は子コンポーネントの中まで届かないので、フォームの見た目をここに持つ。
   値はパネル内の詰まったフォームに合わせてある（唯一の消費者。#373）。 */
.platform-row {
  display: flex;
  gap: 12px;
}

.radio-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-primary);
  cursor: pointer;
}

.radio-label input {
  accent-color: var(--accent);
}

.field {
  padding: 4px 8px;
  border: 1px solid var(--border);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 12px;
  border-radius: 3px;
  outline: none;
}

.field:focus {
  border-color: var(--accent);
}
</style>
