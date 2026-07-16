// Parking spot for DOM focus while the app window is deactivated.
//
// Chromium reports the focused element's text input type to the OS IME layer
// (TSF on Windows). If focus rests on <body> (TEXT_INPUT_TYPE_NONE) while the
// window is deactivated, reactivation applies NONE to TSF, which associates a
// keyboard-disabled input context with the window; re-enabling then depends on
// a NONE→TEXT transition that races the WebView2 native-focus handoff and is
// silently dropped when it loses (InputMethodWinTSF's IsWindowFocused guard),
// leaving the IME OFF with the toggle key dead. Parking focus on a hidden
// *text* input keeps the parked state TEXT, so reactivation never disables
// the IME in the first place, no matter how the refocus race resolves.
//
// Trade-off: with the parked type already TEXT, reactivation no longer gives
// TSF the NONE→TEXT transition that rebuilt its stale context (caret
// tracking / edit buffer). TerminalTab's windowFocusHandler compensates by
// bouncing the textarea through readOnly (→ input type NONE and back) once
// the window verifiably holds focus again.

let parkInput: HTMLInputElement | null = null

export function parkFocusForIme(): void {
  if (!parkInput?.isConnected) {
    const el = document.createElement('input')
    el.type = 'text'
    el.tabIndex = -1
    el.setAttribute('autocomplete', 'off')
    // Invisible but focusable: display:none / visibility:hidden would make it
    // unfocusable, and readonly/disabled would turn its input type into NONE,
    // defeating the whole point.
    el.style.cssText =
      'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;border:0;padding:0;pointer-events:none'
    document.body.appendChild(el)
    parkInput = el
  }
  parkInput.value = ''
  parkInput.focus({ preventScroll: true })
}
