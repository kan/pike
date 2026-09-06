export type NotifyFn = (title: string, body: string, onClick?: () => void) => void

let cached: NotifyFn | null | undefined

/**
 * デスクトップ通知を出す関数（Web API → Tauri プラグインの順。初回だけ解決してキャッシュ）。
 *
 * **`onClick` は当てにできない**（#265 で実機確認）。WebView2 の Web Notification は
 * `Notification.permission` が `granted` でも押したときに `onclick` が呼ばれず、ウィンドウが
 * 前に出ることもない。プラグイン側の desktop 実装は `notify_rust` へ投げっぱなしで、
 * クリックを受ける口がそもそも無い（`onAction` はモバイル専用）。**押させたい知らせを
 * ここに載せないこと**: 入力待ち（#265）はこれを使わず、タスクバーの点滅（`windowFlash`）と
 * 画面内の印にしてある。
 */
export async function resolveNotifier(): Promise<NotifyFn | null> {
  if (cached !== undefined) return cached
  cached = await resolveNotifierInner()
  return cached
}

async function resolveNotifierInner(): Promise<NotifyFn | null> {
  if ('Notification' in window) {
    if (Notification.permission === 'granted') {
      return webNotifier()
    }
    if (Notification.permission !== 'denied') {
      const result = await Notification.requestPermission()
      if (result === 'granted') return webNotifier()
    }
  }
  try {
    const { isPermissionGranted, requestPermission, sendNotification } = await import('@tauri-apps/plugin-notification')
    let permitted = await isPermissionGranted()
    if (!permitted) {
      const perm = await requestPermission()
      permitted = perm === 'granted'
    }
    if (permitted) {
      return (title, body) => sendNotification({ title, body })
    }
  } catch {
    // plugin not available
  }
  return null
}

function webNotifier(): NotifyFn {
  return (title, body, onClick) => {
    const n = new Notification(title, { body })
    if (onClick)
      n.onclick = () => {
        onClick()
        n.close()
      }
  }
}
