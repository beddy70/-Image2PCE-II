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
    empty_tiles: Vec<bool>,
    tile_count: usize,
    unique_tile_count: usize,
}

/// Resize mask from source dimensions to target dimensions using nearest neighbor
/// When keep_ratio is true, applies the same transformation as the image (resize + center)
fn resize_mask(mask: &[u8], src_width: u32, src_height: u32, dst_width: u32, dst_height: u32, keep_ratio: bool) -> Vec<u8> {
    // Start with white (no dithering) background
    let mut result = vec![255u8; (dst_width * dst_height) as usize];

    if !keep_ratio {
        // Simple stretch to fill
        for y in 0..dst_height {
            for x in 0..dst_width {
                let src_x = (x as f32 * src_width as f32 / dst_width as f32) as u32;
                let src_y = (y as f32 * src_height as f32 / dst_height as f32) as u32;
                let src_idx = (src_y * src_width + src_x) as usize;
                let dst_idx = (y * dst_width + x) as usize;

                if src_idx < mask.len() {
                    result[dst_idx] = mask[src_idx];
                }
            }
        }
    } else {
        // Calculate scaled dimensions keeping aspect ratio (same logic as resize_to_target)
        let src_ratio = src_width as f32 / src_height as f32;
        let dst_ratio = dst_width as f32 / dst_height as f32;

        let (scaled_width, scaled_height) = if src_ratio > dst_ratio {
            // Source is wider - fit to width
            let w = dst_width;
            let h = (dst_width as f32 / src_ratio).round() as u32;
            (w, h.min(dst_height))
        } else {
            // Source is taller - fit to height
            let h = dst_height;
            let w = (dst_height as f32 * src_ratio).round() as u32;
            (w.min(dst_width), h)
        };

        // Calculate offsets to center
        let offset_x = (dst_width - scaled_width) / 2;
        let offset_y = (dst_height - scaled_height) / 2;

        // Map pixels from destination to source, considering offset and scaling
        for y in 0..dst_height {
            for x in 0..dst_width {
                // Check if this pixel is within the scaled image area
                if x >= offset_x && x < offset_x + scaled_width && y >= offset_y && y < offset_y + scaled_height {
                    // Calculate source position
                    let local_x = x - offset_x;
                    let local_y = y - offset_y;
                    let src_x = (local_x as f32 * src_width as f32 / scaled_width as f32) as u32;
                    let src_y = (local_y as f32 * src_height as f32 / scaled_height as f32) as u32;
                    let src_idx = (src_y.min(src_height - 1) * src_width + src_x.min(src_width - 1)) as usize;
                    let dst_idx = (y * dst_width + x) as usize;

                    if src_idx < mask.len() {
                        result[dst_idx] = mask[src_idx];
                    }
                }
                // Pixels outside the scaled area remain white (no dithering)
            }
        }
    }

    result
}

/// Combine two images based on mask: black (0) = use dithered, white (255) = use non-dithered
fn combine_with_mask(dithered: &RgbaImage, non_dithered: &RgbaImage, mask: &[u8]) -> RgbaImage {
    let (width, height) = dithered.dimensions();
    let mut result = RgbaImage::new(width, height);

    for y in 0..height {
        for x in 0..width {
            let idx = (y * width + x) as usize;
            let mask_value = mask.get(idx).copied().unwrap_or(255);

            // mask < 128 means use dithered (black areas), otherwise use non-dithered
            let pixel = if mask_value < 128 {
                *dithered.get_pixel(x, y)
            } else {
                *non_dithered.get_pixel(x, y)
            };

            result.put_pixel(x, y, pixel);
        }
    }

    result
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
    curve_lut: Vec<u8>,
    target_width: u32,
    target_height: u32,
    use_dither_mask: bool,
    dither_mask: Vec<u8>,
    mask_width: u32,
    mask_height: u32,
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
        target_width,
        target_height,
        &resize_method,
        keep_ratio,
        &background_color,
    )?;

    // Emit: applying curve
    let _ = app.emit("conversion-progress", ProgressEvent {
        percent: 25,
        stage: "Application de la courbe...".to_string(),
    });

    // Apply curve LUT to adjust color levels before quantization
    let curved = apply_curve_lut(&resized.to_rgba8(), &curve_lut);
    let curved_image = DynamicImage::ImageRgba8(curved);

    // Emit: quantization
    let _ = app.emit("conversion-progress", ProgressEvent {
        percent: 35,
        stage: "Quantification RGB333...".to_string(),
    });

    // First pass: quantize to RGB333 WITHOUT dithering to build palettes
    let quantized_for_palette = quantize_rgb333(curved_image.clone(), palette_count, "none", &background_color)?;

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

    // Second pass: apply dithering with the actual tile palettes (using curved image)
    let preview = if use_dither_mask && !dither_mask.is_empty() && dither_mode != "none" {
        // Generate both dithered and non-dithered versions
        let dithered = apply_tile_palettes_with_dither(
            &curved_image.to_rgba8(),
            &palette_result,
            &dither_mode,
        )?;
        let non_dithered = apply_tile_palettes_with_dither(
            &curved_image.to_rgba8(),
            &palette_result,
            "none",
        )?;

        // Resize mask to target dimensions (using same keep_ratio logic as image)
        let resized_mask = resize_mask(&dither_mask, mask_width, mask_height, target_width, target_height, keep_ratio);

        // Combine based on mask (black = dithered, white = non-dithered)
        combine_with_mask(&dithered, &non_dithered, &resized_mask)
    } else {
        apply_tile_palettes_with_dither(
            &curved_image.to_rgba8(),
            &palette_result,
            &dither_mode,
        )?
    };

    // Emit: encoding
    let _ = app.emit("conversion-progress", ProgressEvent {
        percent: 90,
        stage: "Encodage PNG...".to_string(),
    });

    let mut output = Vec::new();
    DynamicImage::ImageRgba8(preview.clone())
        .write_to(&mut std::io::Cursor::new(&mut output), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;

    // Calculate unique tiles for stats
    let (width, height) = preview.dimensions();
    let tiles_x = width / 8;
    let tiles_y = height / 8;
    let total_tiles = (tiles_x * tiles_y) as usize;

    // Empty tile is always first (32 bytes of zeros = all pixels are color index 0)
    let empty_tile: [u8; 32] = [0u8; 32];
    let mut unique_tiles: Vec<[u8; 32]> = vec![empty_tile];

    for tile_idx in 0..total_tiles {
        // Skip empty tiles - they all use the first unique tile
        if palette_result.empty_tiles.get(tile_idx).copied().unwrap_or(false) {
            continue;
        }

        let tile_x = (tile_idx % tiles_x as usize) as u32;
        let tile_y = (tile_idx / tiles_x as usize) as u32;
        let palette_idx = palette_result.tile_palette_map.get(tile_idx).copied().unwrap_or(0);
        let palette = palette_result.palettes.get(palette_idx).cloned().unwrap_or_default();
        let tile_data = encode_tile_planar(&preview, tile_x, tile_y, &palette);
        if !unique_tiles.iter().any(|t| *t == tile_data) {
            unique_tiles.push(tile_data);
        }
    }

    // Emit: done
    let _ = app.emit("conversion-progress", ProgressEvent {
        percent: 100,
        stage: "Terminé!".to_string(),
    });

    Ok(ConversionResult {
        preview_base64: base64::engine::general_purpose::STANDARD.encode(output),
        palettes: palette_result.palettes,
        tile_palette_map: palette_result.tile_palette_map,
        empty_tiles: palette_result.empty_tiles,
        tile_count: total_tiles,
        unique_tile_count: unique_tiles.len(),
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

fn apply_curve_lut(image: &RgbaImage, lut: &[u8]) -> RgbaImage {
    let mut output = image.clone();

    // Ensure LUT has 256 entries, use identity if not
    if lut.len() != 256 {
        return output;
    }

    for pixel in output.pixels_mut() {
        pixel.0[0] = lut[pixel.0[0] as usize];
        pixel.0[1] = lut[pixel.0[1] as usize];
        pixel.0[2] = lut[pixel.0[2] as usize];
        // Alpha channel unchanged
    }

    output
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
    empty_tiles: Vec<bool>,
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

    // Detect empty tiles (tiles containing ONLY the background color)
    let empty_tiles: Vec<bool> = tile_infos
        .iter()
        .map(|ti| {
            // A tile is empty if it has only one color and that color is the background
            ti.colors.len() == 1 && ti.colors[0] == global_color0
        })
        .collect();

    // Filter out empty tiles for palette building
    let non_empty_tile_infos: Vec<&TileColorInfo> = tile_infos
        .iter()
        .enumerate()
        .filter(|(idx, _)| !empty_tiles[*idx])
        .map(|(_, ti)| ti)
        .collect();

    // Collect global color frequencies across non-empty tiles only
    let mut global_color_freq: HashMap<String, usize> = HashMap::new();
    for tile_info in non_empty_tile_infos.iter() {
        for (color, count) in tile_info.color_counts.iter() {
            *global_color_freq.entry(color.clone()).or_insert(0) += count;
        }
    }

    // Extract just the color lists for compatibility
    let tiles: Vec<Vec<String>> = tile_infos.iter().map(|ti| ti.colors.clone()).collect();

    // Seed initial palettes using only non-empty tiles
    let non_empty_infos_owned: Vec<TileColorInfo> = non_empty_tile_infos
        .iter()
        .map(|ti| TileColorInfo {
            colors: ti.colors.clone(),
            color_counts: ti.color_counts.clone(),
        })
        .collect();
    let mut clusters = seed_palette_clusters_v2(&non_empty_infos_owned, palette_slots, &global_color0, &global_color_freq);
    let mut tile_palette_map = vec![0usize; tiles.len()];

    // Iterate to refine clustering (only for non-empty tiles)
    for _ in 0..6 {
        // Assign each non-empty tile to best matching palette
        for (tile_index, tile_info) in tile_infos.iter().enumerate() {
            if empty_tiles[tile_index] {
                // Empty tiles stay at palette 0 (which has color0)
                tile_palette_map[tile_index] = 0;
            } else {
                let palette_index = best_cluster_for_tile(&clusters, &tile_info.colors, &global_color0);
                tile_palette_map[tile_index] = palette_index;
            }
        }

        // Rebuild palettes from assigned non-empty tiles only
        clusters = rebuild_clusters_with_frequency_filtered(
            &tile_infos,
            &tile_palette_map,
            &empty_tiles,
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
        empty_tiles,
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
    // Useful palettes with tiles come first (sorted by usage descending), then empty/unused palettes go to the end
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

    // Sort used palettes by usage count descending (most used first)
    used_indices.sort_by(|&a, &b| usage_count[b].cmp(&usage_count[a]));

    // Create the new order: used palettes first (sorted by usage), then unused
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

fn rebuild_clusters_with_frequency_filtered(
    tile_infos: &[TileColorInfo],
    tile_palette_map: &[usize],
    empty_tiles: &[bool],
    palette_slots: usize,
    color0: &str,
) -> Vec<Vec<String>> {
    use std::collections::HashMap;

    let mut palette_color_freq: Vec<HashMap<String, usize>> = vec![HashMap::new(); palette_slots];

    // Accumulate color frequencies for each palette from assigned non-empty tiles only
    for (idx, (tile_info, palette_index)) in tile_infos.iter().zip(tile_palette_map.iter()).enumerate() {
        // Skip empty tiles
        if empty_tiles[idx] {
            continue;
        }
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

    let mut output = image.clone();

    // Process each tile independently to avoid cross-tile dithering artifacts
    for tile_y in 0..tiles_y {
        for tile_x in 0..tiles_x {
            let tile_index = (tile_y * tiles_x + tile_x) as usize;

            // Skip empty tiles - they already contain the background color
            if palette_result.empty_tiles.get(tile_index).copied().unwrap_or(false) {
                continue;
            }

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

            // Per-tile error buffer for Floyd-Steinberg (8x8 + padding)
            let mut error_r: [[f32; 10]; 9] = [[0.0; 10]; 9];
            let mut error_g: [[f32; 10]; 9] = [[0.0; 10]; 9];
            let mut error_b: [[f32; 10]; 9] = [[0.0; 10]; 9];

            // Bayer 8x8 matrix for ordered dithering (values 0-63, will be normalized)
            const BAYER_8X8: [[u8; 8]; 8] = [
                [ 0, 32,  8, 40,  2, 34, 10, 42],
                [48, 16, 56, 24, 50, 18, 58, 26],
                [12, 44,  4, 36, 14, 46,  6, 38],
                [60, 28, 52, 20, 62, 30, 54, 22],
                [ 3, 35, 11, 43,  1, 33,  9, 41],
                [51, 19, 59, 27, 49, 17, 57, 25],
                [15, 47,  7, 39, 13, 45,  5, 37],
                [63, 31, 55, 23, 61, 29, 53, 21],
            ];

            // Process pixels within this tile
            for ly in 0..8u32 {
                for lx in 0..8u32 {
                    let px = tile_x * 8 + lx;
                    let py = tile_y * 8 + ly;

                    let pixel = image.get_pixel(px, py);
                    let [r, g, b, a] = pixel.0;

                    // Add accumulated error for dithering
                    let (adj_r, adj_g, adj_b) = if dither_mode == "floyd" {
                        let er = error_r[ly as usize][lx as usize + 1];
                        let eg = error_g[ly as usize][lx as usize + 1];
                        let eb = error_b[ly as usize][lx as usize + 1];
                        (
                            (r as f32 + er).clamp(0.0, 255.0),
                            (g as f32 + eg).clamp(0.0, 255.0),
                            (b as f32 + eb).clamp(0.0, 255.0),
                        )
                    } else if dither_mode == "ordered" {
                        // Ordered dithering: add threshold from Bayer matrix
                        // Threshold is normalized to [-0.5, 0.5] * spread
                        let threshold = (BAYER_8X8[ly as usize][lx as usize] as f32 / 64.0 - 0.5) * 32.0;
                        (
                            (r as f32 + threshold).clamp(0.0, 255.0),
                            (g as f32 + threshold).clamp(0.0, 255.0),
                            (b as f32 + threshold).clamp(0.0, 255.0),
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

                    // Distribute error for Floyd-Steinberg within tile boundaries
                    if dither_mode == "floyd" {
                        let quant_r = mapped_rgba.0[0] as f32;
                        let quant_g = mapped_rgba.0[1] as f32;
                        let quant_b = mapped_rgba.0[2] as f32;

                        let err_r = adj_r - quant_r;
                        let err_g = adj_g - quant_g;
                        let err_b = adj_b - quant_b;

                        let lx_idx = lx as usize + 1;
                        let ly_idx = ly as usize;

                        // Floyd-Steinberg error distribution: 7/16, 3/16, 5/16, 1/16
                        // Only distribute to pixels within tile bounds

                        // Right pixel (7/16) - only if not at right edge of tile
                        if lx < 7 {
                            error_r[ly_idx][lx_idx + 1] += err_r * 7.0 / 16.0;
                            error_g[ly_idx][lx_idx + 1] += err_g * 7.0 / 16.0;
                            error_b[ly_idx][lx_idx + 1] += err_b * 7.0 / 16.0;
                        }

                        // Bottom row - only if not at bottom edge of tile
                        if ly < 7 {
                            // Bottom-left pixel (3/16)
                            if lx > 0 {
                                error_r[ly_idx + 1][lx_idx - 1] += err_r * 3.0 / 16.0;
                                error_g[ly_idx + 1][lx_idx - 1] += err_g * 3.0 / 16.0;
                                error_b[ly_idx + 1][lx_idx - 1] += err_b * 3.0 / 16.0;
                            }

                            // Bottom pixel (5/16)
                            error_r[ly_idx + 1][lx_idx] += err_r * 5.0 / 16.0;
                            error_g[ly_idx + 1][lx_idx] += err_g * 5.0 / 16.0;
                            error_b[ly_idx + 1][lx_idx] += err_b * 5.0 / 16.0;

                            // Bottom-right pixel (1/16)
                            if lx < 7 {
                                error_r[ly_idx + 1][lx_idx + 1] += err_r * 1.0 / 16.0;
                                error_g[ly_idx + 1][lx_idx + 1] += err_g * 1.0 / 16.0;
                                error_b[ly_idx + 1][lx_idx + 1] += err_b * 1.0 / 16.0;
                            }
                        }
                    }
                }
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

// ===== PC-Engine Export Functions =====

#[derive(Serialize)]
struct ExportResult {
    plain_text: String,
    tile_count: usize,
    unique_tile_count: usize,
    bat_size: usize,
}

/// Export converted image as PC-Engine assembly data
#[tauri::command]
fn export_plain_text(
    image_data: Vec<u8>,  // PNG image as bytes
    palettes: Vec<Vec<String>>,
    tile_palette_map: Vec<usize>,
    empty_tiles: Vec<bool>,
    vram_base_address: u32,
) -> Result<ExportResult, String> {
    // Decode PNG image
    let img = image::load_from_memory(&image_data)
        .map_err(|e| format!("Failed to decode image: {}", e))?
        .to_rgba8();

    let (width, height) = img.dimensions();
    let tiles_x = width / 8;
    let tiles_y = height / 8;
    let total_tiles = (tiles_x * tiles_y) as usize;

    // Build unique tiles and mapping
    // Empty tile is always first (32 bytes of zeros = all pixels are color index 0)
    let empty_tile: [u8; 32] = [0u8; 32];
    let mut unique_tiles: Vec<[u8; 32]> = vec![empty_tile];
    let mut tile_to_unique: Vec<usize> = Vec::with_capacity(total_tiles);

    for tile_idx in 0..total_tiles {
        // Empty tiles all point to the first tile (index 0)
        if empty_tiles.get(tile_idx).copied().unwrap_or(false) {
            tile_to_unique.push(0);
            continue;
        }

        let tile_x = (tile_idx % tiles_x as usize) as u32;
        let tile_y = (tile_idx / tiles_x as usize) as u32;

        // Get palette for this tile
        let palette_idx = tile_palette_map.get(tile_idx).copied().unwrap_or(0);
        let palette = palettes.get(palette_idx).cloned().unwrap_or_default();

        // Encode tile to planar format
        let tile_data = encode_tile_planar(&img, tile_x, tile_y, &palette);

        // Check for duplicate
        let existing_idx = unique_tiles.iter().position(|t| *t == tile_data);
        match existing_idx {
            Some(idx) => tile_to_unique.push(idx),
            None => {
                tile_to_unique.push(unique_tiles.len());
                unique_tiles.push(tile_data);
            }
        }
    }

    // Generate output text
    let mut output = String::new();

    // Header comment
    output.push_str("; ========================================\n");
    output.push_str("; PC-Engine Graphics Data\n");
    output.push_str("; Generated by Image2PCE II\n");
    output.push_str("; ========================================\n\n");

    // Stats
    output.push_str(&format!("; Image: {}x{} pixels ({} tiles)\n", width, height, total_tiles));
    output.push_str(&format!("; Unique tiles: {} (saved {} duplicates)\n", unique_tiles.len(), total_tiles - unique_tiles.len()));
    output.push_str(&format!("; VRAM base address: ${:04X}\n", vram_base_address));
    output.push_str(&format!("; Tiles size: {} bytes\n", unique_tiles.len() * 32));
    output.push_str(&format!("; BAT size: {} bytes\n\n", total_tiles * 2));

    // BAT (Block Address Table)
    output.push_str("; ----------------------------------------\n");
    output.push_str("; BAT - Block Address Table\n");
    output.push_str("; Format: PPPP AAAA AAAA AAAA (P=palette, A=address>>4)\n");
    output.push_str("; ----------------------------------------\n");
    output.push_str("BAT:\n");

    for (tile_idx, &unique_idx) in tile_to_unique.iter().enumerate() {
        if tile_idx % tiles_x as usize == 0 {
            if tile_idx > 0 {
                output.push('\n');
            }
            output.push_str(&format!("  ; Row {}\n", tile_idx / tiles_x as usize));
        }

        // Empty tiles use palette 0
        let palette_idx = if empty_tiles.get(tile_idx).copied().unwrap_or(false) {
            0u16
        } else {
            tile_palette_map.get(tile_idx).copied().unwrap_or(0) as u16
        };
        // Tile address = base + (unique_tile_index * 32)
        // BAT address field = (tile_address >> 4) & 0x0FFF
        let tile_address = vram_base_address + (unique_idx as u32 * 32);
        let address_field = ((tile_address >> 4) & 0x0FFF) as u16;
        let bat_word = (palette_idx << 12) | address_field;

        if tile_idx % tiles_x as usize == 0 {
            output.push_str(&format!("  .dw ${:04X}", bat_word));
        } else {
            output.push_str(&format!(",${:04X}", bat_word));
        }
    }
    output.push_str("\n\n");

    // TILES data
    output.push_str("; ----------------------------------------\n");
    output.push_str("; TILES - Planar format (32 bytes per tile)\n");
    output.push_str("; Planes 1&2 lines 0-7, then Planes 3&4 lines 0-7\n");
    output.push_str("; ----------------------------------------\n");
    output.push_str("TILES:\n");

    for (tile_idx, tile_data) in unique_tiles.iter().enumerate() {
        output.push_str(&format!("  ; Tile {}\n", tile_idx));

        // First 16 bytes (Planes 1 & 2, lines 0-7)
        output.push_str("  .db ");
        for (i, byte) in tile_data[0..16].iter().enumerate() {
            if i > 0 {
                output.push(',');
            }
            output.push_str(&format!("${:02X}", byte));
        }
        output.push('\n');

        // Second 16 bytes (Planes 3 & 4, lines 0-7)
        output.push_str("  .db ");
        for (i, byte) in tile_data[16..32].iter().enumerate() {
            if i > 0 {
                output.push(',');
            }
            output.push_str(&format!("${:02X}", byte));
        }
        output.push_str("\n\n");
    }

    // PALETTES data
    output.push_str("; ----------------------------------------\n");
    output.push_str("; PALETTES - RGB333 format (16 colors x 16 palettes)\n");
    output.push_str("; Format: -------- -GGGRRR- -------- -BBB----\n");
    output.push_str("; Stored as: 0x00GR, 0x00B0 per color (little-endian words)\n");
    output.push_str("; ----------------------------------------\n");
    output.push_str("PALETTES:\n");

    for (pal_idx, palette) in palettes.iter().enumerate() {
        output.push_str(&format!("  ; Palette {}\n", pal_idx));
        output.push_str("  .dw ");

        for (col_idx, color) in palette.iter().take(16).enumerate() {
            if col_idx > 0 {
                output.push(',');
            }
            let word = color_to_pce_word(color);
            output.push_str(&format!("${:04X}", word));
        }

        // Pad palette to 16 colors if needed
        for _ in palette.len()..16 {
            output.push_str(",$0000");
        }

        output.push('\n');
    }

    Ok(ExportResult {
        plain_text: output,
        tile_count: total_tiles,
        unique_tile_count: unique_tiles.len(),
        bat_size: total_tiles * 2,
    })
}

/// Encode a single 8x8 tile to PC-Engine planar format (32 bytes)
/// Format: Planes 1&2 for lines 0-7 (16 bytes), then Planes 3&4 for lines 0-7 (16 bytes)
fn encode_tile_planar(
    img: &RgbaImage,
    tile_x: u32,
    tile_y: u32,
    palette: &[String],
) -> [u8; 32] {
    let mut data = [0u8; 32];

    for line in 0..8u32 {
        let mut plane1: u8 = 0;
        let mut plane2: u8 = 0;
        let mut plane3: u8 = 0;
        let mut plane4: u8 = 0;

        for px in 0..8u32 {
            let pixel = img.get_pixel(tile_x * 8 + px, tile_y * 8 + line);
            let color = format!("#{:02X}{:02X}{:02X}", pixel.0[0], pixel.0[1], pixel.0[2]);

            // Find color index in palette (0-15)
            let color_idx = palette.iter()
                .position(|c| c.eq_ignore_ascii_case(&color))
                .unwrap_or(0) as u8;

            // Build planar data (MSB = leftmost pixel)
            let bit_pos = 7 - px as u8;
            plane1 |= ((color_idx >> 0) & 1) << bit_pos;
            plane2 |= ((color_idx >> 1) & 1) << bit_pos;
            plane3 |= ((color_idx >> 2) & 1) << bit_pos;
            plane4 |= ((color_idx >> 3) & 1) << bit_pos;
        }

        // Planes 1&2: bytes 0-15 (2 bytes per line, interleaved)
        data[(line * 2) as usize] = plane1;
        data[(line * 2 + 1) as usize] = plane2;

        // Planes 3&4: bytes 16-31 (2 bytes per line, interleaved)
        data[(16 + line * 2) as usize] = plane3;
        data[(16 + line * 2 + 1) as usize] = plane4;
    }

    data
}

/// Convert a hex color (#RRGGBB) to PC-Engine 9-bit RGB333 word
/// PCE format: -------- -GGG-RRR -------- -BBB----
/// Stored as single 16-bit word: 0b0000_0GGG_RRRB_BB00 (actually different)
/// Real format: bits 8-6 = Green, bits 5-3 = Red, bits 2-0 = Blue
fn color_to_pce_word(color: &str) -> u16 {
    let rgba = parse_hex_color(color).unwrap_or(Rgba([0, 0, 0, 255]));
    let r = rgba.0[0];
    let g = rgba.0[1];
    let b = rgba.0[2];

    // Convert 8-bit to 3-bit (0-7)
    let r3 = (r >> 5) & 0x07;
    let g3 = (g >> 5) & 0x07;
    let b3 = (b >> 5) & 0x07;

    // PCE color format: 0000_0GGG_RRRB_BB00 -> stored as 0x0GRB format
    // Actually: G(3 bits) << 6 | R(3 bits) << 3 | B(3 bits)
    ((g3 as u16) << 6) | ((r3 as u16) << 3) | (b3 as u16)
}

#[derive(Serialize)]
struct BinaryExportResult {
    bat: Vec<u8>,
    tiles: Vec<u8>,
    palettes: Vec<u8>,
    tile_count: usize,
    unique_tile_count: usize,
}

/// Export converted image as binary data (bat.bin, tiles.bin, pal.bin)
#[tauri::command]
fn export_binaries(
    image_data: Vec<u8>,  // PNG image as bytes
    palettes: Vec<Vec<String>>,
    tile_palette_map: Vec<usize>,
    empty_tiles: Vec<bool>,
    vram_base_address: u32,
) -> Result<BinaryExportResult, String> {
    // Decode PNG image
    let img = image::load_from_memory(&image_data)
        .map_err(|e| format!("Failed to decode image: {}", e))?
        .to_rgba8();

    let (width, height) = img.dimensions();
    let tiles_x = width / 8;
    let tiles_y = height / 8;
    let total_tiles = (tiles_x * tiles_y) as usize;

    // Build unique tiles and mapping
    // Empty tile is always first (32 bytes of zeros = all pixels are color index 0)
    let empty_tile: [u8; 32] = [0u8; 32];
    let mut unique_tiles: Vec<[u8; 32]> = vec![empty_tile];
    let mut tile_to_unique: Vec<usize> = Vec::with_capacity(total_tiles);

    for tile_idx in 0..total_tiles {
        // Empty tiles all point to the first tile (index 0)
        if empty_tiles.get(tile_idx).copied().unwrap_or(false) {
            tile_to_unique.push(0);
            continue;
        }

        let tile_x = (tile_idx % tiles_x as usize) as u32;
        let tile_y = (tile_idx / tiles_x as usize) as u32;

        // Get palette for this tile
        let palette_idx = tile_palette_map.get(tile_idx).copied().unwrap_or(0);
        let palette = palettes.get(palette_idx).cloned().unwrap_or_default();

        // Encode tile to planar format
        let tile_data = encode_tile_planar(&img, tile_x, tile_y, &palette);

        // Check for duplicate
        let existing_idx = unique_tiles.iter().position(|t| *t == tile_data);
        match existing_idx {
            Some(idx) => tile_to_unique.push(idx),
            None => {
                tile_to_unique.push(unique_tiles.len());
                unique_tiles.push(tile_data);
            }
        }
    }

    // Generate BAT binary (little-endian 16-bit words)
    let mut bat_data: Vec<u8> = Vec::with_capacity(total_tiles * 2);
    for (tile_idx, &unique_idx) in tile_to_unique.iter().enumerate() {
        // Empty tiles use palette 0
        let palette_idx = if empty_tiles.get(tile_idx).copied().unwrap_or(false) {
            0u16
        } else {
            tile_palette_map.get(tile_idx).copied().unwrap_or(0) as u16
        };
        let tile_address = vram_base_address + (unique_idx as u32 * 32);
        let address_field = ((tile_address >> 4) & 0x0FFF) as u16;
        let bat_word = (palette_idx << 12) | address_field;

        // Little-endian
        bat_data.push((bat_word & 0xFF) as u8);
        bat_data.push((bat_word >> 8) as u8);
    }

    // Generate TILES binary
    let mut tiles_data: Vec<u8> = Vec::with_capacity(unique_tiles.len() * 32);
    for tile in unique_tiles.iter() {
        tiles_data.extend_from_slice(tile);
    }

    // Generate PALETTES binary (16 palettes x 16 colors x 2 bytes = 512 bytes)
    let mut pal_data: Vec<u8> = Vec::with_capacity(16 * 16 * 2);
    for pal_idx in 0..16 {
        let palette = palettes.get(pal_idx).cloned().unwrap_or_default();
        for col_idx in 0..16 {
            let word = if col_idx < palette.len() {
                color_to_pce_word(&palette[col_idx])
            } else {
                0x0000
            };
            // Little-endian
            pal_data.push((word & 0xFF) as u8);
            pal_data.push((word >> 8) as u8);
        }
    }

    Ok(BinaryExportResult {
        bat: bat_data,
        tiles: tiles_data,
        palettes: pal_data,
        tile_count: total_tiles,
        unique_tile_count: unique_tiles.len(),
    })
}

/// Save binary export to disk - creates a directory and writes 3 files
#[tauri::command]
fn save_binaries_to_disk(
    base_path: String,
    bat_data: Vec<u8>,
    tiles_data: Vec<u8>,
    pal_data: Vec<u8>,
) -> Result<(), String> {
    use std::fs;
    use std::path::Path;

    let base = Path::new(&base_path);

    // Get the filename without extension for directory name
    let dir_name = base.file_stem()
        .and_then(|s| s.to_str())
        .ok_or("Invalid path")?;

    // Create directory path (same location as selected file, with filename as dir name)
    let parent = base.parent().ok_or("Invalid parent directory")?;
    let dir_path = parent.join(dir_name);

    // Create the directory
    fs::create_dir_all(&dir_path)
        .map_err(|e| format!("Failed to create directory: {}", e))?;

    // Write the 3 files
    let bat_path = dir_path.join(format!("{}.bat", dir_name));
    let tiles_path = dir_path.join(format!("{}.tiles", dir_name));
    let pal_path = dir_path.join(format!("{}.pal", dir_name));

    fs::write(&bat_path, &bat_data)
        .map_err(|e| format!("Failed to write BAT file: {}", e))?;
    fs::write(&tiles_path, &tiles_data)
        .map_err(|e| format!("Failed to write tiles file: {}", e))?;
    fs::write(&pal_path, &pal_data)
        .map_err(|e| format!("Failed to write palette file: {}", e))?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .invoke_handler(tauri::generate_handler![open_image, run_conversion, export_plain_text, export_binaries, save_binaries_to_disk])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
