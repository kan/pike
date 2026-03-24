<script setup lang="ts">
import { ref, watch, nextTick } from "vue";
import { useConfirmDialog } from "../composables/useConfirmDialog";

const { visible, message, respond } = useConfirmDialog();
const okBtn = ref<HTMLButtonElement | null>(null);

watch(visible, (val) => {
  if (val) nextTick(() => okBtn.value?.focus());
});

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") respond(true);
  if (e.key === "Escape") respond(false);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="overlay" @click.self="respond(false)" @keydown="onKeydown">
      <div class="dialog">
        <p class="dialog-message">{{ message }}</p>
        <div class="dialog-actions">
          <button class="btn btn-cancel" @click="respond(false)">Cancel</button>
          <button ref="okBtn" class="btn btn-ok" @click="respond(true)">OK</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.dialog {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 20px 24px;
  min-width: 320px;
  max-width: 480px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.dialog-message {
  margin: 0 0 16px 0;
  color: var(--text-primary);
  font-size: 13px;
  line-height: 1.5;
  word-break: break-word;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.btn {
  padding: 5px 16px;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.btn:hover {
  background: var(--tab-hover-bg);
}

.btn:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 1px;
}

.btn-ok {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.btn-ok:hover {
  filter: brightness(1.15);
  background: var(--accent);
}
</style>
