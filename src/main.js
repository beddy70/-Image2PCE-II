const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const state = {
  inputImage: null,
  outputPreview: null,
  outputImageBase64: null,
  originalImageData: null, // Store original ImageData for blur processing
  palettes: [],
  tilePaletteMap: [],
  emptyTiles: [],
  fixedColor0: "#000000",
  isConverting: false,
  hoveredTile: null,
  // Tile stats for display
  tileStats: {
    total: 0,
    unique: 0,
    duplicates: 0,
    tilesBytes: 0,
    batBytes: 0,
  },
  drag: {
    input: { x: 0, y: 0, isDragging: false, lastX: 0, lastY: 0 },
    output: { x: 0, y: 0, isDragging: false, lastX: 0, lastY: 0 },
  },
  // Curve editor: 9 control points for RGB333 thresholds (input → output)
  // Default linear mapping: input 0,32,64,96,128,160,192,224,255 → output 0,32,64,96,128,160,192,224,255
  curvePoints: [
    { x: 0, y: 0 },
    { x: 32, y: 32 },
    { x: 64, y: 64 },
    { x: 96, y: 96 },
    { x: 128, y: 128 },
    { x: 160, y: 160 },
    { x: 192, y: 192 },
    { x: 224, y: 224 },
    { x: 255, y: 255 },
  ],
  curveSelectedPoint: null,
};

async function openImage() {
  const selected = await invoke("open_image");
  if (!selected) {
    return;
  }

  state.inputImage = selected;
  const inputMeta = document.querySelector("#input-meta");
  inputMeta.textContent = selected;
  const inputCanvas = document.querySelector("#input-canvas");
  const fileUrl = convertFileSrc(selected);
  inputCanvas.innerHTML = `
    <div class="viewer__stage">
      <img src="${fileUrl}" alt="source" class="viewer__image" />
    </div>
    <div class="viewer__path">${selected}</div>
  `;
  applyZoom("input");
}

function showProgress(show, text = "Conversion en cours...") {
  const overlay = document.querySelector("#progress-overlay");
  const progressText = document.querySelector("#progress-text");
  const progressFill = document.querySelector("#progress-fill");

  if (overlay) {
    overlay.classList.toggle("is-visible", show);
  }
  if (progressText) {
    progressText.textContent = text;
  }
  if (progressFill) {
    if (show) {
      progressFill.classList.add("is-indeterminate");
      progressFill.style.width = "0%";
    } else {
      progressFill.classList.remove("is-indeterminate");
    }
  }
  state.isConverting = show;
}

function updateProgress(percent, text) {
  const progressText = document.querySelector("#progress-text");
  const progressFill = document.querySelector("#progress-fill");

  if (progressText && text) {
    progressText.textContent = text;
  }
  if (progressFill && percent !== undefined) {
    progressFill.classList.remove("is-indeterminate");
    progressFill.style.width = `${percent}%`;
  }
}

async function runConversion() {
  if (!state.inputImage) {
    console.warn("Aucune image source sélectionnée.");
    return;
  }

  if (state.isConverting) {
    return;
  }

  // Clear previous output to ensure progress bar is visible
  const outputCanvas = document.querySelector("#output-canvas");
  outputCanvas.innerHTML = '<p>Conversion en cours...</p>';

  showProgress(true);
  updateProgress(0, "Démarrage de la conversion...");

  // Wait for browser to paint the progress bar (double rAF ensures paint is complete)
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  const resizeMethod = document.querySelector("#resize-method").value;
  const paletteCount = parseInt(
    document.querySelector("#palette-count").value,
    10,
  );
  const ditherMode = document.querySelector("#dither-mode").value;
  const color0Mode = document.querySelector("#color0-mode").value;
  const keepRatio = document.querySelector("#keep-ratio").checked;

  // Use fixed color0 if mode is "fixed", otherwise use background-color input
  const backgroundColor = color0Mode === "fixed"
    ? state.fixedColor0
    : document.querySelector("#background-color").value;

  // Listen for progress events from Rust backend
  const unlisten = await listen("conversion-progress", (event) => {
    const { percent, stage } = event.payload;
    updateProgress(percent, stage);
  });

  try {
    // Get the curve lookup table for RGB333 quantization
    const curveLut = getCurveLUT();

    const conversionResult = await invoke("run_conversion", {
      inputPath: state.inputImage,
      resizeMethod,
      paletteCount,
      ditherMode,
      backgroundColor,
      keepRatio,
      curveLut,
    });

    const {
      preview_base64: previewBase64,
      palettes,
      tile_palette_map: tilePaletteMap,
      empty_tiles: emptyTiles,
      tile_count: tileCount,
      unique_tile_count: uniqueTileCount,
    } = conversionResult;

    // Store in state for tile hover feature and export
    state.palettes = palettes;
    state.tilePaletteMap = tilePaletteMap;
    state.emptyTiles = emptyTiles;
    state.outputImageBase64 = previewBase64;

    // Calculate tile stats
    const duplicates = tileCount - uniqueTileCount;
    const tilesBytes = uniqueTileCount * 32 + 32; // +32 for empty tile
    const batBytes = tileCount * 2;
    state.tileStats = {
      total: tileCount,
      unique: uniqueTileCount,
      duplicates,
      tilesBytes,
      batBytes,
    };

    const outputCanvas = document.querySelector("#output-canvas");
    outputCanvas.innerHTML = `
      <div class="viewer__stage">
        <canvas id="output-image-canvas" class="viewer__image" width="256" height="256"></canvas>
        <div class="tile-highlight" id="tile-highlight"></div>
      </div>
      <canvas class="tile-zoom" id="tile-zoom" width="80" height="80"></canvas>
    `;

    // Load image into canvas and store original data
    const img = new Image();
    img.onload = () => {
      const canvas = document.querySelector("#output-image-canvas");
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0);
      state.originalImageData = ctx.getImageData(0, 0, 256, 256);

      // Apply current blur setting
      applyCrtBlur();
    };
    img.src = `data:image/png;base64,${previewBase64}`;

    const outputMeta = document.querySelector("#output-meta");
    outputMeta.textContent = `${tileCount} tuiles (${uniqueTileCount} uniques, ${duplicates} doublons) — ${tilesBytes} octets`;

    applyZoom("output");
    renderPalettes(palettes, tilePaletteMap);
    setupTileHover();
  } catch (error) {
    console.error("Conversion error:", error);
    updateProgress(0, "Erreur de conversion");
  } finally {
    // Stop listening for progress events
    unlisten();
    // Small delay to show completion
    setTimeout(() => showProgress(false), 500);
  }
}

function renderPalettes(palettes, tilePaletteMap = []) {
  const grid = document.querySelector("#palettes-grid");
  const summary = document.querySelector("#palette-summary");
  if (!grid || !summary) {
    return;
  }

  // Count empty tiles
  const emptyTileCount = state.emptyTiles.filter(Boolean).length;
  const totalTiles = state.emptyTiles.length;
  const nonEmptyTileCount = totalTiles - emptyTileCount;

  // Count actually used palettes (palettes with non-empty tiles that have real colors)
  const usedPaletteCount = palettes.filter((palette, index) => {
    // Count non-empty tiles assigned to this palette
    const hasTiles = tilePaletteMap.filter((entry, tileIdx) =>
      entry === index && !state.emptyTiles[tileIdx]
    ).length > 0;
    const hasRealColors = palette.some((color) => color !== state.fixedColor0 && color !== "#000000");
    return hasTiles && hasRealColors;
  }).length;

  // Palettes are already sorted by the backend (most used first, empty at end)
  grid.innerHTML = "";
  palettes.forEach((palette, index) => {
    // Count only non-empty tiles for usage
    const usageCount = tilePaletteMap.filter((entry, tileIdx) =>
      entry === index && !state.emptyTiles[tileIdx]
    ).length;
    const card = document.createElement("div");
    card.className = "palette-card";
    card.dataset.paletteIndex = index;
    const title = document.createElement("div");
    title.className = "palette-card__title";
    title.textContent = `Palette ${index} (${usageCount} tuiles)`;
    const colors = document.createElement("div");
    colors.className = "palette-card__colors";
    palette.forEach((color) => {
      const swatch = document.createElement("div");
      swatch.className = "palette-swatch";
      swatch.style.backgroundColor = color;
      swatch.title = color;
      // Mark selected color0
      if (color.toUpperCase() === state.fixedColor0.toUpperCase()) {
        swatch.classList.add("is-selected");
      }
      // Add click handler to select as color0
      swatch.addEventListener("click", () => selectColor0(color));
      colors.appendChild(swatch);
    });
    card.appendChild(title);
    card.appendChild(colors);
    grid.appendChild(card);
  });
  const emptyInfo = emptyTileCount > 0 ? ` — ${nonEmptyTileCount}/${totalTiles} tuiles actives` : "";
  summary.textContent = `${usedPaletteCount} palette(s)${emptyInfo}`;
}

function selectColor0(color) {
  const color0Mode = document.querySelector("#color0-mode");
  const color0Preview = document.querySelector("#color0-preview");
  const backgroundColorInput = document.querySelector("#background-color");

  // Set mode to fixed
  color0Mode.value = "fixed";
  state.fixedColor0 = color.toUpperCase();

  // Update background-color input to stay in sync
  if (backgroundColorInput) {
    backgroundColorInput.value = color.toUpperCase();
  }

  // Update preview
  if (color0Preview) {
    color0Preview.style.backgroundColor = color;
    color0Preview.classList.add("is-visible");
    color0Preview.title = `Couleur 0 fixée: ${color}`;
  }

  // Update all swatches to show selection
  document.querySelectorAll(".palette-swatch").forEach((swatch) => {
    swatch.classList.toggle("is-selected",
      swatch.style.backgroundColor === color ||
      rgbToHex(swatch.style.backgroundColor).toUpperCase() === color.toUpperCase()
    );
  });

  // Save settings
  saveSettings();
}

function rgbToHex(rgb) {
  if (rgb.startsWith("#")) return rgb;
  const match = rgb.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
  if (!match) return rgb;
  const r = parseInt(match[1], 10);
  const g = parseInt(match[2], 10);
  const b = parseInt(match[3], 10);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase()}`;
}

function updateColor0Preview() {
  const color0Mode = document.querySelector("#color0-mode");
  const color0Preview = document.querySelector("#color0-preview");
  const backgroundColorInput = document.querySelector("#background-color");

  if (color0Mode && color0Preview) {
    const isFixed = color0Mode.value === "fixed";
    // Always show preview to indicate the effective color0
    color0Preview.classList.add("is-visible");

    if (isFixed) {
      color0Preview.style.backgroundColor = state.fixedColor0;
      color0Preview.title = `Couleur 0 fixée: ${state.fixedColor0}`;
    } else {
      // In auto mode, sync with background-color input
      const bgColor = backgroundColorInput ? backgroundColorInput.value : "#000000";
      color0Preview.style.backgroundColor = bgColor;
      color0Preview.title = `Couleur 0 auto: ${bgColor}`;
      state.fixedColor0 = bgColor.toUpperCase();
    }
  }
}

function applyZoom(target) {
  const slider = document.querySelector(`#zoom-${target}`);
  const stage = document.querySelector(`#${target}-canvas .viewer__stage`);
  if (!slider || !stage) {
    return;
  }
  const zoom = Number(slider.value);
  const dragState = state.drag[target];
  stage.style.transform = `translate(${dragState.x}px, ${dragState.y}px) scale(${zoom})`;
}

function setupDrag(target) {
  const canvas = document.querySelector(`#${target}-canvas`);
  if (!canvas) {
    return;
  }
  canvas.addEventListener("mousedown", (event) => {
    const dragState = state.drag[target];
    dragState.isDragging = true;
    dragState.lastX = event.clientX;
    dragState.lastY = event.clientY;
    canvas.classList.add("is-dragging");
  });

  window.addEventListener("mouseup", () => {
    const dragState = state.drag[target];
    dragState.isDragging = false;
    canvas.classList.remove("is-dragging");
  });

  window.addEventListener("mousemove", (event) => {
    const dragState = state.drag[target];
    if (!dragState.isDragging) {
      return;
    }
    const dx = event.clientX - dragState.lastX;
    const dy = event.clientY - dragState.lastY;
    dragState.lastX = event.clientX;
    dragState.lastY = event.clientY;
    dragState.x += dx;
    dragState.y += dy;
    applyZoom(target);
  });
}

function setupTileHover() {
  const outputCanvas = document.querySelector("#output-canvas");
  const tileHighlight = document.querySelector("#tile-highlight");
  const tileZoom = document.querySelector("#tile-zoom");

  if (!outputCanvas || !tileHighlight) {
    return;
  }

  outputCanvas.addEventListener("mousemove", (event) => {
    if (state.tilePaletteMap.length === 0) {
      return;
    }

    const stage = outputCanvas.querySelector(".viewer__stage");
    const img = outputCanvas.querySelector(".viewer__image");
    if (!stage || !img) {
      return;
    }

    // Get zoom level
    const zoomSlider = document.querySelector("#zoom-output");
    const zoom = zoomSlider ? Number(zoomSlider.value) : 1;

    // Get bounds
    const stageRect = stage.getBoundingClientRect();
    const imgRect = img.getBoundingClientRect();

    // Calculate image offset within the stage (due to flexbox centering)
    const imgOffsetX = (imgRect.left - stageRect.left) / zoom;
    const imgOffsetY = (imgRect.top - stageRect.top) / zoom;

    // Calculate mouse position relative to image
    const mouseX = event.clientX - imgRect.left;
    const mouseY = event.clientY - imgRect.top;

    // Convert to image coordinates (256x256)
    const imgX = mouseX / zoom;
    const imgY = mouseY / zoom;

    // Check if within image bounds
    if (imgX < 0 || imgX >= 256 || imgY < 0 || imgY >= 256) {
      tileHighlight.style.display = "none";
      clearPaletteHighlight();
      updatePaletteTooltip(null);
      return;
    }

    // Calculate tile coordinates (8x8 tiles)
    const tileX = Math.floor(imgX / 8);
    const tileY = Math.floor(imgY / 8);
    const tileIndex = tileY * 32 + tileX;

    // Update highlight position (add image offset within stage)
    tileHighlight.style.display = "block";
    tileHighlight.style.left = `${imgOffsetX + tileX * 8}px`;
    tileHighlight.style.top = `${imgOffsetY + tileY * 8}px`;

    // Draw zoomed tile (10x magnification)
    if (tileZoom) {
      tileZoom.style.display = "block";
      const ctx = tileZoom.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      // Draw 8x8 tile from source image, scaled to 80x80
      ctx.drawImage(
        img,
        tileX * 8, tileY * 8, 8, 8,  // source: tile position and size
        0, 0, 80, 80                  // dest: fill canvas at 10x zoom
      );
    }

    // Check if this is an empty tile
    const isEmpty = state.emptyTiles[tileIndex] || false;

    // Get palette index for this tile
    const paletteIndex = state.tilePaletteMap[tileIndex];
    if (paletteIndex !== undefined && paletteIndex !== state.hoveredTile) {
      state.hoveredTile = paletteIndex;
      if (!isEmpty) {
        highlightPalette(paletteIndex);
      } else {
        clearPaletteHighlight();
      }
      updatePaletteTooltip(paletteIndex, tileX, tileY, isEmpty);
    }
  });

  outputCanvas.addEventListener("mouseleave", () => {
    tileHighlight.style.display = "none";
    if (tileZoom) {
      tileZoom.style.display = "none";
    }
    clearPaletteHighlight();
    updatePaletteTooltip(null);
    state.hoveredTile = null;
  });
}

function highlightPalette(paletteIndex) {
  // Remove highlight from all palette cards
  document.querySelectorAll(".palette-card").forEach((card) => {
    card.classList.remove("is-highlighted");
  });

  // Add highlight to the matching palette card
  const targetCard = document.querySelector(`.palette-card[data-palette-index="${paletteIndex}"]`);
  if (targetCard) {
    targetCard.classList.add("is-highlighted");
    // Scroll into view if needed
    targetCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function clearPaletteHighlight() {
  document.querySelectorAll(".palette-card").forEach((card) => {
    card.classList.remove("is-highlighted");
  });
}

function updatePaletteTooltip(paletteIndex, tileX, tileY, isEmpty = false) {
  const tooltip = document.querySelector("#palette-tooltip");
  if (!tooltip) {
    return;
  }

  if (paletteIndex === null) {
    tooltip.innerHTML = "";
    return;
  }

  // Show empty tile indicator
  if (isEmpty) {
    tooltip.innerHTML = `<span class="palette-tooltip__label">Tuile (${tileX},${tileY}) — vide</span>`;
    return;
  }

  const palette = state.palettes[paletteIndex];
  if (!palette) {
    return;
  }

  // Show mini palette preview in tooltip
  tooltip.innerHTML = `
    <span class="palette-tooltip__label">Tuile (${tileX},${tileY}) → Palette ${paletteIndex}</span>
    <div class="palette-tooltip__colors">
      ${palette.slice(0, 8).map((color) => `<div class="palette-tooltip__swatch" style="background-color:${color}"></div>`).join("")}
    </div>
  `;
}

// ===== Curve Editor =====

function initCurveEditor() {
  const canvas = document.querySelector("#curve-canvas");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  let isDragging = false;

  drawCurve(ctx);

  canvas.addEventListener("mousedown", (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Find closest point (within 12px radius)
    const pointIndex = findClosestPoint(x, y);
    if (pointIndex !== -1) {
      state.curveSelectedPoint = pointIndex;
      isDragging = true;
      canvas.style.cursor = "grabbing";
    }
  });

  canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(255, e.clientX - rect.left));
    const y = Math.max(0, Math.min(255, e.clientY - rect.top));

    if (isDragging && state.curveSelectedPoint !== null) {
      const point = state.curvePoints[state.curveSelectedPoint];
      // First and last points: x is fixed (0 and 255)
      if (state.curveSelectedPoint === 0) {
        point.y = 255 - y;
      } else if (state.curveSelectedPoint === state.curvePoints.length - 1) {
        point.y = 255 - y;
      } else {
        // Middle points: x can move within bounds of neighbors
        const prevPoint = state.curvePoints[state.curveSelectedPoint - 1];
        const nextPoint = state.curvePoints[state.curveSelectedPoint + 1];
        point.x = Math.max(prevPoint.x + 1, Math.min(nextPoint.x - 1, x));
        point.y = 255 - y;
      }
      drawCurve(ctx);
    }

    // Update info display
    updateCurveInfo(x, 255 - y);

    // Change cursor if hovering over a point
    if (!isDragging) {
      const pointIndex = findClosestPoint(x, y);
      canvas.style.cursor = pointIndex !== -1 ? "grab" : "crosshair";
    }
  });

  window.addEventListener("mouseup", () => {
    if (isDragging) {
      isDragging = false;
      state.curveSelectedPoint = null;
      canvas.style.cursor = "crosshair";
    }
  });

  // Reset button
  document.querySelector("#curve-reset")?.addEventListener("click", () => {
    resetCurve();
    drawCurve(ctx);
    saveSettings();
  });
}

function findClosestPoint(x, y) {
  const threshold = 12;
  for (let i = 0; i < state.curvePoints.length; i++) {
    const point = state.curvePoints[i];
    const canvasY = 255 - point.y;
    const distance = Math.sqrt((x - point.x) ** 2 + (y - canvasY) ** 2);
    if (distance < threshold) {
      return i;
    }
  }
  return -1;
}

function resetCurve() {
  state.curvePoints = [
    { x: 0, y: 0 },
    { x: 32, y: 32 },
    { x: 64, y: 64 },
    { x: 96, y: 96 },
    { x: 128, y: 128 },
    { x: 160, y: 160 },
    { x: 192, y: 192 },
    { x: 224, y: 224 },
    { x: 255, y: 255 },
  ];
}

function drawCurve(ctx) {
  const width = 256;
  const height = 256;

  // Clear canvas
  ctx.fillStyle = "#0d1016";
  ctx.fillRect(0, 0, width, height);

  // Draw grid lines for RGB333 thresholds
  ctx.strokeStyle = "#2a3142";
  ctx.lineWidth = 1;

  // Vertical grid lines at threshold positions
  for (let i = 32; i < 256; i += 32) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, height);
    ctx.stroke();
  }

  // Horizontal grid lines at output levels
  for (let i = 32; i < 256; i += 32) {
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(width, i);
    ctx.stroke();
  }

  // Draw diagonal reference line
  ctx.strokeStyle = "#3a4152";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, height);
  ctx.lineTo(width, 0);
  ctx.stroke();
  ctx.setLineDash([]);

  // Draw the curve
  ctx.strokeStyle = "#4f76ff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(state.curvePoints[0].x, height - state.curvePoints[0].y);
  for (let i = 1; i < state.curvePoints.length; i++) {
    ctx.lineTo(state.curvePoints[i].x, height - state.curvePoints[i].y);
  }
  ctx.stroke();

  // Draw control points
  state.curvePoints.forEach((point, index) => {
    const canvasY = height - point.y;

    // Outer ring
    ctx.fillStyle = index === state.curveSelectedPoint ? "#6a4bff" : "#4f76ff";
    ctx.beginPath();
    ctx.arc(point.x, canvasY, 6, 0, Math.PI * 2);
    ctx.fill();

    // Inner dot
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(point.x, canvasY, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  // Draw RGB333 level labels on left side
  ctx.fillStyle = "#6f7a8c";
  ctx.font = "9px monospace";
  ctx.textAlign = "left";
  for (let i = 0; i < 8; i++) {
    const y = height - (i * 32 + 16);
    ctx.fillText(i.toString(), 4, y + 3);
  }
}

function updateCurveInfo(inputVal, outputVal) {
  const info = document.querySelector("#curve-info");
  if (info) {
    const inputLevel = Math.floor(inputVal / 32);
    const outputLevel = Math.floor(outputVal / 32);
    info.textContent = `Entrée: ${inputVal} (niveau ${Math.min(7, inputLevel)}) → Sortie: ${outputVal} (niveau ${Math.min(7, outputLevel)})`;
  }
}

function getCurveLUT() {
  // Generate a 256-entry lookup table from the curve points
  const lut = new Array(256);

  for (let i = 0; i < 256; i++) {
    // Find which segment this input value falls into
    let segmentIndex = 0;
    for (let j = 1; j < state.curvePoints.length; j++) {
      if (i <= state.curvePoints[j].x) {
        segmentIndex = j - 1;
        break;
      }
    }

    const p0 = state.curvePoints[segmentIndex];
    const p1 = state.curvePoints[segmentIndex + 1];

    // Linear interpolation
    const t = (i - p0.x) / (p1.x - p0.x);
    lut[i] = Math.round(p0.y + t * (p1.y - p0.y));
  }

  return lut;
}

// ===== End Curve Editor =====

// ===== Export Functions =====

function getVramAddress() {
  const input = document.querySelector("#vram-address");
  if (!input) return 0x4000;

  let value = input.value.trim().toUpperCase();

  // Remove $ or 0x prefix
  if (value.startsWith("$")) {
    value = value.substring(1);
  } else if (value.startsWith("0X")) {
    value = value.substring(2);
  }

  // Parse as hex
  const parsed = parseInt(value, 16);
  return isNaN(parsed) ? 0x4000 : parsed;
}

async function exportPlainText() {
  if (!state.outputImageBase64 || state.palettes.length === 0) {
    console.warn("Aucune image convertie à exporter");
    return;
  }

  try {
    // Convert base64 to byte array
    const binaryString = atob(state.outputImageBase64);
    const imageData = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      imageData[i] = binaryString.charCodeAt(i);
    }

    const vramAddress = getVramAddress();

    // Call Rust export function
    const result = await invoke("export_plain_text", {
      imageData: Array.from(imageData),
      palettes: state.palettes,
      tilePaletteMap: state.tilePaletteMap,
      emptyTiles: state.emptyTiles,
      vramBaseAddress: vramAddress,
    });

    // Show save dialog
    const { save } = window.__TAURI__.dialog;
    const filePath = await save({
      defaultPath: "export.asm",
      filters: [
        { name: "Assembly", extensions: ["asm", "inc", "s"] },
        { name: "Text", extensions: ["txt"] },
      ],
    });

    if (filePath) {
      // Write file
      const { writeTextFile } = window.__TAURI__.fs;
      await writeTextFile(filePath, result.plain_text);
      console.info(`Exporté: ${result.unique_tile_count} tuiles uniques (${result.tile_count} total)`);
    }
  } catch (error) {
    console.error("Erreur d'export:", error);
  }
}

async function exportBinaries() {
  if (!state.outputImageBase64 || state.palettes.length === 0) {
    console.warn("Aucune image convertie à exporter");
    return;
  }

  try {
    // Convert base64 to byte array
    const binaryString = atob(state.outputImageBase64);
    const imageData = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      imageData[i] = binaryString.charCodeAt(i);
    }

    const vramAddress = getVramAddress();

    // Call Rust export function
    const result = await invoke("export_binaries", {
      imageData: Array.from(imageData),
      palettes: state.palettes,
      tilePaletteMap: state.tilePaletteMap,
      emptyTiles: state.emptyTiles,
      vramBaseAddress: vramAddress,
    });

    // Show single save dialog - user picks base filename
    const { save } = window.__TAURI__.dialog;
    const { writeFile } = window.__TAURI__.fs;

    const basePath = await save({
      defaultPath: "export.bat",
      filters: [{ name: "BAT file", extensions: ["bat"] }],
    });

    if (!basePath) {
      return; // User cancelled
    }

    // Derive the 3 filenames from the base path
    // Remove extension and add .bat, .tile, .pal
    const baseWithoutExt = basePath.replace(/\.[^.]+$/, "");
    const batPath = baseWithoutExt + ".bat";
    const tilePath = baseWithoutExt + ".tile";
    const palPath = baseWithoutExt + ".pal";

    // Write all 3 files
    await writeFile(batPath, new Uint8Array(result.bat));
    await writeFile(tilePath, new Uint8Array(result.tiles));
    await writeFile(palPath, new Uint8Array(result.palettes));

    console.info(`Binaires exportés: ${batPath}, ${tilePath}, ${palPath}`);
    console.info(`${result.unique_tile_count} tuiles uniques (${result.tile_count} total)`);
  } catch (error) {
    console.error("Erreur d'export binaire:", error);
  }
}

// ===== End Export Functions =====

// ===== Settings Persistence =====

const SETTINGS_KEY = "image2pce-settings";

function saveSettings() {
  const viewer = document.querySelector(".viewer");
  const viewerHeight = viewer ? parseInt(getComputedStyle(viewer).getPropertyValue("--viewer-height")) || 500 : 500;

  const settings = {
    resizeMethod: document.querySelector("#resize-method")?.value,
    paletteCount: document.querySelector("#palette-count")?.value,
    color0Mode: document.querySelector("#color0-mode")?.value,
    ditherMode: document.querySelector("#dither-mode")?.value,
    backgroundColor: document.querySelector("#background-color")?.value,
    transparency: document.querySelector("#transparency")?.checked,
    keepRatio: document.querySelector("#keep-ratio")?.checked,
    ditherMask: document.querySelector("#dither-mask")?.checked,
    vramAddress: document.querySelector("#vram-address")?.value,
    zoomInput: document.querySelector("#zoom-input")?.value,
    zoomOutput: document.querySelector("#zoom-output")?.value,
    crtMode: document.querySelector("#crt-mode")?.value,
    crtBlur: document.querySelector("#crt-blur")?.value,
    viewerHeight: viewerHeight,
    curvePoints: state.curvePoints,
    fixedColor0: state.fixedColor0,
  };

  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn("Impossible de sauvegarder les réglages:", e);
  }
}

function loadSettings() {
  try {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (!saved) return;

    const settings = JSON.parse(saved);

    // Restore form values
    if (settings.resizeMethod) {
      const el = document.querySelector("#resize-method");
      if (el) el.value = settings.resizeMethod;
    }
    if (settings.paletteCount) {
      const el = document.querySelector("#palette-count");
      if (el) el.value = settings.paletteCount;
    }
    if (settings.color0Mode) {
      const el = document.querySelector("#color0-mode");
      if (el) el.value = settings.color0Mode;
    }
    if (settings.ditherMode) {
      const el = document.querySelector("#dither-mode");
      if (el) el.value = settings.ditherMode;
    }
    if (settings.backgroundColor) {
      const el = document.querySelector("#background-color");
      if (el) el.value = settings.backgroundColor;
    }
    if (settings.transparency !== undefined) {
      const el = document.querySelector("#transparency");
      if (el) el.checked = settings.transparency;
    }
    if (settings.keepRatio !== undefined) {
      const el = document.querySelector("#keep-ratio");
      if (el) el.checked = settings.keepRatio;
    }
    if (settings.ditherMask !== undefined) {
      const el = document.querySelector("#dither-mask");
      if (el) el.checked = settings.ditherMask;
    }
    if (settings.vramAddress) {
      const el = document.querySelector("#vram-address");
      if (el) el.value = settings.vramAddress;
    }
    if (settings.zoomInput) {
      const el = document.querySelector("#zoom-input");
      if (el) el.value = settings.zoomInput;
    }
    if (settings.zoomOutput) {
      const el = document.querySelector("#zoom-output");
      if (el) el.value = settings.zoomOutput;
    }
    if (settings.crtMode) {
      const el = document.querySelector("#crt-mode");
      if (el) el.value = settings.crtMode;
    }
    if (settings.crtBlur) {
      const el = document.querySelector("#crt-blur");
      if (el) el.value = settings.crtBlur;
    }
    if (settings.viewerHeight) {
      applyViewerHeight(settings.viewerHeight);
    }

    // Restore state values
    if (settings.curvePoints && Array.isArray(settings.curvePoints)) {
      state.curvePoints = settings.curvePoints;
    }
    if (settings.fixedColor0) {
      state.fixedColor0 = settings.fixedColor0;
    }

  } catch (e) {
    console.warn("Impossible de charger les réglages:", e);
  }
}

function setupSettingsAutoSave() {
  // Save on any input change
  const inputs = [
    "#resize-method",
    "#palette-count",
    "#color0-mode",
    "#dither-mode",
    "#background-color",
    "#transparency",
    "#keep-ratio",
    "#dither-mask",
    "#vram-address",
    "#zoom-input",
    "#zoom-output",
    "#crt-mode",
    "#crt-blur",
  ];

  inputs.forEach((selector) => {
    const el = document.querySelector(selector);
    if (el) {
      el.addEventListener("change", saveSettings);
      el.addEventListener("input", saveSettings);
    }
  });

  // Save curve changes on mouseup
  const curveCanvas = document.querySelector("#curve-canvas");
  if (curveCanvas) {
    curveCanvas.addEventListener("mouseup", saveSettings);
  }

  // Save on window close
  window.addEventListener("beforeunload", saveSettings);
}

// ===== End Settings Persistence =====

// ===== CRT Simulation =====

function applyCrtMode(mode) {
  const overlay = document.querySelector("#crt-overlay");
  const wrapper = document.querySelector(".viewer__canvas-wrapper");
  if (!overlay) return;

  // Remove all CRT classes
  overlay.classList.remove("is-active", "crt-scanlines", "crt-aperture", "crt-shadowmask", "crt-composite");
  wrapper?.classList.remove("crt-glow");

  if (mode && mode !== "none") {
    overlay.classList.add("is-active", `crt-${mode}`);
    wrapper?.classList.add("crt-glow");
    // Apply current blur value
    applyCrtBlur();
  }
}

function applyCrtBlur() {
  const canvas = document.querySelector("#output-image-canvas");
  const blurSlider = document.querySelector("#crt-blur");
  const crtMode = document.querySelector("#crt-mode")?.value;

  if (!canvas || !blurSlider || !state.originalImageData) return;

  const ctx = canvas.getContext("2d");
  const sliderValue = parseInt(blurSlider.value, 10);

  // If no CRT mode or blur is 0, restore original image
  if (!crtMode || crtMode === "none" || sliderValue === 0) {
    ctx.putImageData(state.originalImageData, 0, 0);
    return;
  }

  // Apply box blur with the slider value as radius (0-100 maps to 0-3 radius)
  // Using fractional blur for smooth transitions
  const blurRadius = (sliderValue / 100) * 3;
  const blurredData = boxBlur(state.originalImageData, blurRadius);
  ctx.putImageData(blurredData, 0, 0);
}

// Fast box blur implementation with fractional radius support
function boxBlur(imageData, radius) {
  if (radius <= 0) return imageData;

  const width = imageData.width;
  const height = imageData.height;
  const src = new Uint8ClampedArray(imageData.data);
  const dst = new Uint8ClampedArray(imageData.data.length);

  // For fractional radius, we blend between two integer radii
  const radiusInt = Math.floor(radius);
  const radiusFrac = radius - radiusInt;

  // Apply blur passes (3 passes approximates Gaussian)
  let current = src;
  let next = dst;

  for (let pass = 0; pass < 3; pass++) {
    // Horizontal pass
    boxBlurH(current, next, width, height, radiusInt);
    [current, next] = [next, current];

    // Vertical pass
    boxBlurV(current, next, width, height, radiusInt);
    [current, next] = [next, current];
  }

  // If we have a fractional part, blend with one more pass at radius+1
  if (radiusFrac > 0.01 && radiusInt < 3) {
    const extra = new Uint8ClampedArray(imageData.data.length);
    let extraCurrent = new Uint8ClampedArray(src);
    let extraNext = extra;

    for (let pass = 0; pass < 3; pass++) {
      boxBlurH(extraCurrent, extraNext, width, height, radiusInt + 1);
      [extraCurrent, extraNext] = [extraNext, extraCurrent];
      boxBlurV(extraCurrent, extraNext, width, height, radiusInt + 1);
      [extraCurrent, extraNext] = [extraNext, extraCurrent];
    }

    // Blend between the two results
    for (let i = 0; i < current.length; i++) {
      current[i] = Math.round(current[i] * (1 - radiusFrac) + extraCurrent[i] * radiusFrac);
    }
  }

  return new ImageData(current, width, height);
}

function boxBlurH(src, dst, width, height, radius) {
  const div = radius + radius + 1;
  for (let y = 0; y < height; y++) {
    let rSum = 0, gSum = 0, bSum = 0, aSum = 0;
    const yOffset = y * width * 4;

    // Initialize sum for first pixel
    for (let x = -radius; x <= radius; x++) {
      const idx = yOffset + Math.max(0, Math.min(width - 1, x)) * 4;
      rSum += src[idx];
      gSum += src[idx + 1];
      bSum += src[idx + 2];
      aSum += src[idx + 3];
    }

    for (let x = 0; x < width; x++) {
      const idx = yOffset + x * 4;
      dst[idx] = Math.round(rSum / div);
      dst[idx + 1] = Math.round(gSum / div);
      dst[idx + 2] = Math.round(bSum / div);
      dst[idx + 3] = Math.round(aSum / div);

      // Slide the window
      const leftIdx = yOffset + Math.max(0, x - radius) * 4;
      const rightIdx = yOffset + Math.min(width - 1, x + radius + 1) * 4;
      rSum += src[rightIdx] - src[leftIdx];
      gSum += src[rightIdx + 1] - src[leftIdx + 1];
      bSum += src[rightIdx + 2] - src[leftIdx + 2];
      aSum += src[rightIdx + 3] - src[leftIdx + 3];
    }
  }
}

function boxBlurV(src, dst, width, height, radius) {
  const div = radius + radius + 1;
  for (let x = 0; x < width; x++) {
    let rSum = 0, gSum = 0, bSum = 0, aSum = 0;

    // Initialize sum for first pixel
    for (let y = -radius; y <= radius; y++) {
      const idx = Math.max(0, Math.min(height - 1, y)) * width * 4 + x * 4;
      rSum += src[idx];
      gSum += src[idx + 1];
      bSum += src[idx + 2];
      aSum += src[idx + 3];
    }

    for (let y = 0; y < height; y++) {
      const idx = y * width * 4 + x * 4;
      dst[idx] = Math.round(rSum / div);
      dst[idx + 1] = Math.round(gSum / div);
      dst[idx + 2] = Math.round(bSum / div);
      dst[idx + 3] = Math.round(aSum / div);

      // Slide the window
      const topIdx = Math.max(0, y - radius) * width * 4 + x * 4;
      const bottomIdx = Math.min(height - 1, y + radius + 1) * width * 4 + x * 4;
      rSum += src[bottomIdx] - src[topIdx];
      gSum += src[bottomIdx + 1] - src[topIdx + 1];
      bSum += src[bottomIdx + 2] - src[topIdx + 2];
      aSum += src[bottomIdx + 3] - src[topIdx + 3];
    }
  }
}

// ===== End CRT Simulation =====

// ===== Viewer Resize =====

function setupViewerResize() {
  const viewer = document.querySelector(".viewer");
  const handle = document.querySelector("#viewer-resize-handle");
  if (!viewer || !handle) return;

  let isDragging = false;
  let startY = 0;
  let startHeight = 0;

  handle.addEventListener("mousedown", (e) => {
    isDragging = true;
    startY = e.clientY;
    startHeight = viewer.offsetHeight;
    handle.classList.add("is-dragging");
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!isDragging) return;

    const deltaY = e.clientY - startY;
    const newHeight = Math.max(300, Math.min(1200, startHeight + deltaY));
    viewer.style.setProperty("--viewer-height", `${newHeight}px`);
  });

  window.addEventListener("mouseup", () => {
    if (isDragging) {
      isDragging = false;
      handle.classList.remove("is-dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      saveSettings();
    }
  });
}

function applyViewerHeight(height) {
  const viewer = document.querySelector(".viewer");
  if (viewer && height) {
    viewer.style.setProperty("--viewer-height", `${height}px`);
  }
}

// ===== End Viewer Resize =====

function bindActions() {
  document.querySelector("#open-image").addEventListener("click", openImage);
  document.querySelector("#run-conversion").addEventListener("click", runConversion);
  document.querySelector("#zoom-input").addEventListener("input", () => applyZoom("input"));
  document.querySelector("#zoom-output").addEventListener("input", () => applyZoom("output"));
  setupDrag("input");
  setupDrag("output");
  document.querySelector("#save-image").addEventListener("click", () => {
    console.info("Sauvegarde image non implémentée");
  });
  document.querySelector("#save-binaries").addEventListener("click", exportBinaries);
  document.querySelector("#save-text").addEventListener("click", exportPlainText);

  // Color0 mode change
  document.querySelector("#color0-mode").addEventListener("change", updateColor0Preview);

  // CRT mode change
  document.querySelector("#crt-mode")?.addEventListener("change", (e) => {
    applyCrtMode(e.target.value);
  });

  // CRT blur change
  document.querySelector("#crt-blur")?.addEventListener("input", applyCrtBlur);

  // Background color input change - sync with color0 preview and state
  document.querySelector("#background-color").addEventListener("input", (e) => {
    const color = e.target.value.toUpperCase();
    state.fixedColor0 = color;

    const color0Preview = document.querySelector("#color0-preview");
    if (color0Preview) {
      color0Preview.style.backgroundColor = color;
    }

    // Update all swatches to show selection
    document.querySelectorAll(".palette-swatch").forEach((swatch) => {
      swatch.classList.toggle("is-selected",
        rgbToHex(swatch.style.backgroundColor).toUpperCase() === color
      );
    });
  });

  // Color0 preview click - allow picking from color input
  const color0Preview = document.querySelector("#color0-preview");
  if (color0Preview) {
    color0Preview.addEventListener("click", () => {
      // Create a temporary color input to pick color
      const tempInput = document.createElement("input");
      tempInput.type = "color";
      tempInput.value = state.fixedColor0;
      tempInput.style.position = "absolute";
      tempInput.style.visibility = "hidden";
      document.body.appendChild(tempInput);
      tempInput.addEventListener("input", (e) => {
        selectColor0(e.target.value);
      });
      tempInput.addEventListener("change", () => {
        document.body.removeChild(tempInput);
      });
      tempInput.click();
    });
  }
}

window.addEventListener("DOMContentLoaded", () => {
  // Load saved settings before binding actions
  loadSettings();

  bindActions();
  updateColor0Preview();
  initCurveEditor();

  // Apply CRT mode from loaded settings
  const crtMode = document.querySelector("#crt-mode")?.value;
  if (crtMode) {
    applyCrtMode(crtMode);
  }

  // Redraw curve with loaded settings
  const curveCanvas = document.querySelector("#curve-canvas");
  if (curveCanvas) {
    const ctx = curveCanvas.getContext("2d");
    drawCurve(ctx);
  }

  // Setup viewer resize
  setupViewerResize();

  // Setup auto-save for settings
  setupSettingsAutoSave();
});
