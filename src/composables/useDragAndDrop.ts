import { type Ref, ref } from 'vue'

export interface UseDragAndDropReturn<ID extends string> {
  /** ID of the currently dragged item, or null when nothing is being dragged. */
  dragId: Ref<ID | null>
  /** ID of the current drop target the pointer is hovering over, or null. */
  dragOverTarget: Ref<ID | null>
  /** Call from `@dragstart`. Records the dragged ID and writes `text/plain` to dataTransfer. */
  startDrag: (e: DragEvent, id: ID) => void
  /** Call from `@dragend` (or after a successful drop) to clear both refs. */
  resetDrag: () => void
}

export function useDragAndDrop<ID extends string = string>(
  effectAllowed: DataTransfer['effectAllowed'] = 'move',
): UseDragAndDropReturn<ID> {
  const dragId: Ref<ID | null> = ref(null)
  const dragOverTarget: Ref<ID | null> = ref(null)

  function startDrag(e: DragEvent, id: ID) {
    dragId.value = id
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = effectAllowed
      e.dataTransfer.setData('text/plain', id)
    }
  }

  function resetDrag() {
    dragId.value = null
    dragOverTarget.value = null
  }

  return { dragId, dragOverTarget, startDrag, resetDrag }
}
