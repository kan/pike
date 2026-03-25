use font_kit::source::SystemSource;
use font_kit::properties::Properties;
use font_kit::family_name::FamilyName;

/// List monospace font families installed on the system.
/// Uses heuristic: load each font and check if 'm' and 'i' have equal advance width.
#[tauri::command]
pub async fn font_list_monospace() -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(|| {
        let source = SystemSource::new();
        let families = source.all_families().map_err(|e| e.to_string())?;

        let mut monospace = Vec::new();
        for family in &families {
            let handle = source.select_best_match(
                &[FamilyName::Title(family.clone())],
                &Properties::new(),
            );
            if let Ok(handle) = handle {
                if let Ok(font) = handle.load() {
                    if let Some(adv_m) = font.glyph_for_char('m').and_then(|g| font.advance(g).ok()) {
                        if let Some(adv_i) = font.glyph_for_char('i').and_then(|g| font.advance(g).ok()) {
                            if (adv_m.x() - adv_i.x()).abs() < 0.01 {
                                monospace.push(family.clone());
                            }
                        }
                    }
                }
            }
        }

        monospace.sort();
        monospace.dedup();
        Ok(monospace)
    })
    .await
    .map_err(|e| e.to_string())?
}
