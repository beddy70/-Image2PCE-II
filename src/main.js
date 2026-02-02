const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const state = {
  inputImage: null,
  outputPreview: null,
  palettes: [],
  fixedColor0: "#000000",
  isConverting: false,
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

    const outputCanvas = document.querySelector("#output-canvas");
    outputCanvas.innerHTML = `
      <div class="viewer__stage">
        <img src="data:image/png;base64,${previewBase64}" alt="output" class="viewer__image" />
      </div>
    `;

    const outputMeta = document.querySelector("#output-meta");
    outputMeta.textContent = `256×256 — resize=${resizeMethod}, keepRatio=${keepRatio}, palettes=${paletteCount}, dithering=${ditherMode}`;

    applyZoom("output");
    renderPalettes(palettes, tilePaletteMap);
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

  // Set mode to fixed
  color0Mode.value = "fixed";
  state.fixedColor0 = color.toUpperCase();

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

  if (color0Mode && color0Preview) {
    const isFixed = color0Mode.value === "fixed";
    color0Preview.classList.toggle("is-visible", isFixed);
    if (isFixed) {
      color0Preview.style.backgroundColor = state.fixedColor0;
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
});
