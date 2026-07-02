// Preset accent colors for projects (same palette as musql's connection
// profiles). The name doubles as the i18n key suffix: projectColor.{name}
export const PROJECT_COLORS: { name: string; value: string }[] = [
  { name: 'red', value: '#d24a4a' },
  { name: 'orange', value: '#e67e22' },
  { name: 'yellow', value: '#f1c40f' },
  { name: 'green', value: '#27ae60' },
  { name: 'teal', value: '#1abc9c' },
  { name: 'blue', value: '#2980b9' },
  { name: 'purple', value: '#8e44ad' },
  { name: 'pink', value: '#e84393' },
]

/**
 * ProjectConfig.color stores the preset NAME (hex stays tunable without a
 * config migration). Resolve to a CSS value at render time. A hand-edited
 * config may hold a raw hex; accept only that exact shape so an arbitrary
 * CSS value (e.g. `url(...)`) can never reach a style binding.
 */
export function projectColorValue(color: string | undefined): string | undefined {
  if (!color) return undefined
  const preset = PROJECT_COLORS.find((c) => c.name === color)
  if (preset) return preset.value
  return /^#[0-9a-f]{6}$/i.test(color) ? color : undefined
}
