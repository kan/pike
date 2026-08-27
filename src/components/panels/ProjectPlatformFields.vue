<script setup lang="ts">
/**
 * プロジェクトの「プラットフォームと、それに応じたシェルの選択」欄。
 *
 * 作成フォーム（ProjectSwitcher / ProjectPanel）と編集フォーム（ProjectListItem）の
 * 3 箇所がまったく同じ 3 行を持っていたので 1 つにまとめた。**プラットフォームを
 * 増やす変更は、以前は 3 ファイルを揃って直す必要があり、コンパイラの助けが無かった**
 * （実際 browse ボタンの条件は 2 ファイルだけ直されて 1 つは条件そのものが無い、
 * という状態になっていた）。
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
  /** パネル内の詰まったフォーム。false はモーダルの広いフォーム。 */
  compact?: boolean
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
  <div v-if="isWindowsHost" class="platform-row" :class="{ compact }">
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
    :class="{ compact }"
    :value="distro"
    @change="emit('update:distro', ($event.target as HTMLSelectElement).value)"
  >
    <option v-for="d in distroOptions" :key="d" :value="d">{{ d }}</option>
  </select>
  <select
    v-if="platform === 'windows'"
    class="field"
    :class="{ compact }"
    :value="winShell"
    @change="emit('update:winShell', ($event.target as HTMLSelectElement).value as WindowsShellKind)"
  >
    <option v-for="s in shellOptions" :key="s.kind" :value="s.kind">{{ s.label }}</option>
  </select>
</template>

<style scoped>
/* 親の scoped CSS は子コンポーネントの中まで届かないので、フォームの見た目を
   ここに持つ。`compact` はパネル内の詰まったフォーム（12px 系）、既定はモーダルの
   広いフォーム（13px 系）。 */
.platform-row {
  display: flex;
  gap: 16px;
}

.platform-row.compact {
  gap: 12px;
}

.radio-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--text-primary);
  cursor: pointer;
}

.platform-row.compact .radio-label {
  font-size: 12px;
}

.radio-label input {
  accent-color: var(--accent);
}

.field {
  padding: 6px 10px;
  border: 1px solid var(--border);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 13px;
  border-radius: 4px;
  outline: none;
}

.field.compact {
  padding: 4px 8px;
  font-size: 12px;
  border-radius: 3px;
}

.field:focus {
  border-color: var(--accent);
}
</style>
