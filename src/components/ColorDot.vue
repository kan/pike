<script setup lang="ts">
import { computed } from 'vue'
import { projectColorValue } from '../lib/projectColors'

const props = defineProps<{ color?: string }>()

const value = computed(() => projectColorValue(props.color))
</script>

<template>
  <span v-if="value" class="color-dot" :style="{ background: value }"></span>
</template>

<style scoped>
.color-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
</style>
