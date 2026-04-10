export type NotifyFn = (title: string, body: string, onClick?: () => void) => void

let cached: NotifyFn | null | undefined

/** Resolve a notification function (Web API → Tauri plugin fallback). Cached after first call. */
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
