<script setup lang="ts">
import { ref, computed, watch, nextTick, onUnmounted } from "vue";
import { useProjectStore } from "../../stores/project";
import { useGitStore } from "../../stores/git";

const projectStore = useProjectStore();
const gitStore = useGitStore();

// Refresh git status on project change (polling is managed by git store lifecycle in App.vue)
watch(
  () => projectStore.currentProject?.id,
  (id) => {
    if (id) {
      gitStore.refreshStatus();
    }
  },
  { immediate: true }
);

// Branch switcher dropdown
const showBranches = ref(false);
const branchQuery = ref("");

const filteredBranches = computed(() => {
  const q = branchQuery.value.toLowerCase();
  if (!q) return gitStore.branches;
  return gitStore.branches.filter((b) => b.toLowerCase().includes(q));
});

async function openBranchSwitcher() {
  await gitStore.loadBranches();
  branchQuery.value = "";
  showBranches.value = true;
  nextTick(() => {
    window.addEventListener("mousedown", closeBranches);
  });
}

function closeBranches() {
  showBranches.value = false;
  window.removeEventListener("mousedown", closeBranches);
}

async function onSelectBranch(branch: string) {
  closeBranches();
  await gitStore.checkoutBranch(branch);
}

onUnmounted(() => {
  window.removeEventListener("mousedown", closeBranches);
  gitStore.stopPolling();
});
</script>

<template>
  <div class="status-bar">
    <button
      class="status-item clickable"
      @click="projectStore.toggleSwitcher()"
    >
      {{ projectStore.currentProject?.name ?? "No project" }}
    </button>

    <div class="spacer"></div>

    <div v-if="gitStore.status" class="branch-area">
      <button class="status-item clickable" @click="openBranchSwitcher">
        <span class="branch-icon">🌿</span>
        <span>{{ gitStore.status.branch }}</span>
        <span v-if="gitStore.status.isDirty" class="dirty-dot"></span>
      </button>

      <div v-if="showBranches" class="branch-dropdown" @mousedown.stop>
        <input
          v-model="branchQuery"
          class="branch-search"
          placeholder="Switch branch..."
          @keydown.esc="closeBranches"
        />
        <div class="branch-list">
          <button
            v-for="b in filteredBranches"
            :key="b"
            class="branch-option"
            :class="{ current: b === gitStore.status?.branch }"
            @click="onSelectBranch(b)"
          >
            {{ b }}
            <span v-if="b === gitStore.status?.branch" class="current-mark">*</span>
          </button>
          <div v-if="!filteredBranches.length" class="branch-empty">No matching branches</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.status-bar {
  display: flex;
  align-items: center;
  height: 24px;
  min-height: 24px;
  background: var(--accent);
  padding: 0 8px;
  font-size: 12px;
  color: var(--text-active);
  user-select: none;
}

.status-item {
  padding: 0 8px;
  border: none;
  background: transparent;
  color: var(--text-active);
  font-size: 12px;
  height: 100%;
  display: flex;
  align-items: center;
  gap: 4px;
}

.status-item.clickable {
  cursor: pointer;
}

.status-item.clickable:hover {
  background: rgba(255, 255, 255, 0.12);
}

.spacer {
  flex: 1;
}

.branch-icon {
  font-size: 11px;
}

.dirty-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--git-modify);
  flex-shrink: 0;
}

.branch-area {
  position: relative;
}

.branch-dropdown {
  position: absolute;
  bottom: 24px;
  right: 0;
  width: 260px;
  max-height: 300px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.branch-search {
  padding: 6px 10px;
  border: none;
  border-bottom: 1px solid var(--border);
  background: var(--bg-primary);
  color: var(--text-active);
  font-size: 13px;
  outline: none;
}

.branch-search::placeholder {
  color: var(--text-secondary);
}

.branch-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.branch-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 5px 12px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.branch-option:hover {
  background: var(--tab-hover-bg);
}

.branch-option.current {
  color: var(--accent);
  font-weight: 600;
}

.current-mark {
  color: var(--accent);
}

.branch-empty {
  padding: 12px;
  text-align: center;
  color: var(--text-secondary);
  font-size: 12px;
}
</style>
