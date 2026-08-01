<script setup lang="ts">
import { computed } from 'vue'
import { projectIconValue } from '../lib/projectIcons'

const props = defineProps<{ icon?: string }>()

const value = computed(() => projectIconValue(props.icon))
</script>

<template>
  <span v-if="value" class="project-icon">{{ value }}</span>
</template>

<style scoped>
.project-icon {
  font-size: 13px;
  line-height: 1;
  flex-shrink: 0;
}
</style>
