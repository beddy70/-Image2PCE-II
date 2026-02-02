use base64::Engine;
use image::imageops::colorops::{dither, ColorMap};
use image::{imageops::FilterType, DynamicImage, Rgba, RgbaImage};
use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

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
    input_path: String,
    resize_method: String,
    palette_count: u8,
    dither_mode: String,
    background_color: String,
    keep_ratio: bool,
) -> Result<ConversionResult, String> {
    let image = image::open(&input_path).map_err(|e| e.to_string())?;
    let resized = resize_to_target(
        image,
        256,
        256,
        &resize_method,
        keep_ratio,
        &background_color,
    )?;
    // First pass: quantize to RGB333 WITHOUT dithering to build palettes
    let quantized_for_palette = quantize_rgb333(resized.clone(), palette_count, "none", &background_color)?;
    let palette_result = build_palettes_for_tiles(
        &quantized_for_palette,
        palette_count as usize,
        &background_color,
    )?;
    // Second pass: apply dithering with the actual tile palettes
    let preview = apply_tile_palettes_with_dither(
        &resized.to_rgba8(),
        &palette_result,
        &dither_mode,
    )?;
    let mut output = Vec::new();
    DynamicImage::ImageRgba8(preview)
        .write_to(&mut std::io::Cursor::new(&mut output), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;

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

fn build_palettes_for_tiles(
    image: &RgbaImage,
    palette_count: usize,
    background_color: &str,
) -> Result<TilePaletteResult, String> {
    let tiles = extract_tile_colors(image);
    let palette_slots = palette_count.max(1).min(16);
    let global_color0 = parse_hex_color(background_color)
        .map(|color| format!("#{:02X}{:02X}{:02X}", color.0[0], color.0[1], color.0[2]))
        .unwrap_or_else(|| "#000000".to_string());
    let mut clusters = seed_palette_clusters(&tiles, palette_slots, &global_color0);
    let mut tile_palette_map = vec![0usize; tiles.len()];

    for _ in 0..4 {
        for (tile_index, tile_colors) in tiles.iter().enumerate() {
            let palette_index = best_cluster_for_tile(&clusters, tile_colors, &global_color0);
            tile_palette_map[tile_index] = palette_index;
        }

        clusters = rebuild_clusters(&tiles, &tile_palette_map, palette_slots, &global_color0);
    }

    let mut palette_colors = Vec::new();
    let mut palettes = Vec::new();
    for cluster in clusters.iter_mut() {
        cluster.sort();
        cluster.dedup();
        if !cluster.contains(&global_color0) {
            cluster.insert(0, global_color0.clone());
        }
        // Use intelligent color reduction instead of truncation
        if cluster.len() > 16 {
            reduce_palette_to_size(cluster, 16, &global_color0);
        }
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

    Ok(TilePaletteResult {
        palettes,
        tile_palette_map,
        palette_colors,
    })
}

fn extract_tile_colors(image: &RgbaImage) -> Vec<Vec<String>> {
    let mut tiles = Vec::new();
    let (width, height) = image.dimensions();
    let tiles_x = width / 8;
    let tiles_y = height / 8;

    for ty in 0..tiles_y {
        for tx in 0..tiles_x {
            let mut colors: Vec<String> = Vec::new();
            for y in 0..8 {
                for x in 0..8 {
                    let px = image.get_pixel(tx * 8 + x, ty * 8 + y);
                    let [r, g, b, _] = px.0;
                    let color = format!("#{:02X}{:02X}{:02X}", r, g, b);
                    if !colors.contains(&color) {
                        colors.push(color);
                    }
                }
            }
            colors.sort();
            tiles.push(colors);
        }
    }

    tiles
}

fn seed_palette_clusters(
    tiles: &[Vec<String>],
    palette_slots: usize,
    color0: &str,
) -> Vec<Vec<String>> {
    // Collect all unique colors from all tiles with their frequency
    use std::collections::HashMap;
    let mut color_frequency: HashMap<String, usize> = HashMap::new();
    for tile_colors in tiles.iter() {
        for color in tile_colors.iter() {
            *color_frequency.entry(color.clone()).or_insert(0) += 1;
        }
    }

    // Sort colors by frequency (most common first)
    let mut all_colors: Vec<_> = color_frequency.into_iter().collect();
    all_colors.sort_by(|a, b| b.1.cmp(&a.1));

    // Select diverse seed colors using a greedy approach
    let mut seed_colors: Vec<String> = vec![color0.to_string()];
    for (color, _) in all_colors.iter() {
        if color == color0 {
            continue;
        }
        // Check if this color is sufficiently different from existing seeds
        let mut min_dist = u32::MAX;
        if let Some(new_c) = parse_hex_color(color) {
            for existing in seed_colors.iter() {
                if let Some(existing_c) = parse_hex_color(existing) {
                    let dr = new_c.0[0] as i32 - existing_c.0[0] as i32;
                    let dg = new_c.0[1] as i32 - existing_c.0[1] as i32;
                    let db = new_c.0[2] as i32 - existing_c.0[2] as i32;
                    let dist = (dr * dr + dg * dg + db * db) as u32;
                    min_dist = min_dist.min(dist);
                }
            }
        }
        // Only add if sufficiently different (threshold: ~20 units per channel)
        if min_dist > 1200 || seed_colors.len() < palette_slots * 4 {
            seed_colors.push(color.clone());
        }
        if seed_colors.len() >= palette_slots * 16 {
            break;
        }
    }

    // Now build initial palettes by selecting tiles with diverse color profiles
    let mut palettes = Vec::new();
    let mut used_tiles: Vec<bool> = vec![false; tiles.len()];

    // Score each tile by how many unique colors it contributes
    let mut tile_scores: Vec<(usize, usize)> = tiles
        .iter()
        .enumerate()
        .map(|(i, colors)| (i, colors.len()))
        .collect();
    tile_scores.sort_by(|a, b| b.1.cmp(&a.1));

    // Select tiles with most colors first, ensuring diversity
    for (tile_idx, _) in tile_scores.iter() {
        if palettes.len() >= palette_slots {
            break;
        }
        if used_tiles[*tile_idx] {
            continue;
        }

        let mut palette = tiles[*tile_idx].clone();
        palette.sort();
        palette.dedup();
        if !palette.contains(&color0.to_string()) {
            palette.insert(0, color0.to_string());
        }
        if palette.len() > 16 {
            reduce_palette_to_size(&mut palette, 16, color0);
        }
        palettes.push(palette);
        used_tiles[*tile_idx] = true;
    }

    while palettes.len() < palette_slots {
        palettes.push(vec![color0.to_string()]);
    }

    palettes
}

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
        // Use intelligent color reduction instead of truncation
        if palette.len() > 16 {
            reduce_palette_to_size(palette, 16, color0);
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

/// Reduce a palette to max_colors by iteratively merging the two closest colors
fn reduce_palette_to_size(palette: &mut Vec<String>, max_colors: usize, preserve_color0: &str) {
    while palette.len() > max_colors {
        // Find the two closest colors (excluding color0 from being merged away)
        let mut min_dist = u32::MAX;
        let mut merge_from = 0;
        let mut merge_to = 0;

        for i in 0..palette.len() {
            // Don't merge away color0
            if palette[i] == preserve_color0 {
                continue;
            }
            for j in 0..palette.len() {
                if i == j {
                    continue;
                }
                if let (Some(c1), Some(c2)) = (parse_hex_color(&palette[i]), parse_hex_color(&palette[j])) {
                    let dr = c1.0[0] as i32 - c2.0[0] as i32;
                    let dg = c1.0[1] as i32 - c2.0[1] as i32;
                    let db = c1.0[2] as i32 - c2.0[2] as i32;
                    let dist = (dr * dr + dg * dg + db * db) as u32;
                    if dist < min_dist {
                        min_dist = dist;
                        merge_from = i;
                        merge_to = j;
                    }
                }
            }
        }

        // Remove the color that will be merged (keep merge_to)
        if merge_from != merge_to && merge_from < palette.len() {
            palette.remove(merge_from);
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
