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
    tile_to_unique: Vec<usize>,
    was_pre_resized: bool,
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
    palette_group_constraints: Vec<i32>,  // -1 = auto, 0-15 = forced group
    seed: u64,  // Seed for deterministic palette clustering
) -> Result<ConversionResult, String> {
    // Emit: loading image
    let _ = app.emit("conversion-progress", ProgressEvent {
        percent: 5,
        stage: "Chargement de l'image...".to_string(),
    });

    let mut image = image::open(&input_path).map_err(|e| e.to_string())?;
    let mut was_pre_resized = false;

    // Pre-resize if source is more than 2x the target size
    // This improves performance and quality for very large images
    let max_width = target_width * 2;
    let max_height = target_height * 2;
    if image.width() > max_width || image.height() > max_height {
        let _ = app.emit("conversion-progress", ProgressEvent {
            percent: 10,
            stage: "Pré-redimensionnement...".to_string(),
        });

        // Use Lanczos3 for high-quality pre-resize
        image = image.resize(max_width, max_height, FilterType::Lanczos3);
        was_pre_resized = true;
    }

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
        &palette_group_constraints,
        seed,
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
    let mut tile_to_unique: Vec<usize> = Vec::with_capacity(total_tiles);

    for tile_idx in 0..total_tiles {
        // Empty tiles all point to the first tile (index 0)
        if palette_result.empty_tiles.get(tile_idx).copied().unwrap_or(false) {
            tile_to_unique.push(0);
            continue;
        }

        let tile_x = (tile_idx % tiles_x as usize) as u32;
        let tile_y = (tile_idx / tiles_x as usize) as u32;
        let palette_idx = palette_result.tile_palette_map.get(tile_idx).copied().unwrap_or(0);
        let palette = palette_result.palettes.get(palette_idx).cloned().unwrap_or_default();
        let tile_data = encode_tile_planar(&preview, tile_x, tile_y, &palette);

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
        tile_to_unique,
        was_pre_resized,
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

/// Deterministic hash for tiebreaking based on seed and string
fn seeded_hash(seed: u64, s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    use std::collections::hash_map::DefaultHasher;
    let mut hasher = DefaultHasher::new();
    seed.hash(&mut hasher);
    s.hash(&mut hasher);
    hasher.finish()
}

fn build_palettes_for_tiles(
    image: &RgbaImage,
    palette_count: usize,
    background_color: &str,
    constraints: &[i32],  // -1 = auto, 0-15 = forced group
    seed: u64,  // Seed for deterministic ordering
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

    // Build constrained tiles map: group -> list of tile indices
    let mut constrained_tiles: HashMap<usize, Vec<usize>> = HashMap::new();
    let mut unconstrained_indices: Vec<usize> = Vec::new();
    let has_constraints = !constraints.is_empty();

    for (idx, tile_info) in tile_infos.iter().enumerate() {
        if empty_tiles[idx] {
            continue; // Empty tiles always go to palette 0
        }
        let constraint = constraints.get(idx).copied().unwrap_or(-1);
        if constraint >= 0 && constraint < 16 {
            constrained_tiles
                .entry(constraint as usize)
                .or_insert_with(Vec::new)
                .push(idx);
        } else {
            unconstrained_indices.push(idx);
        }
    }

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
    let mut clusters = seed_palette_clusters_v2(&non_empty_infos_owned, palette_slots, &global_color0, &global_color_freq, seed);

    // Initialize tile_palette_map with constraints
    let mut tile_palette_map = vec![0usize; tiles.len()];
    for (group, tile_indices) in constrained_tiles.iter() {
        for &tile_idx in tile_indices {
            tile_palette_map[tile_idx] = *group;
        }
    }

    // Pre-populate constrained palettes with colors from constrained tiles
    if has_constraints {
        for (group, tile_indices) in constrained_tiles.iter() {
            if *group >= clusters.len() {
                continue;
            }
            for &tile_idx in tile_indices {
                for color in &tile_infos[tile_idx].colors {
                    if color != &global_color0 && !clusters[*group].contains(color) {
                        clusters[*group].push(color.clone());
                    }
                }
            }
            // Truncate to 16 colors if needed
            if clusters[*group].len() > 16 {
                clusters[*group].truncate(16);
            }
        }
    }

    // Iterate to refine clustering (only for non-empty, unconstrained tiles)
    // Log initial state
    let log_path = std::env::temp_dir().join("image2pce_clustering.log");
    let mut log_content = String::new();
    log_content.push_str("=== CLUSTERING LOG ===\n\n");
    log_content.push_str(&format!("Seed: {}\n\n", seed));
    log_content.push_str(&format!("Initial clusters (after seeding):\n"));
    for (i, cluster) in clusters.iter().enumerate() {
        if !cluster.is_empty() && cluster.iter().any(|c| c != &global_color0) {
            log_content.push_str(&format!("  Palette {}: {} colors: {:?}\n", i, cluster.len(), &cluster[..cluster.len().min(5)]));
        }
    }
    log_content.push_str("\n");

    for iteration in 0..6 {
        // Assign each non-empty tile to best matching palette
        for (tile_index, tile_info) in tile_infos.iter().enumerate() {
            if empty_tiles[tile_index] {
                // Empty tiles stay at palette 0 (which has color0)
                tile_palette_map[tile_index] = 0;
            } else {
                // Check if this tile has a constraint
                let constraint = constraints.get(tile_index).copied().unwrap_or(-1);
                if constraint >= 0 && constraint < 16 {
                    // Keep the constrained assignment
                    tile_palette_map[tile_index] = constraint as usize;
                } else {
                    // Auto-assign to best matching palette
                    let palette_index = best_cluster_for_tile(&clusters, &tile_info.colors, &global_color0);
                    tile_palette_map[tile_index] = palette_index;
                }
            }
        }

        // Rebuild palettes from assigned non-empty tiles only
        clusters = rebuild_clusters_with_frequency_filtered(
            &tile_infos,
            &tile_palette_map,
            &empty_tiles,
            palette_slots,
            &global_color0,
            seed,
        );

        // Log iteration state
        log_content.push_str(&format!("--- Iteration {} ---\n", iteration + 1));

        // Count tiles per palette
        let mut palette_tile_counts = vec![0usize; palette_slots];
        for &p in tile_palette_map.iter() {
            if p < palette_slots {
                palette_tile_counts[p] += 1;
            }
        }

        for (i, cluster) in clusters.iter().enumerate() {
            if palette_tile_counts[i] > 0 || (cluster.len() > 1 || (cluster.len() == 1 && cluster[0] != global_color0)) {
                log_content.push_str(&format!("  Palette {} ({} tiles): {} colors\n", i, palette_tile_counts[i], cluster.len()));
                // Log first 8 colors of each palette
                let preview: Vec<&str> = cluster.iter().take(8).map(|s| s.as_str()).collect();
                log_content.push_str(&format!("    Colors: {:?}\n", preview));
            }
        }
        log_content.push_str("\n");
    }

    // Write log file
    let _ = std::fs::write(&log_path, &log_content);
    eprintln!("Clustering log written to: {:?}", log_path);

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
    // Always compact - palettes with 0 tiles should be at the end regardless of constraints
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
    seed: u64,
) -> Vec<Vec<String>> {
    use std::collections::HashMap;

    // Group tiles by their dominant color (most frequent color in tile, excluding color0)
    let mut dominant_groups: HashMap<String, Vec<usize>> = HashMap::new();
    for (idx, tile_info) in tile_infos.iter().enumerate() {
        // Get all colors except color0, sorted deterministically by (count DESC, seeded_hash)
        let mut colors_with_counts: Vec<_> = tile_info
            .color_counts
            .iter()
            .filter(|(c, _)| *c != color0)
            .map(|(c, count)| (c.clone(), *count))
            .collect();
        colors_with_counts.sort_by(|a, b| {
            b.1.cmp(&a.1)
                .then_with(|| seeded_hash(seed, &a.0).cmp(&seeded_hash(seed, &b.0)))
        });

        let dominant = colors_with_counts
            .first()
            .map(|(c, _)| c.clone())
            .unwrap_or_else(|| color0.to_string());
        dominant_groups.entry(dominant).or_default().push(idx);
    }

    // Sort dominant colors by how many tiles they represent, with seeded tiebreaker
    let mut dominant_colors: Vec<_> = dominant_groups.iter().collect();
    dominant_colors.sort_by(|a, b| {
        b.1.len().cmp(&a.1.len())
            .then_with(|| seeded_hash(seed, a.0).cmp(&seeded_hash(seed, b.0)))
    });

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
            // Sort by count DESC, with seeded tiebreaker for determinism
            palette.sort_by(|a, b| {
                b.1.cmp(&a.1)
                    .then_with(|| seeded_hash(seed, &a.0).cmp(&seeded_hash(seed, &b.0)))
            });

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
    seed: u64,
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
        // Sort colors by frequency (most used first), with seeded tiebreaker
        let mut color_freq: Vec<_> = freq_map.iter().collect();
        color_freq.sort_by(|a, b| {
            b.1.cmp(a.1)
                .then_with(|| seeded_hash(seed, a.0).cmp(&seeded_hash(seed, b.0)))
        });

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
    bat_width: u32,       // BAT width in tiles (32, 64, 128)
    bat_height: u32,      // BAT height in tiles (32, 64)
    offset_x: u32,        // Image X offset in BAT (in tiles)
    offset_y: u32,        // Image Y offset in BAT (in tiles)
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
    let bat_total = (bat_width * bat_height) as usize;
    output.push_str(&format!("; Image: {}x{} pixels ({} tiles)\n", width, height, total_tiles));
    output.push_str(&format!("; BAT: {}x{} tiles, image at offset ({},{})\n", bat_width, bat_height, offset_x, offset_y));
    output.push_str(&format!("; Unique tiles: {} (saved {} duplicates)\n", unique_tiles.len(), total_tiles - unique_tiles.len()));
    output.push_str(&format!("; VRAM base address: ${:04X}\n", vram_base_address));
    output.push_str(&format!("; Tiles size: {} bytes\n", unique_tiles.len() * 32));
    output.push_str(&format!("; BAT size: {} bytes\n\n", bat_total * 2));

    // BAT (Block Address Table) - full BAT size with image positioned at offset
    output.push_str("; ----------------------------------------\n");
    output.push_str("; BAT - Block Address Table\n");
    output.push_str("; Format: PPPP AAAA AAAA AAAA (P=palette, A=address>>4)\n");
    output.push_str("; ----------------------------------------\n");
    output.push_str("BAT:\n");

    for bat_y in 0..bat_height {
        if bat_y > 0 {
            output.push('\n');
        }
        output.push_str(&format!("  ; Row {}\n", bat_y));

        for bat_x in 0..bat_width {
            // Position in the source image (accounting for offset)
            let img_x = bat_x as i32 - offset_x as i32;
            let img_y = bat_y as i32 - offset_y as i32;

            let (unique_idx, palette_idx) = if img_x >= 0 && img_y >= 0
                && img_x < tiles_x as i32 && img_y < tiles_y as i32 {
                // Tile within the image area
                let tile_idx = img_y as usize * tiles_x as usize + img_x as usize;
                let uid = tile_to_unique.get(tile_idx).copied().unwrap_or(0);
                let pid = if empty_tiles.get(tile_idx).copied().unwrap_or(false) {
                    0u16
                } else {
                    tile_palette_map.get(tile_idx).copied().unwrap_or(0) as u16
                };
                (uid, pid)
            } else {
                // Outside image area = empty tile (index 0, palette 0)
                (0, 0u16)
            };

            // VRAM is word-addressed (16-bit), each tile = 16 words (32 bytes)
            // BAT address field = (tile_word_address >> 4) & 0x0FFF
            let tile_address = vram_base_address + (unique_idx as u32 * 16);
            let address_field = ((tile_address >> 4) & 0x0FFF) as u16;
            let bat_word = (palette_idx << 12) | address_field;

            if bat_x == 0 {
                output.push_str(&format!("  .dw ${:04X}", bat_word));
            } else {
                output.push_str(&format!(",${:04X}", bat_word));
            }
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
    output.push_str("; Format: 0000 000G GGRR RBBB (9 bits per color)\n");
    output.push_str("; G=bits 6-8, R=bits 3-5, B=bits 0-2\n");
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
        bat_size: bat_total * 2,
    })
}

/// Debug flag for encode_tile_planar - only log first tile
static DEBUG_TILE_LOGGED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Encode a single 8x8 tile to PC-Engine planar format (32 bytes)
/// Format: Planes 1&2 for lines 0-7 (16 bytes), then Planes 3&4 for lines 0-7 (16 bytes)
fn encode_tile_planar(
    img: &RgbaImage,
    tile_x: u32,
    tile_y: u32,
    palette: &[String],
) -> [u8; 32] {
    let mut data = [0u8; 32];

    // Debug: log first non-empty tile details
    let should_log = !DEBUG_TILE_LOGGED.swap(true, std::sync::atomic::Ordering::SeqCst);
    if should_log {
        eprintln!("DEBUG encode_tile_planar: tile ({},{}) palette has {} colors", tile_x, tile_y, palette.len());
        for (i, col) in palette.iter().take(4).enumerate() {
            if let Some(rgba) = parse_hex_color(col) {
                eprintln!("  palette[{}] = {} -> rgba({},{},{})", i, col, rgba.0[0], rgba.0[1], rgba.0[2]);
            } else {
                eprintln!("  palette[{}] = {} -> PARSE FAILED", i, col);
            }
        }
    }

    for line in 0..8u32 {
        let mut plane1: u8 = 0;
        let mut plane2: u8 = 0;
        let mut plane3: u8 = 0;
        let mut plane4: u8 = 0;

        for px in 0..8u32 {
            let pixel = img.get_pixel(tile_x * 8 + px, tile_y * 8 + line);
            let (pr, pg, pb) = (pixel.0[0], pixel.0[1], pixel.0[2]);

            // Find nearest color index in palette (0-15) using RGB distance
            let mut color_idx: u8 = 0;
            let mut best_dist = u32::MAX;
            for (idx, pal_color) in palette.iter().enumerate() {
                if let Some(pal_rgba) = parse_hex_color(pal_color) {
                    let dr = pr as i32 - pal_rgba.0[0] as i32;
                    let dg = pg as i32 - pal_rgba.0[1] as i32;
                    let db = pb as i32 - pal_rgba.0[2] as i32;
                    let dist = (dr * dr + dg * dg + db * db) as u32;
                    if dist < best_dist {
                        best_dist = dist;
                        color_idx = idx as u8;
                    }
                }
            }

            // Debug: log first few pixel matchings
            if should_log && line < 2 && px < 2 {
                eprintln!("  pixel({},{}) rgb({},{},{}) -> color_idx {} (dist={})",
                    tile_x * 8 + px, tile_y * 8 + line, pr, pg, pb, color_idx, best_dist);
            }

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

    if should_log {
        eprintln!("DEBUG: tile data = {:?}", &data[..16]);
    }

    data
}

/// Convert a hex color (#RRGGBB) to PC-Engine 9-bit RGB333 word
/// PCE format: 0000 000G GGRR RBBB
/// G=bits 6-8, R=bits 3-5, B=bits 0-2
fn color_to_pce_word(color: &str) -> u16 {
    let rgba = parse_hex_color(color).unwrap_or(Rgba([0, 0, 0, 255]));
    let r = rgba.0[0];
    let g = rgba.0[1];
    let b = rgba.0[2];

    // Convert 8-bit to 3-bit (0-7)
    let r3 = (r >> 5) & 0x07;
    let g3 = (g >> 5) & 0x07;
    let b3 = (b >> 5) & 0x07;

    // PCE color format: 0000 000G GGRR RBBB (9 bits)
    // G(3 bits) at positions 6-8 | R(3 bits) at positions 3-5 | B(3 bits) at positions 0-2
    ((g3 as u16) << 6) | ((r3 as u16) << 3) | (b3 as u16)
}

#[derive(Serialize)]
struct BinaryExportResult {
    bat: Vec<u8>,
    tiles: Vec<u8>,
    palettes: Vec<u8>,
    tile_count: usize,
    unique_tile_count: usize,
    // Debug info
    image_width: u32,
    image_height: u32,
    bat_width: u32,
    bat_height: u32,
    palette_count: usize,
    empty_tile_count: usize,
    debug_info: String,
}

/// Export converted image as binary data (bat.bin, tiles.bin, pal.bin)
#[tauri::command]
fn export_binaries(
    image_data: Vec<u8>,  // PNG image as bytes
    palettes: Vec<Vec<String>>,
    tile_palette_map: Vec<usize>,
    empty_tiles: Vec<bool>,
    vram_base_address: u32,
    bat_big_endian: bool,
    pal_big_endian: bool,
    tiles_big_endian: bool,
    bat_width: u32,       // BAT width in tiles (32, 64, 128)
    bat_height: u32,      // BAT height in tiles (32, 64)
    offset_x: u32,        // Image X offset in BAT (in tiles)
    offset_y: u32,        // Image Y offset in BAT (in tiles)
) -> Result<BinaryExportResult, String> {
    // Decode PNG image
    let img = image::load_from_memory(&image_data)
        .map_err(|e| format!("Failed to decode image: {}", e))?
        .to_rgba8();

    let (width, height) = img.dimensions();
    let tiles_x = width / 8;
    let tiles_y = height / 8;
    let total_tiles = (tiles_x * tiles_y) as usize;

    // Reset debug flag for tile logging
    DEBUG_TILE_LOGGED.store(false, std::sync::atomic::Ordering::SeqCst);

    // Debug: Log palette contents
    eprintln!("DEBUG export_binaries: {} palettes received", palettes.len());
    if !palettes.is_empty() {
        eprintln!("DEBUG: Palette 0 contents: {:?}", &palettes[0]);
    }

    // Debug: Log sample pixels from the image and check if they match palette colors
    if width >= 8 && height >= 8 && !palettes.is_empty() {
        eprintln!("DEBUG: Sample pixels from tile (0,0) and palette matching:");
        let pal0 = &palettes[0];
        for y in 0..2 {
            for x in 0..2 {
                let pixel = img.get_pixel(x, y);
                let pixel_hex = format!("#{:02X}{:02X}{:02X}", pixel.0[0], pixel.0[1], pixel.0[2]);
                let exact_match = pal0.iter().position(|c| c == &pixel_hex);
                eprintln!("  pixel({},{}) = {} -> exact match in pal0: {:?}", x, y, pixel_hex, exact_match);

                // Also find nearest with distance
                let mut best_dist = u32::MAX;
                let mut best_idx = 0;
                for (idx, col) in pal0.iter().enumerate() {
                    if let Some(c) = parse_hex_color(col) {
                        let dr = pixel.0[0] as i32 - c.0[0] as i32;
                        let dg = pixel.0[1] as i32 - c.0[1] as i32;
                        let db = pixel.0[2] as i32 - c.0[2] as i32;
                        let dist = (dr*dr + dg*dg + db*db) as u32;
                        if dist < best_dist {
                            best_dist = dist;
                            best_idx = idx;
                        }
                    }
                }
                eprintln!("    nearest: idx {} (dist={})", best_idx, best_dist);
            }
        }
    }

    // Build unique tiles and mapping
    // Empty tile is always first (32 bytes of zeros = all pixels are color index 0)
    let empty_tile: [u8; 32] = [0u8; 32];
    let mut unique_tiles: Vec<[u8; 32]> = vec![empty_tile];
    let mut tile_to_unique: Vec<usize> = Vec::with_capacity(total_tiles);

    let mut debug_non_empty_count = 0;
    let mut debug_new_unique_count = 0;

    for tile_idx in 0..total_tiles {
        // Empty tiles all point to the first tile (index 0)
        if empty_tiles.get(tile_idx).copied().unwrap_or(false) {
            tile_to_unique.push(0);
            continue;
        }

        debug_non_empty_count += 1;

        let tile_x = (tile_idx % tiles_x as usize) as u32;
        let tile_y = (tile_idx / tiles_x as usize) as u32;

        // Get palette for this tile
        let palette_idx = tile_palette_map.get(tile_idx).copied().unwrap_or(0);
        let palette = palettes.get(palette_idx).cloned().unwrap_or_default();

        // Debug: log first few non-empty tiles
        if debug_non_empty_count <= 3 {
            eprintln!("DEBUG: Non-empty tile {} at ({},{}) uses palette index {}", tile_idx, tile_x, tile_y, palette_idx);
            eprintln!("  palette has {} colors: {:?}", palette.len(), &palette.iter().take(4).collect::<Vec<_>>());
            if palette.is_empty() {
                eprintln!("  WARNING: Empty palette! All pixels will map to index 0");
            }
        }

        // Sanity check: if palette is empty, something is wrong
        if palette.is_empty() {
            eprintln!("ERROR: Tile {} has empty palette (palette_idx={}), palettes.len()={}", tile_idx, palette_idx, palettes.len());
        }

        // Encode tile to planar format
        let tile_data = encode_tile_planar(&img, tile_x, tile_y, &palette);

        // Check for duplicate
        let existing_idx = unique_tiles.iter().position(|t| *t == tile_data);
        match existing_idx {
            Some(idx) => {
                tile_to_unique.push(idx);
                // Debug: log some duplicate tiles to see what they look like
                if debug_non_empty_count <= 5 {
                    eprintln!("  -> duplicate of unique tile {} (data: {:?}...)", idx, &tile_data[..8]);
                }
            }
            None => {
                debug_new_unique_count += 1;
                eprintln!("DEBUG: New unique tile {} at ({},{}): {:?}...", unique_tiles.len(), tile_x, tile_y, &tile_data[..8]);
                tile_to_unique.push(unique_tiles.len());
                unique_tiles.push(tile_data);
            }
        }
    }

    eprintln!("DEBUG: Processed {} non-empty tiles, found {} new unique patterns", debug_non_empty_count, debug_new_unique_count);
    eprintln!("DEBUG: Endianness - BAT: {}, PAL: {}, TILES: {}",
        if bat_big_endian { "big" } else { "little" },
        if pal_big_endian { "big" } else { "little" },
        if tiles_big_endian { "big" } else { "little" });

    // Generate BAT binary (16-bit words) - full BAT size with image positioned at offset
    let bat_total = (bat_width * bat_height) as usize;
    let mut bat_data: Vec<u8> = Vec::with_capacity(bat_total * 2);

    for bat_y in 0..bat_height {
        for bat_x in 0..bat_width {
            // Position in the source image (accounting for offset)
            let img_x = bat_x as i32 - offset_x as i32;
            let img_y = bat_y as i32 - offset_y as i32;

            let (unique_idx, palette_idx) = if img_x >= 0 && img_y >= 0
                && img_x < tiles_x as i32 && img_y < tiles_y as i32 {
                // Tile within the image area
                let tile_idx = img_y as usize * tiles_x as usize + img_x as usize;
                let uid = tile_to_unique.get(tile_idx).copied().unwrap_or(0);
                let pid = if empty_tiles.get(tile_idx).copied().unwrap_or(false) {
                    0u16
                } else {
                    tile_palette_map.get(tile_idx).copied().unwrap_or(0) as u16
                };
                (uid, pid)
            } else {
                // Outside image area = empty tile (index 0, palette 0)
                (0, 0u16)
            };

            // VRAM is word-addressed (16-bit), each tile = 16 words (32 bytes)
            let tile_address = vram_base_address + (unique_idx as u32 * 16);
            let address_field = ((tile_address >> 4) & 0x0FFF) as u16;
            let bat_word = (palette_idx << 12) | address_field;

            if bat_big_endian {
                bat_data.push((bat_word >> 8) as u8);
                bat_data.push((bat_word & 0xFF) as u8);
            } else {
                bat_data.push((bat_word & 0xFF) as u8);
                bat_data.push((bat_word >> 8) as u8);
            }
        }
    }

    // Generate TILES binary (native format is big-endian, swap for little-endian)
    let mut tiles_data: Vec<u8> = Vec::with_capacity(unique_tiles.len() * 32);

    // Debug: show first non-empty tile before/after
    if unique_tiles.len() > 1 {
        eprintln!("DEBUG TILES: tiles_big_endian = {}", tiles_big_endian);
        eprintln!("DEBUG TILES: First tile (raw): {:02X} {:02X} {:02X} {:02X} {:02X} {:02X} {:02X} {:02X}",
            unique_tiles[1][0], unique_tiles[1][1], unique_tiles[1][2], unique_tiles[1][3],
            unique_tiles[1][4], unique_tiles[1][5], unique_tiles[1][6], unique_tiles[1][7]);
    }

    for tile in unique_tiles.iter() {
        if tiles_big_endian {
            // Keep native format (already big-endian: plane1, plane2 per line)
            tiles_data.extend_from_slice(tile);
        } else {
            // Swap each pair of bytes for little-endian output
            for i in (0..32).step_by(2) {
                tiles_data.push(tile[i + 1]);
                tiles_data.push(tile[i]);
            }
        }
    }

    // Debug: show first non-empty tile after swap
    if unique_tiles.len() > 1 {
        let offset = 32; // Skip empty tile (tile 0)
        eprintln!("DEBUG TILES: First tile (output): {:02X} {:02X} {:02X} {:02X} {:02X} {:02X} {:02X} {:02X}",
            tiles_data[offset], tiles_data[offset+1], tiles_data[offset+2], tiles_data[offset+3],
            tiles_data[offset+4], tiles_data[offset+5], tiles_data[offset+6], tiles_data[offset+7]);
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
            if pal_big_endian {
                pal_data.push((word >> 8) as u8);
                pal_data.push((word & 0xFF) as u8);
            } else {
                pal_data.push((word & 0xFF) as u8);
                pal_data.push((word >> 8) as u8);
            }
        }
    }

    let empty_count = empty_tiles.iter().filter(|&&b| b).count();

    // Build debug info string for JavaScript console
    let mut debug_info = String::new();
    debug_info.push_str(&format!("Processed {} non-empty tiles, {} unique patterns\n", debug_non_empty_count, debug_new_unique_count));

    // Show first few palette colors
    if !palettes.is_empty() {
        debug_info.push_str(&format!("Palette 0: {:?}\n", &palettes[0].iter().take(6).collect::<Vec<_>>()));
    }

    // Show first non-empty tile's pixel colors
    let first_non_empty = empty_tiles.iter().position(|&e| !e);
    if let Some(tile_idx) = first_non_empty {
        let tile_x = (tile_idx % tiles_x as usize) as u32;
        let tile_y = (tile_idx / tiles_x as usize) as u32;
        debug_info.push_str(&format!("First non-empty tile {} at ({},{})\n", tile_idx, tile_x, tile_y));

        // Get first 4 pixel colors from this tile
        for py in 0..2 {
            for px in 0..2 {
                let pixel = img.get_pixel(tile_x * 8 + px, tile_y * 8 + py);
                let hex = format!("#{:02X}{:02X}{:02X}", pixel.0[0], pixel.0[1], pixel.0[2]);
                debug_info.push_str(&format!("  pixel({},{})={}\n", px, py, hex));
            }
        }

        // Check if these pixels match palette 0
        let pal_idx = tile_palette_map.get(tile_idx).copied().unwrap_or(0);
        let palette = palettes.get(pal_idx).cloned().unwrap_or_default();
        debug_info.push_str(&format!("Using palette {} with {} colors\n", pal_idx, palette.len()));
    }

    // Debug: Final counts
    eprintln!("DEBUG export_binaries RESULT:");
    eprintln!("  total_tiles: {}", total_tiles);
    eprintln!("  empty_tiles: {}", empty_count);
    eprintln!("  unique_tiles: {}", unique_tiles.len());
    eprintln!("  tiles_data size: {} bytes", tiles_data.len());

    Ok(BinaryExportResult {
        bat: bat_data,
        tiles: tiles_data,
        palettes: pal_data,
        tile_count: total_tiles,
        unique_tile_count: unique_tiles.len(),
        image_width: width,
        image_height: height,
        bat_width,
        bat_height,
        palette_count: palettes.len(),
        empty_tile_count: empty_count,
        debug_info,
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

/// Save HTML report to disk - creates a directory with HTML file and image
#[tauri::command]
fn save_html_report(
    base_path: String,
    image_data: Vec<u8>,  // PNG image as bytes
    palettes: Vec<Vec<String>>,
    tile_palette_map: Vec<usize>,
    tile_count: usize,
    unique_tile_count: usize,
    vram_base_address: u32,
    settings: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    use std::fs;
    use std::path::Path;

    let base = Path::new(&base_path);
    let dir_name = base.file_stem()
        .and_then(|s| s.to_str())
        .ok_or("Invalid path")?;
    let parent = base.parent().ok_or("Invalid parent directory")?;
    let dir_path = parent.join(dir_name);

    // Create the directory
    fs::create_dir_all(&dir_path)
        .map_err(|e| format!("Failed to create directory: {}", e))?;

    // Save the image
    let image_path = dir_path.join(format!("{}.png", dir_name));
    fs::write(&image_path, &image_data)
        .map_err(|e| format!("Failed to write image: {}", e))?;

    // Count tiles per palette
    let mut palette_usage: Vec<usize> = vec![0; 16];
    for &pal_idx in &tile_palette_map {
        if pal_idx < 16 {
            palette_usage[pal_idx] += 1;
        }
    }

    // Calculate VRAM usage
    let bat_size = tile_count * 2;
    let tiles_size = unique_tile_count * 32;
    let pal_size = 512;
    let total_vram = bat_size + tiles_size + pal_size;

    // Generate palette HTML
    let mut palettes_html = String::new();
    for (pal_idx, palette) in palettes.iter().enumerate() {
        if palette_usage.get(pal_idx).copied().unwrap_or(0) == 0 && pal_idx > 0 {
            continue; // Skip unused palettes (except palette 0)
        }
        palettes_html.push_str(&format!(
            r#"<div class="palette-card">
                <div class="palette-header">Palette {} <span class="usage">({} tuiles)</span></div>
                <div class="palette-colors">"#,
            pal_idx, palette_usage.get(pal_idx).copied().unwrap_or(0)
        ));
        for (col_idx, color) in palette.iter().enumerate() {
            palettes_html.push_str(&format!(
                "<div class=\"color-swatch\" style=\"background-color: {};\" title=\"#{}: {}\"></div>",
                color, col_idx, color
            ));
        }
        palettes_html.push_str("</div></div>\n");
    }

    // Build settings HTML
    let mut settings_html = String::new();
    let setting_order = ["resize", "palettes", "dithering", "transparency", "keepRatio", "width", "height"];
    for key in &setting_order {
        if let Some(value) = settings.get(*key) {
            let label = match *key {
                "resize" => "Redimensionnement",
                "palettes" => "Nombre de palettes",
                "dithering" => "Dithering",
                "transparency" => "Transparence",
                "keepRatio" => "Conserver ratio",
                "width" => "Largeur (tuiles)",
                "height" => "Hauteur (tuiles)",
                _ => *key,
            };
            settings_html.push_str(&format!(
                "<tr><td>{}</td><td>{}</td></tr>\n",
                label, value
            ));
        }
    }

    // Generate the HTML report
    let html = format!(r#"<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Image2PCE II - Rapport: {name}</title>
    <style>
        * {{ box-sizing: border-box; margin: 0; padding: 0; }}
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0f1116;
            color: #e7e9ee;
            padding: 24px;
            line-height: 1.6;
        }}
        .container {{ max-width: 1200px; margin: 0 auto; }}
        h1 {{ font-size: 24px; margin-bottom: 8px; }}
        h2 {{ font-size: 18px; margin: 24px 0 12px; color: #aab3c2; }}
        .subtitle {{ color: #9aa4b2; font-size: 14px; margin-bottom: 24px; }}
        .grid {{ display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }}
        @media (max-width: 800px) {{ .grid {{ grid-template-columns: 1fr; }} }}
        .card {{
            background: #151924;
            border: 1px solid #1f2432;
            border-radius: 12px;
            padding: 16px;
        }}
        .image-preview {{
            text-align: center;
            background: #0d1016;
            border-radius: 8px;
            padding: 16px;
        }}
        .image-preview img {{
            max-width: 100%;
            image-rendering: pixelated;
            border: 1px solid #2a3142;
        }}
        table {{
            width: 100%;
            border-collapse: collapse;
        }}
        td {{
            padding: 8px 12px;
            border-bottom: 1px solid #2a3142;
        }}
        td:first-child {{ color: #aab3c2; }}
        td:last-child {{ text-align: right; font-family: monospace; }}
        .palettes-grid {{
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
            gap: 12px;
        }}
        .palette-card {{
            background: #0d1016;
            border: 1px solid #2a3142;
            border-radius: 8px;
            padding: 10px;
        }}
        .palette-header {{
            font-size: 12px;
            color: #9aa4b2;
            margin-bottom: 8px;
        }}
        .palette-header .usage {{ color: #6a7a9a; }}
        .palette-colors {{
            display: grid;
            grid-template-columns: repeat(8, 1fr);
            gap: 3px;
        }}
        .color-swatch {{
            aspect-ratio: 1;
            border-radius: 3px;
            border: 1px solid #2a3142;
        }}
        .stat-value {{ font-size: 24px; font-weight: 600; color: #4f76ff; }}
        .stat-label {{ font-size: 12px; color: #9aa4b2; }}
        .stats-grid {{
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 16px;
            text-align: center;
        }}
        .vram-bar {{
            height: 8px;
            background: #2a3142;
            border-radius: 4px;
            overflow: hidden;
            margin-top: 8px;
        }}
        .vram-fill {{
            height: 100%;
            background: linear-gradient(90deg, #4f76ff, #6a4bff);
            border-radius: 4px;
        }}
        .warning {{ color: #ff6b6b; }}
        footer {{
            text-align: center;
            margin-top: 32px;
            padding-top: 16px;
            border-top: 1px solid #2a3142;
            color: #6a7a9a;
            font-size: 12px;
        }}
    </style>
</head>
<body>
    <div class="container">
        <h1>Image2PCE II - Rapport de conversion</h1>
        <p class="subtitle">{name}</p>

        <div class="grid">
            <div class="card">
                <h2>Image convertie</h2>
                <div class="image-preview">
                    <img src="{name}.png" alt="Image convertie">
                </div>
            </div>

            <div class="card">
                <h2>Statistiques</h2>
                <div class="stats-grid">
                    <div>
                        <div class="stat-value">{tile_count}</div>
                        <div class="stat-label">Tuiles totales</div>
                    </div>
                    <div>
                        <div class="stat-value">{unique_tile_count}</div>
                        <div class="stat-label">Tuiles uniques</div>
                    </div>
                    <div>
                        <div class="stat-value">{palette_count}</div>
                        <div class="stat-label">Palettes</div>
                    </div>
                    <div>
                        <div class="stat-value">{dedup_percent:.1}%</div>
                        <div class="stat-label">Déduplication</div>
                    </div>
                </div>

                <h2>Mémoire VRAM</h2>
                <table>
                    <tr><td>BAT</td><td>{bat_size} octets</td></tr>
                    <tr><td>Tuiles ({unique_tile_count} × 32)</td><td>{tiles_size} octets</td></tr>
                    <tr><td>Palettes (16 × 32)</td><td>{pal_size} octets</td></tr>
                    <tr><td><strong>Total</strong></td><td><strong>{total_vram} octets</strong></td></tr>
                </table>
                <div class="vram-bar">
                    <div class="vram-fill" style="width: {vram_percent:.1}%"></div>
                </div>
                <p style="font-size: 12px; color: #9aa4b2; margin-top: 4px;">
                    {vram_percent:.1}% de 64 Ko {vram_warning}
                </p>

                <h2>Paramètres</h2>
                <table>
                    <tr><td>Adresse VRAM</td><td>${vram_addr:04X}</td></tr>
                    {settings_html}
                </table>
            </div>
        </div>

        <h2>Palettes générées</h2>
        <div class="palettes-grid">
            {palettes_html}
        </div>

        <footer>
            Généré par Image2PCE II - Convertisseur d'images PC-Engine
        </footer>
    </div>
</body>
</html>"#,
        name = dir_name,
        tile_count = tile_count,
        unique_tile_count = unique_tile_count,
        palette_count = palettes.len(),
        dedup_percent = if tile_count > 0 {
            (1.0 - (unique_tile_count as f64 / tile_count as f64)) * 100.0
        } else { 0.0 },
        bat_size = bat_size,
        tiles_size = tiles_size,
        pal_size = pal_size,
        total_vram = total_vram,
        vram_percent = (total_vram as f64 / 65536.0) * 100.0,
        vram_warning = if total_vram > 65536 { "<span class=\"warning\">(Dépassement!)</span>" } else { "" },
        vram_addr = vram_base_address,
        settings_html = settings_html,
        palettes_html = palettes_html,
    );

    // Write the HTML file
    let html_path = dir_path.join(format!("{}.html", dir_name));
    fs::write(&html_path, html)
        .map_err(|e| format!("Failed to write HTML file: {}", e))?;

    Ok(())
}

/// Save project to disk - writes JSON project file
#[tauri::command]
async fn save_project(app: AppHandle, content: String, default_path: Option<String>) -> Result<Option<String>, String> {
    use std::fs;
    use std::path::Path;

    // Determine default filename from provided path or use generic name
    let default_name = default_path
        .as_ref()
        .and_then(|p| Path::new(p).file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("project.i2p")
        .to_string();

    let file = app
        .dialog()
        .file()
        .add_filter("Image2PCE Project", &["i2p"])
        .set_file_name(&default_name)
        .blocking_save_file();

    match file {
        Some(path) => {
            let path_str = path.into_path()
                .map_err(|e| format!("Invalid path: {:?}", e))?
                .to_string_lossy()
                .to_string();
            fs::write(&path_str, &content)
                .map_err(|e| format!("Failed to write project file: {}", e))?;
            Ok(Some(path_str))
        }
        None => Ok(None),
    }
}

/// Load project from disk - reads JSON project file
#[tauri::command]
async fn load_project(app: AppHandle) -> Result<Option<(String, String)>, String> {
    use std::fs;

    let file = app
        .dialog()
        .file()
        .add_filter("Image2PCE Project", &["i2p"])
        .blocking_pick_file();

    match file {
        Some(path) => {
            let path_str = path.into_path()
                .map_err(|e| format!("Invalid path: {:?}", e))?
                .to_string_lossy()
                .to_string();
            let content = fs::read_to_string(&path_str)
                .map_err(|e| format!("Failed to read project file: {}", e))?;
            Ok(Some((path_str, content)))
        }
        None => Ok(None),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .invoke_handler(tauri::generate_handler![open_image, run_conversion, export_plain_text, export_binaries, save_binaries_to_disk, save_html_report, save_project, load_project])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
