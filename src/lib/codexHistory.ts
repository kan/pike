import { toRaw } from 'vue'
import type { ChatMessage } from '../types/chat'

const DB_NAME = 'pike-codex'
const DB_VERSION = 1
const STORE_NAME = 'chat-history'
const MAX_MESSAGES = 200

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME)
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => {
        dbPromise = null
        reject(req.error)
      }
    })
  }
  return dbPromise
}

function txStore(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME)
}

/** Save chat messages for a thread. Keeps only the last MAX_MESSAGES. */
export async function saveChatHistory(threadId: string, messages: ChatMessage[]): Promise<void> {
  try {
    const db = await openDb()
    const trimmed = JSON.parse(JSON.stringify(messages.slice(-MAX_MESSAGES).map(toRaw)))
    return new Promise((resolve, reject) => {
      const req = txStore(db, 'readwrite').put(trimmed, threadId)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } catch (e) {
    console.warn('[codex-history] Failed to save:', e)
  }
}

/** Load chat messages for a thread. Returns empty array if not found. */
export async function loadChatHistory(threadId: string): Promise<ChatMessage[]> {
  try {
    const db = await openDb()
    return new Promise((resolve, reject) => {
      const req = txStore(db, 'readonly').get(threadId)
      req.onsuccess = () => resolve((req.result as ChatMessage[]) ?? [])
      req.onerror = () => reject(req.error)
    })
  } catch (e) {
    console.warn('[codex-history] Failed to load:', e)
    return []
  }
}

/** Delete chat history for a thread. */
export async function deleteChatHistory(threadId: string): Promise<void> {
  try {
    const db = await openDb()
    return new Promise((resolve, reject) => {
      const req = txStore(db, 'readwrite').delete(threadId)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } catch (e) {
    console.warn('[codex-history] Failed to delete:', e)
  }
}
