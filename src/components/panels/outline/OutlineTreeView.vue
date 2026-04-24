<script setup lang="ts">
import {
  Box,
  Braces,
  ChevronDown,
  ChevronRight,
  Code2,
  Component as ComponentIcon,
  Cuboid,
  Hash,
  Hexagon,
  Layers,
  Package,
  Parentheses,
  Type as TypeIcon,
  Wrench,
} from 'lucide-vue-next'
import { type Component, computed, ref } from 'vue'
import type { OutlineKind, OutlineNode } from '../../../lib/outline'

const props = defineProps<{
  nodes: OutlineNode[]
  depth?: number
}>()

const emit = defineEmits<(e: 'select', node: OutlineNode) => void>()

const level = computed(() => props.depth ?? 0)

const collapsed = ref<Set<string>>(new Set())

function toggle(id: string, e: MouseEvent) {
  e.stopPropagation()
  if (collapsed.value.has(id)) collapsed.value.delete(id)
  else collapsed.value.add(id)
  // Trigger reactivity since Set mutation is not tracked deeply
  collapsed.value = new Set(collapsed.value)
}

function isCollapsed(id: string): boolean {
  return collapsed.value.has(id)
}

const KIND_ICONS: Record<OutlineKind, Component> = {
  class: ComponentIcon,
  interface: Braces,
  function: Parentheses,
  method: Parentheses,
  constructor: Parentheses,
  property: Code2,
  field: Box,
  variable: Box,
  constant: Hexagon,
  enum: Layers,
  enumMember: Hexagon,
  module: Package,
  namespace: Package,
  struct: Cuboid,
  trait: Braces,
  impl: Layers,
  macro: Code2,
  type: TypeIcon,
  heading: Hash,
  section: Hash,
  key: Wrench,
}

function iconFor(kind: OutlineKind): Component {
  return KIND_ICONS[kind] ?? Box
}
</script>

<template>
  <div class="outline-tree">
    <template v-for="node in nodes" :key="node.id">
      <div
        class="tree-item"
        :style="{ paddingLeft: level * 12 + 4 + 'px' }"
        @click="emit('select', node)"
      >
        <span
          v-if="node.children.length > 0"
          class="tree-chevron"
          @click="(e) => toggle(node.id, e)"
        >
          <ChevronDown v-if="!isCollapsed(node.id)" :size="12" :stroke-width="1.5" />
          <ChevronRight v-else :size="12" :stroke-width="1.5" />
        </span>
        <span v-else class="tree-chevron-space" />
        <span class="tree-icon">
          <component :is="iconFor(node.kind)" :size="14" :stroke-width="1.5" />
        </span>
        <span class="tree-name" :title="node.detail || node.name">{{ node.name }}</span>
        <span v-if="node.detail" class="tree-detail">{{ node.detail }}</span>
      </div>
      <OutlineTreeView
        v-if="node.children.length > 0 && !isCollapsed(node.id)"
        :nodes="node.children"
        :depth="level + 1"
        @select="(n) => emit('select', n)"
      />
    </template>
  </div>
</template>

<style scoped>
.outline-tree {
  display: flex;
  flex-direction: column;
}

.tree-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px;
  cursor: pointer;
  font-size: 12px;
  border-radius: 3px;
  white-space: nowrap;
  user-select: none;
}

.tree-item:hover {
  background: var(--tab-hover-bg);
}

.tree-chevron {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  flex-shrink: 0;
  color: var(--text-secondary);
}

.tree-chevron-space {
  width: 12px;
  flex-shrink: 0;
}

.tree-icon {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
}

.tree-name {
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-primary);
}

.tree-detail {
  color: var(--text-secondary);
  font-size: 11px;
  margin-left: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
