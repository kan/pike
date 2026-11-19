/**
 * 今動いているセッションの状態のアイコン（#625）。サイドバーのパネルと詳細のタブが共有する
 * （`lib/liveSessions.ts` から分けてあるのは、あちらを Node のテストから読むため。lucide は
 * Vue を読み込む）。
 */
import { Loader, MessageCircleQuestion, Moon } from 'lucide-vue-next'
import type { Component } from 'vue'
import type { LiveStatus } from '../types/liveSession'

export const LIVE_STATUS_ICONS: Record<LiveStatus, Component> = {
  waiting: MessageCircleQuestion,
  busy: Loader,
  idle: Moon,
}
