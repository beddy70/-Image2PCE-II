const { invoke, convertFileSrc } = window.__TAURI__.core;

const state = {
  inputImage: null,
  outputPreview: null,
  palettes: [],
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

async function runConversion() {
  if (!state.inputImage) {
    console.warn("Aucune image source sélectionnée.");
    return;
  }

  const resizeMethod = document.querySelector("#resize-method").value;
  const paletteCount = parseInt(
    document.querySelector("#palette-count").value,
    10,
  );
  const ditherMode = document.querySelector("#dither-mode").value;
  const backgroundColor = document.querySelector("#background-color").value;
  const keepRatio = document.querySelector("#keep-ratio").checked;

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
}

function renderPalettes(palettes, tilePaletteMap = []) {
  const grid = document.querySelector("#palettes-grid");
  const summary = document.querySelector("#palette-summary");
  if (!grid || !summary) {
    return;
  }

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
      colors.appendChild(swatch);
    });
    card.appendChild(title);
    card.appendChild(colors);
    grid.appendChild(card);
  });
  summary.textContent = `${palettes.length} palette(s)`;
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
}

window.addEventListener("DOMContentLoaded", () => {
  bindActions();
});
