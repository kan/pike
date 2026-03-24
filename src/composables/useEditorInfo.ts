import { ref } from 'vue'

export interface EditorInfo {
  line: number
  col: number
  encoding: string
  lineEnding: 'LF' | 'CRLF'
  fileType: string
  tabId: string
}

// Callbacks for the active editor to respond to status bar actions
type EncodingCallback = (encoding: string) => void
type LineEndingCallback = (le: 'LF' | 'CRLF') => void
type SaveEncodingCallback = (encoding: string) => void

const current = ref<EditorInfo | null>(null)
let onChangeEncoding: EncodingCallback | null = null
let onChangeLineEnding: LineEndingCallback | null = null
let onSaveWithEncoding: SaveEncodingCallback | null = null

export function useEditorInfo() {
  function update(info: Omit<EditorInfo, 'tabId'> & { tabId: string }) {
    current.value = info
  }

  function clear() {
    current.value = null
    onChangeEncoding = null
    onChangeLineEnding = null
    onSaveWithEncoding = null
  }

  function registerCallbacks(enc: EncodingCallback, le: LineEndingCallback, saveEnc?: SaveEncodingCallback) {
    onChangeEncoding = enc
    onChangeLineEnding = le
    onSaveWithEncoding = saveEnc ?? null
  }

  function requestEncodingChange(encoding: string) {
    onChangeEncoding?.(encoding)
  }

  function requestLineEndingChange(le: 'LF' | 'CRLF') {
    onChangeLineEnding?.(le)
  }

  function requestSaveWithEncoding(encoding: string) {
    onSaveWithEncoding?.(encoding)
  }

  return { current, update, clear, registerCallbacks, requestEncodingChange, requestLineEndingChange, requestSaveWithEncoding }
}
