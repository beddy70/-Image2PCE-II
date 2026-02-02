use base64::Engine;
use image::imageops::colorops::{dither, ColorMap};
use image::{imageops::FilterType, DynamicImage, Rgba, RgbaImage};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::DialogExt;

#[derive(Clone, Serialize)]
struct ProgressEvent {
    percent: u8,
    stage: String,
}

#[tauri::command]
async fn open_image(app: AppHandle) -> Result<Option<String>, String> {
    let file = app
        .dialog()
        .file()
        .add_filter("Images", &["png", "jpg", "jpeg", "webp", "gif", "bmp"])
        .blocking_pick_file();

    let resolved = file
        .and_then(|path| path.into_path().ok())
        .map(|path| path.to_string_lossy().to_string());

    Ok(resolved)
}

#[derive(Serialize)]
struct ConversionResult {
    preview_base64: String,
    palettes: Vec<Vec<String>>,
    tile_palette_map: Vec<usize>,
}

#[tauri::command]
fn run_conversion(
    app: AppHandle,
    input_path: String,
    resize_method: String,
    palette_count: u8,
    dither_mode: String,
    background_color: String,
    keep_ratio: bool,
) -> Result<ConversionResult, String> {
    // Emit: loading image
    let _ = app.emit("conversion-progress", ProgressEvent {
        percent: 5,
        stage: "Chargement de l'image...".to_string(),
    });

    let image = image::open(&input_path).map_err(|e| e.to_string())?;

    // Emit: resizing
    let _ = app.emit("conversion-progress", ProgressEvent {
        percent: 15,
        stage: "Redimensionnement...".to_string(),
    });

    let resized = resize_to_target(
        image,
        256,
        256,
        &resize_method,
        keep_ratio,
        &background_color,
    )?;

    // Emit: quantization
    let _ = app.emit("conversion-progress", ProgressEvent {
        percent: 30,
        stage: "Quantification RGB333...".to_string(),
    });

    // First pass: quantize to RGB333 WITHOUT dithering to build palettes
    let quantized_for_palette = quantize_rgb333(resized.clone(), palette_count, "none", &background_color)?;

    // Emit: palette building
    let _ = app.emit("conversion-progress", ProgressEvent {
        percent: 50,
        stage: "Construction des palettes...".to_string(),
    });

    let palette_result = build_palettes_for_tiles(
        &quantized_for_palette,
        palette_count as usize,
        &background_color,
    )?;

    // Emit: applying palettes with dithering
    let _ = app.emit("conversion-progress", ProgressEvent {
        percent: 70,
        stage: "Application des palettes...".to_string(),
    });

    // Second pass: apply dithering with the actual tile palettes
    let preview = apply_tile_palettes_with_dither(
        &resized.to_rgba8(),
        &palette_result,
        &dither_mode,
    )?;

    // Emit: encoding
    let _ = app.emit("conversion-progress", ProgressEvent {
        percent: 90,
        stage: "Encodage PNG...".to_string(),
    });

    let mut output = Vec::new();
    DynamicImage::ImageRgba8(preview)
        .write_to(&mut std::io::Cursor::new(&mut output), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;

    // Emit: done
    let _ = app.emit("conversion-progress", ProgressEvent {
        percent: 100,
        stage: "Terminé!".to_string(),
    });

    Ok(ConversionResult {
        preview_base64: base64::engine::general_purpose::STANDARD.encode(output),
        palettes: palette_result.palettes,
        tile_palette_map: palette_result.tile_palette_map,
    })
}

fn resize_to_target(
    image: DynamicImage,
    width: u32,
    height: u32,
    method: &str,
    keep_ratio: bool,
    background_color: &str,
) -> Result<DynamicImage, String> {
    let filter = match method {
        "nearest" => FilterType::Nearest,
        "catmullrom" => FilterType::CatmullRom,
        _ => FilterType::Lanczos3,
    };

    if !keep_ratio {
        return Ok(image.resize_exact(width, height, filter));
    }

    let resized = image.resize(width, height, filter);
    let bg = parse_hex_color(background_color).unwrap_or(Rgba([0, 0, 0, 255]));
    let mut canvas = RgbaImage::from_pixel(width, height, bg);
    let offset_x = (width - resized.width()) / 2;
    let offset_y = (height - resized.height()) / 2;
    image::imageops::overlay(&mut canvas, &resized.to_rgba8(), offset_x.into(), offset_y.into());
    Ok(DynamicImage::ImageRgba8(canvas))
}

fn quantize_rgb333(
    image: DynamicImage,
    palette_count: u8,
    dither_mode: &str,
    background_color: &str,
) -> Result<RgbaImage, String> {
    let mut rgba = image.to_rgba8();
    let bg = parse_hex_color(background_color).unwrap_or(Rgba([0, 0, 0, 255]));
    let levels = levels_from_palette(palette_count);
    let map = Rgb333Map { levels };

    for pixel in rgba.pixels_mut() {
        if pixel.0[3] == 0 {
            *pixel = bg;
        } else {
            pixel.0[3] = 255;
        }
    }

    if dither_mode == "floyd" {
        dither(&mut rgba, &map);
    } else {
        for pixel in rgba.pixels_mut() {
            map.map_color(pixel);
        }
    }

    Ok(rgba)
}

fn levels_from_palette(_palette_count: u8) -> u8 {
    // PCE always uses RGB333 (3 bits per channel = 8 levels)
    // The number of palettes doesn't affect the color depth
    8
}

fn quantize_channel_with_levels(value: u8, levels: u8) -> u8 {
    let max = levels.saturating_sub(1).max(1) as f32;
    let level = ((value as f32 / 255.0) * max).round();
    ((level / max) * 255.0).round() as u8
}

fn parse_hex_color(value: &str) -> Option<Rgba<u8>> {
    let cleaned = value.trim_start_matches('#');
    if cleaned.len() != 6 {
        return None;
    }
    let r = u8::from_str_radix(&cleaned[0..2], 16).ok()?;
    let g = u8::from_str_radix(&cleaned[2..4], 16).ok()?;
    let b = u8::from_str_radix(&cleaned[4..6], 16).ok()?;
    Some(Rgba([r, g, b, 255]))
}

struct Rgb333Map {
    levels: u8,
}

impl ColorMap for Rgb333Map {
    type Color = Rgba<u8>;

    fn index_of(&self, _color: &Self::Color) -> usize {
        0
    }

    fn map_color(&self, color: &mut Self::Color) {
        let r = quantize_channel_with_levels(color.0[0], self.levels);
        let g = quantize_channel_with_levels(color.0[1], self.levels);
        let b = quantize_channel_with_levels(color.0[2], self.levels);
        *color = Rgba([r, g, b, 255]);
    }
}

struct TilePaletteResult {
    palettes: Vec<Vec<String>>,
    tile_palette_map: Vec<usize>,
    palette_colors: Vec<Vec<String>>,
}

/// Tile info with colors and their pixel counts
struct TileColorInfo {
    colors: Vec<String>,
    color_counts: std::collections::HashMap<String, usize>,
}

fn build_palettes_for_tiles(
    image: &RgbaImage,
    palette_count: usize,
    background_color: &str,
) -> Result<TilePaletteResult, String> {
    use std::collections::HashMap;

    let tile_infos = extract_tile_colors_with_frequency(image);
    let palette_slots = palette_count.max(1).min(16);
    let global_color0 = parse_hex_color(background_color)
        .map(|color| format!("#{:02X}{:02X}{:02X}", color.0[0], color.0[1], color.0[2]))
        .unwrap_or_else(|| "#000000".to_string());

    // Collect global color frequencies across all tiles
    let mut global_color_freq: HashMap<String, usize> = HashMap::new();
    for tile_info in tile_infos.iter() {
        for (color, count) in tile_info.color_counts.iter() {
            *global_color_freq.entry(color.clone()).or_insert(0) += count;
        }
    }

    // Extract just the color lists for compatibility
    let tiles: Vec<Vec<String>> = tile_infos.iter().map(|ti| ti.colors.clone()).collect();

    // Seed initial palettes
    let mut clusters = seed_palette_clusters_v2(&tile_infos, palette_slots, &global_color0, &global_color_freq);
    let mut tile_palette_map = vec![0usize; tiles.len()];

    // Iterate to refine clustering
    for _ in 0..6 {
        // Assign each tile to best matching palette
        for (tile_index, tile_info) in tile_infos.iter().enumerate() {
            let palette_index = best_cluster_for_tile(&clusters, &tile_info.colors, &global_color0);
            tile_palette_map[tile_index] = palette_index;
        }

        // Rebuild palettes from assigned tiles, using frequency-weighted selection
        clusters = rebuild_clusters_with_frequency(
            &tile_infos,
            &tile_palette_map,
            palette_slots,
            &global_color0,
        );
    }

    let mut palette_colors = Vec::new();
    let mut palettes = Vec::new();
    for cluster in clusters.iter_mut() {
        // Remove color0 before sorting to ensure it stays at position 0
        cluster.retain(|c| c != &global_color0);
        cluster.sort();
        cluster.dedup();
        // Truncate to 15 colors (leaving room for color0 at position 0)
        if cluster.len() > 15 {
            cluster.truncate(15);
        }
        // Always insert color0 at position 0
        cluster.insert(0, global_color0.clone());

        palette_colors.push(cluster.clone());
        let mut padded = cluster.clone();
        while padded.len() < 16 {
            padded.push(global_color0.clone());
        }
        palettes.push(padded);
    }

    while palettes.len() < 16 {
        palettes.push(vec![global_color0.clone(); 16]);
        palette_colors.push(vec![global_color0.clone()]);
    }

    // Compact palettes: move unused palettes to the end
    let (palettes, palette_colors, tile_palette_map) = compact_palettes(
        palettes,
        palette_colors,
        tile_palette_map,
        &global_color0,
    );

    Ok(TilePaletteResult {
        palettes,
        tile_palette_map,
        palette_colors,
    })
}

/// Compact palettes by moving unused/empty ones to the end.
/// A palette is considered "empty" if it only contains color0.
/// Returns reordered palettes and updated tile_palette_map.
fn compact_palettes(
    palettes: Vec<Vec<String>>,
    palette_colors: Vec<Vec<String>>,
    mut tile_palette_map: Vec<usize>,
    color0: &str,
) -> (Vec<Vec<String>>, Vec<Vec<String>>, Vec<usize>) {
    // Determine which palettes are "useful" (have real colors, not just color0)
    let is_useful_palette: Vec<bool> = palette_colors
        .iter()
        .map(|colors| {
            // A palette is useful if it has at least one color that isn't color0
            colors.iter().any(|c| c != color0)
        })
        .collect();

    // Count how many tiles use each palette
    let mut usage_count = vec![0usize; palettes.len()];
    for &palette_idx in tile_palette_map.iter() {
        if palette_idx < usage_count.len() {
            usage_count[palette_idx] += 1;
        }
    }

    // Build mapping: old_index -> new_index
    // Useful palettes with tiles come first, then empty/unused palettes go to the end
    let mut used_indices: Vec<usize> = Vec::new();
    let mut unused_indices: Vec<usize> = Vec::new();

    for (idx, &count) in usage_count.iter().enumerate() {
        // A palette is "used" if it has tiles AND has real colors (not just color0)
        if count > 0 && is_useful_palette[idx] {
            used_indices.push(idx);
        } else {
            unused_indices.push(idx);
        }
    }

    // Create the new order: used palettes first, then unused
    let new_order: Vec<usize> = used_indices.iter().chain(unused_indices.iter()).cloned().collect();

    // Build reverse mapping: old_index -> new_index
    let mut old_to_new = vec![0usize; palettes.len()];
    for (new_idx, &old_idx) in new_order.iter().enumerate() {
        old_to_new[old_idx] = new_idx;
    }

    // Reorder palettes and palette_colors
    let reordered_palettes: Vec<Vec<String>> = new_order.iter().map(|&idx| palettes[idx].clone()).collect();
    let reordered_colors: Vec<Vec<String>> = new_order.iter().map(|&idx| palette_colors[idx].clone()).collect();

    // Update tile_palette_map with new indices
    for idx in tile_palette_map.iter_mut() {
        *idx = old_to_new[*idx];
    }

    (reordered_palettes, reordered_colors, tile_palette_map)
}

fn extract_tile_colors(image: &RgbaImage) -> Vec<Vec<String>> {
    extract_tile_colors_with_frequency(image)
        .into_iter()
        .map(|ti| ti.colors)
        .collect()
}

fn extract_tile_colors_with_frequency(image: &RgbaImage) -> Vec<TileColorInfo> {
    use std::collections::HashMap;

    let mut tiles = Vec::new();
    let (width, height) = image.dimensions();
    let tiles_x = width / 8;
    let tiles_y = height / 8;

    for ty in 0..tiles_y {
        for tx in 0..tiles_x {
            let mut color_counts: HashMap<String, usize> = HashMap::new();
            for y in 0..8 {
                for x in 0..8 {
                    let px = image.get_pixel(tx * 8 + x, ty * 8 + y);
                    let [r, g, b, _] = px.0;
                    let color = format!("#{:02X}{:02X}{:02X}", r, g, b);
                    *color_counts.entry(color).or_insert(0) += 1;
                }
            }
            let mut colors: Vec<String> = color_counts.keys().cloned().collect();
            colors.sort();
            tiles.push(TileColorInfo { colors, color_counts });
        }
    }

    tiles
}

fn seed_palette_clusters_v2(
    tile_infos: &[TileColorInfo],
    palette_slots: usize,
    color0: &str,
    global_freq: &std::collections::HashMap<String, usize>,
) -> Vec<Vec<String>> {
    use std::collections::HashMap;

    // Group tiles by their dominant color (most frequent color in tile, excluding color0)
    let mut dominant_groups: HashMap<String, Vec<usize>> = HashMap::new();
    for (idx, tile_info) in tile_infos.iter().enumerate() {
        let dominant = tile_info
            .color_counts
            .iter()
            .filter(|(c, _)| *c != color0)
            .max_by_key(|(_, count)| *count)
            .map(|(c, _)| c.clone())
            .unwrap_or_else(|| color0.to_string());
        dominant_groups.entry(dominant).or_default().push(idx);
    }

    // Sort dominant colors by how many tiles they represent
    let mut dominant_colors: Vec<_> = dominant_groups.iter().collect();
    dominant_colors.sort_by(|a, b| b.1.len().cmp(&a.1.len()));

    // Build initial palettes from the most representative tiles
    let mut palettes = Vec::new();
    let mut used_tiles: Vec<bool> = vec![false; tile_infos.len()];

    for (dominant_color, tile_indices) in dominant_colors.iter() {
        if palettes.len() >= palette_slots {
            break;
        }

        // Find the tile in this group that has the most common colors (by global frequency)
        let best_tile_idx = tile_indices
            .iter()
            .filter(|idx| !used_tiles[**idx])
            .max_by_key(|idx| {
                tile_infos[**idx]
                    .colors
                    .iter()
                    .map(|c| global_freq.get(c).unwrap_or(&0))
                    .sum::<usize>()
            });

        if let Some(&tile_idx) = best_tile_idx {
            let tile_info = &tile_infos[tile_idx];
            let mut palette: Vec<(String, usize)> = tile_info
                .color_counts
                .iter()
                .map(|(c, count)| (c.clone(), *count))
                .collect();
            palette.sort_by(|a, b| b.1.cmp(&a.1));

            let mut final_palette: Vec<String> = vec![color0.to_string()];
            for (color, _) in palette.iter() {
                if color != color0 && !final_palette.contains(color) {
                    final_palette.push(color.clone());
                }
                if final_palette.len() >= 16 {
                    break;
                }
            }

            palettes.push(final_palette);
            used_tiles[tile_idx] = true;
        }
    }

    while palettes.len() < palette_slots {
        palettes.push(vec![color0.to_string()]);
    }

    palettes
}

#[allow(dead_code)]
fn seed_palette_clusters(
    tiles: &[Vec<String>],
    palette_slots: usize,
    color0: &str,
) -> Vec<Vec<String>> {
    // Legacy function - redirect to simple implementation
    let mut palettes = Vec::new();
    for tile_colors in tiles.iter() {
        if palettes.len() >= palette_slots {
            break;
        }
        let mut palette = tile_colors.clone();
        palette.sort();
        palette.dedup();
        if !palette.contains(&color0.to_string()) {
            palette.insert(0, color0.to_string());
        }
        if palette.len() > 16 {
            palette.truncate(16);
        }
        palettes.push(palette);
    }
    while palettes.len() < palette_slots {
        palettes.push(vec![color0.to_string()]);
    }
    palettes
}

fn rebuild_clusters_with_frequency(
    tile_infos: &[TileColorInfo],
    tile_palette_map: &[usize],
    palette_slots: usize,
    color0: &str,
) -> Vec<Vec<String>> {
    use std::collections::HashMap;

    let mut palette_color_freq: Vec<HashMap<String, usize>> = vec![HashMap::new(); palette_slots];

    // Accumulate color frequencies for each palette from assigned tiles
    for (tile_info, palette_index) in tile_infos.iter().zip(tile_palette_map.iter()) {
        for (color, count) in tile_info.color_counts.iter() {
            *palette_color_freq[*palette_index].entry(color.clone()).or_insert(0) += count;
        }
    }

    // Build palettes by selecting the most frequent colors (keeping originals, no averaging)
    let mut palettes: Vec<Vec<String>> = Vec::new();

    for freq_map in palette_color_freq.iter() {
        // Sort colors by frequency (most used first)
        let mut color_freq: Vec<_> = freq_map.iter().collect();
        color_freq.sort_by(|a, b| b.1.cmp(a.1));

        let mut palette = vec![color0.to_string()];

        for (color, _) in color_freq.iter() {
            if *color != color0 && !palette.contains(color) {
                palette.push((*color).clone());
            }
            if palette.len() >= 16 {
                break;
            }
        }

        palettes.push(palette);
    }

    palettes
}

#[allow(dead_code)]
fn rebuild_clusters(
    tiles: &[Vec<String>],
    tile_palette_map: &[usize],
    palette_slots: usize,
    color0: &str,
) -> Vec<Vec<String>> {
    let mut palettes: Vec<Vec<String>> = vec![Vec::new(); palette_slots];
    for (tile_colors, palette_index) in tiles.iter().zip(tile_palette_map.iter()) {
        merge_palette(&mut palettes[*palette_index], tile_colors);
    }

    for palette in palettes.iter_mut() {
        palette.sort();
        palette.dedup();
        if !palette.contains(&color0.to_string()) {
            palette.insert(0, color0.to_string());
        }
        if palette.len() > 16 {
            palette.truncate(16);
        }
    }

    palettes
}

fn can_merge_palette(existing: &[String], incoming: &[String]) -> bool {
    let mut total = existing.len();
    for color in incoming.iter() {
        if !existing.contains(color) {
            total += 1;
        }
    }
    total <= 16
}

fn merge_palette(existing: &mut Vec<String>, incoming: &[String]) {
    for color in incoming.iter() {
        if !existing.contains(color) {
            existing.push(color.clone());
        }
    }
}

/// Reduce a palette to max_colors by keeping the most frequent colors
/// No longer uses averaging - keeps original RGB333 colors
#[allow(dead_code)]
fn reduce_palette_to_size(palette: &mut Vec<String>, max_colors: usize, preserve_color0: &str) {
    while palette.len() > max_colors {
        // Find the two closest colors (excluding color0 from being merged away)
        let mut min_dist = u32::MAX;
        let mut merge_i = 0;
        let mut merge_j = 0;

        for i in 0..palette.len() {
            // Don't merge away color0
            if palette[i] == preserve_color0 {
                continue;
            }
            for j in (i + 1)..palette.len() {
                // Don't merge color0 either
                if palette[j] == preserve_color0 {
                    continue;
                }
                if let (Some(c1), Some(c2)) = (parse_hex_color(&palette[i]), parse_hex_color(&palette[j])) {
                    let dr = c1.0[0] as i32 - c2.0[0] as i32;
                    let dg = c1.0[1] as i32 - c2.0[1] as i32;
                    let db = c1.0[2] as i32 - c2.0[2] as i32;
                    let dist = (dr * dr + dg * dg + db * db) as u32;
                    if dist < min_dist {
                        min_dist = dist;
                        merge_i = i;
                        merge_j = j;
                    }
                }
            }
        }

        // Merge the two closest colors by computing their average
        if merge_i != merge_j && merge_i < palette.len() && merge_j < palette.len() {
            if let (Some(c1), Some(c2)) = (parse_hex_color(&palette[merge_i]), parse_hex_color(&palette[merge_j])) {
                // Compute average color (quantized to RGB333)
                let avg_r = ((c1.0[0] as u16 + c2.0[0] as u16) / 2) as u8;
                let avg_g = ((c1.0[1] as u16 + c2.0[1] as u16) / 2) as u8;
                let avg_b = ((c1.0[2] as u16 + c2.0[2] as u16) / 2) as u8;

                // Quantize to RGB333
                let q_r = quantize_channel_with_levels(avg_r, 8);
                let q_g = quantize_channel_with_levels(avg_g, 8);
                let q_b = quantize_channel_with_levels(avg_b, 8);

                let merged_color = format!("#{:02X}{:02X}{:02X}", q_r, q_g, q_b);

                // Remove both colors and add the merged one (if not already present)
                // Remove higher index first to avoid index shifting
                palette.remove(merge_j);
                palette.remove(merge_i);

                if !palette.contains(&merged_color) {
                    palette.push(merged_color);
                }
            }
        } else {
            // Fallback: just remove the last color that isn't color0
            for i in (0..palette.len()).rev() {
                if palette[i] != preserve_color0 {
                    palette.remove(i);
                    break;
                }
            }
        }
    }
}

fn apply_tile_palettes(
    image: &RgbaImage,
    palette_result: &TilePaletteResult,
) -> Result<RgbaImage, String> {
    apply_tile_palettes_with_dither(image, palette_result, "none")
}

fn apply_tile_palettes_with_dither(
    image: &RgbaImage,
    palette_result: &TilePaletteResult,
    dither_mode: &str,
) -> Result<RgbaImage, String> {
    let (width, height) = image.dimensions();
    let tiles_x = width / 8;
    let tiles_y = height / 8;

    // Create error buffer for Floyd-Steinberg dithering
    // We process the entire image but use per-tile palettes
    let mut error_r: Vec<Vec<f32>> = vec![vec![0.0; width as usize + 2]; height as usize + 1];
    let mut error_g: Vec<Vec<f32>> = vec![vec![0.0; width as usize + 2]; height as usize + 1];
    let mut error_b: Vec<Vec<f32>> = vec![vec![0.0; width as usize + 2]; height as usize + 1];

    let mut output = image.clone();

    for py in 0..height {
        for px in 0..width {
            let tile_x = px / 8;
            let tile_y = py / 8;
            let tile_index = (tile_y * tiles_x + tile_x) as usize;

            let palette_index = palette_result
                .tile_palette_map
                .get(tile_index)
                .copied()
                .unwrap_or(0);
            let palette = palette_result
                .palette_colors
                .get(palette_index)
                .cloned()
                .unwrap_or_default();

            let pixel = output.get_pixel(px, py);
            let [r, g, b, a] = pixel.0;

            // Add accumulated error for dithering
            let (adj_r, adj_g, adj_b) = if dither_mode == "floyd" {
                let er = error_r[py as usize][px as usize + 1];
                let eg = error_g[py as usize][px as usize + 1];
                let eb = error_b[py as usize][px as usize + 1];
                (
                    (r as f32 + er).clamp(0.0, 255.0),
                    (g as f32 + eg).clamp(0.0, 255.0),
                    (b as f32 + eb).clamp(0.0, 255.0),
                )
            } else {
                (r as f32, g as f32, b as f32)
            };

            // Find nearest color in tile's palette
            let color = format!("#{:02X}{:02X}{:02X}", adj_r as u8, adj_g as u8, adj_b as u8);
            let mapped = nearest_palette_color(&color, &palette)
                .unwrap_or_else(|| format!("#{:02X}{:02X}{:02X}", r, g, b));
            let mapped_rgba = parse_hex_color(&mapped).unwrap_or(Rgba([r, g, b, a]));

            output.put_pixel(px, py, mapped_rgba);

            // Distribute error for Floyd-Steinberg
            if dither_mode == "floyd" {
                let quant_r = mapped_rgba.0[0] as f32;
                let quant_g = mapped_rgba.0[1] as f32;
                let quant_b = mapped_rgba.0[2] as f32;

                let err_r = adj_r - quant_r;
                let err_g = adj_g - quant_g;
                let err_b = adj_b - quant_b;

                let px_idx = px as usize + 1;
                let py_idx = py as usize;

                // Floyd-Steinberg error distribution: 7/16, 3/16, 5/16, 1/16
                // Right pixel (7/16)
                error_r[py_idx][px_idx + 1] += err_r * 7.0 / 16.0;
                error_g[py_idx][px_idx + 1] += err_g * 7.0 / 16.0;
                error_b[py_idx][px_idx + 1] += err_b * 7.0 / 16.0;

                // Bottom-left pixel (3/16)
                error_r[py_idx + 1][px_idx - 1] += err_r * 3.0 / 16.0;
                error_g[py_idx + 1][px_idx - 1] += err_g * 3.0 / 16.0;
                error_b[py_idx + 1][px_idx - 1] += err_b * 3.0 / 16.0;

                // Bottom pixel (5/16)
                error_r[py_idx + 1][px_idx] += err_r * 5.0 / 16.0;
                error_g[py_idx + 1][px_idx] += err_g * 5.0 / 16.0;
                error_b[py_idx + 1][px_idx] += err_b * 5.0 / 16.0;

                // Bottom-right pixel (1/16)
                error_r[py_idx + 1][px_idx + 1] += err_r * 1.0 / 16.0;
                error_g[py_idx + 1][px_idx + 1] += err_g * 1.0 / 16.0;
                error_b[py_idx + 1][px_idx + 1] += err_b * 1.0 / 16.0;
            }
        }
    }

    Ok(output)
}

fn best_cluster_for_tile(
    palettes: &[Vec<String>],
    tile_colors: &[String],
    color0: &str,
) -> usize {
    let mut best_index = 0usize;
    let mut best_score = u32::MAX;
    for (index, palette) in palettes.iter().enumerate() {
        if palette.is_empty() {
            return index;
        }
        let score = palette_distance_with_color0(palette, tile_colors, color0);
        if score < best_score {
            best_score = score;
            best_index = index;
        }
    }
    best_index
}

fn palette_distance_with_color0(
    palette: &[String],
    tile_colors: &[String],
    color0: &str,
) -> u32 {
    tile_colors
        .iter()
        .map(|color| {
            let mapped = nearest_palette_color(color, palette)
                .or_else(|| Some(color0.to_string()));
            mapped
                .and_then(|mapped| {
                    let src = parse_hex_color(color)?;
                    let dst = parse_hex_color(&mapped)?;
                    let dr = src.0[0] as i32 - dst.0[0] as i32;
                    let dg = src.0[1] as i32 - dst.0[1] as i32;
                    let db = src.0[2] as i32 - dst.0[2] as i32;
                    Some((dr * dr + dg * dg + db * db) as u32)
                })
                .unwrap_or(0)
        })
        .sum()
}

fn nearest_palette_color(color: &str, palette: &[String]) -> Option<String> {
    if palette.is_empty() {
        return None;
    }
    let target = parse_hex_color(color)?;
    let (tr, tg, tb, _) = (target.0[0], target.0[1], target.0[2], target.0[3]);
    let mut best = None;
    let mut best_dist = u32::MAX;

    for entry in palette.iter() {
        if let Some(candidate) = parse_hex_color(entry) {
            let dr = tr as i32 - candidate.0[0] as i32;
            let dg = tg as i32 - candidate.0[1] as i32;
            let db = tb as i32 - candidate.0[2] as i32;
            let dist = (dr * dr + dg * dg + db * db) as u32;
            if dist < best_dist {
                best_dist = dist;
                best = Some(entry.clone());
            }
        }
    }

    best
}

fn find_global_color0(tiles: &[Vec<String>]) -> Option<String> {
    use std::collections::HashMap;
    let mut counts: HashMap<String, usize> = HashMap::new();
    for colors in tiles.iter() {
        for color in colors.iter() {
            *counts.entry(color.clone()).or_insert(0) += 1;
        }
    }
    counts.into_iter().max_by_key(|(_, count)| *count).map(|(color, _)| color)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![open_image, run_conversion])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
