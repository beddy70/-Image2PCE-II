const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const state = {
  inputImage: null,
  outputPreview: null,
  palettes: [],
  tilePaletteMap: [],
  fixedColor0: "#000000",
  isConverting: false,
  hoveredTile: null,
  drag: {
    input: { x: 0, y: 0, isDragging: false, lastX: 0, lastY: 0 },
    output: { x: 0, y: 0, isDragging: false, lastX: 0, lastY: 0 },
  },
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

  showProgress(true);

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
    const conversionResult = await invoke("run_conversion", {
      inputPath: state.inputImage,
      resizeMethod,
      paletteCount,
      ditherMode,
      backgroundColor,
      keepRatio,
    });

    const { preview_base64: previewBase64, palettes, tile_palette_map: tilePaletteMap } = conversionResult;

    // Store in state for tile hover feature
    state.palettes = palettes;
    state.tilePaletteMap = tilePaletteMap;

    const outputCanvas = document.querySelector("#output-canvas");
    outputCanvas.innerHTML = `
      <div class="viewer__stage">
        <img src="data:image/png;base64,${previewBase64}" alt="output" class="viewer__image" />
        <div class="tile-highlight" id="tile-highlight"></div>
      </div>
    `;

    const outputMeta = document.querySelector("#output-meta");
    outputMeta.textContent = `256×256 — resize=${resizeMethod}, keepRatio=${keepRatio}, palettes=${paletteCount}, dithering=${ditherMode}`;

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

  // Count actually used palettes (palettes with tiles that have real colors)
  const usedPaletteCount = palettes.filter((palette, index) => {
    const hasTiles = tilePaletteMap.filter((entry) => entry === index).length > 0;
    const hasRealColors = palette.some((color) => color !== state.fixedColor0 && color !== "#000000");
    return hasTiles && hasRealColors;
  }).length;

  grid.innerHTML = "";
  palettes.forEach((palette, index) => {
    const usageCount = tilePaletteMap.filter((entry) => entry === index).length;
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
  summary.textContent = `${usedPaletteCount} palette(s)`;
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

    // Get palette index for this tile
    const paletteIndex = state.tilePaletteMap[tileIndex];
    if (paletteIndex !== undefined && paletteIndex !== state.hoveredTile) {
      state.hoveredTile = paletteIndex;
      highlightPalette(paletteIndex);
      updatePaletteTooltip(paletteIndex, tileX, tileY);
    }
  });

  outputCanvas.addEventListener("mouseleave", () => {
    tileHighlight.style.display = "none";
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

function updatePaletteTooltip(paletteIndex, tileX, tileY) {
  const tooltip = document.querySelector("#palette-tooltip");
  if (!tooltip) {
    return;
  }

  if (paletteIndex === null) {
    tooltip.innerHTML = "";
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
  document.querySelector("#save-binaries").addEventListener("click", () => {
    console.info("Sauvegarde binaire non implémentée");
  });
  document.querySelector("#save-text").addEventListener("click", () => {
    console.info("Sauvegarde texte non implémentée");
  });

  // Color0 mode change
  document.querySelector("#color0-mode").addEventListener("change", updateColor0Preview);

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
  bindActions();
  updateColor0Preview();
});
