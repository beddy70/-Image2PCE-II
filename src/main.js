const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const state = {
  inputImage: null,
  inputFilename: null,      // Just the filename (without path)
  inputWidth: 0,            // Original source image width
  inputHeight: 0,           // Original source image height
  outputPreview: null,
  outputImageBase64: null,
  originalImageData: null, // Store original ImageData for blur processing
  palettes: [],
  tilePaletteMap: [],
  emptyTiles: [],
  fixedColor0: "#000000",
  isConverting: false,
  hoveredTile: null,
  hoveredTileIndex: null,
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
  // Dither mask editor state
  mask: {
    canvas: null,
    ctx: null,
    width: 0,
    height: 0,
    isEditing: false,
    isDrawing: false,
    tool: "brush", // "brush", "eraser", "circle", "rectangle", "polygon"
    brushSize: 20,
    // Shape drawing state
    shapeStart: null, // { x, y } start point for shapes
    previewCanvas: null, // temporary canvas for shape preview
    shapeFillMode: "black", // "black" (dithering) or "white" (no dithering)
    // Polygon drawing state
    polygonPoints: [], // array of {x, y} points
    // Undo/redo history
    history: [],
    historyIndex: -1,
    maxHistory: 50,
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
  // Tile pixel editor state
  tileEditor: {
    isEditing: false,           // Mode édition actif
    isDrawing: false,           // En train de dessiner
    tool: "brush",              // "brush" ou "select"
    selectedColor: null,        // Couleur sélectionnée (hex)
    activePaletteIndex: null,   // Palette de la tuile en cours d'édition
    lockedTiles: [],            // Booléens des tuiles verrouillées
    history: [],                // Historique undo/redo (ImageData)
    historyIndex: -1,
    maxHistory: 50,
    lastPixel: null,            // Évite les dessins redondants
    contextMenuTileIndex: null, // Tuile sous le clic droit pour le menu contextuel
  },
  // Palette groups editor state
  paletteGroups: {
    canvas: null,
    ctx: null,
    isEditing: false,
    isDrawing: false,
    tool: "brush",           // "brush" | "eraser"
    brushSize: 1,            // en tuiles virtuelles (1-5)
    selectedGroup: 0,        // groupe actif (0-15)
    gridWidth: 0,            // nombre de colonnes
    gridHeight: 0,           // nombre de lignes
    virtualTileWidth: 0,     // pixels par tuile virtuelle (horizontal)
    virtualTileHeight: 0,    // pixels par tuile virtuelle (vertical)
    assignments: [],         // [y][x] = groupe (0-15) ou null
    history: [],
    historyIndex: -1,
    maxHistory: 50,
  },
  // Project state tracking
  projectDirty: false,
  projectPath: null,        // Path of the loaded project file
  isLoadingProject: false,  // Flag to suppress dirty marking during load
  // Seed for deterministic dithering
  seed: Date.now() % Number.MAX_SAFE_INTEGER,
};

// Palette group colors for visualization
const PALETTE_GROUP_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
  '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
  '#BB8FCE', '#85C1E9', '#F8B500', '#58D68D',
  '#EC7063', '#5DADE2', '#AF7AC5', '#45B39D'
];

// Convert hex color to RGB333 (3 bits per channel, values 0-7)
function hexToRGB333(hex) {
  const r8 = parseInt(hex.slice(1, 3), 16);
  const g8 = parseInt(hex.slice(3, 5), 16);
  const b8 = parseInt(hex.slice(5, 7), 16);
  return {
    r: Math.round(r8 / 255 * 7),
    g: Math.round(g8 / 255 * 7),
    b: Math.round(b8 / 255 * 7)
  };
}

async function openImage() {
  const selected = await invoke("open_image");
  if (!selected) {
    return;
  }

  // Mark project as dirty when a new image is loaded
  markProjectDirty();

  // Close mask editor if open
  toggleMaskEditing(false);

  state.inputImage = selected;
  const inputMeta = document.querySelector("#input-meta");
  const inputCanvas = document.querySelector("#input-canvas");
  const fileUrl = convertFileSrc(selected);
  inputCanvas.innerHTML = `
    <div class="viewer__stage">
      <div class="viewer__image-wrapper">
        <img src="${fileUrl}" alt="source" class="viewer__image" id="source-image" draggable="false" />
        <canvas id="mask-canvas" class="mask-canvas"></canvas>
      </div>
    </div>
    <div id="brush-cursor" class="brush-cursor"></div>
  `;

  // Wait for image to load to get dimensions for mask and palette groups
  const sourceImg = document.querySelector("#source-image");
  sourceImg.onload = () => {
    // Extract filename from path and store in state
    const filename = selected.split(/[\\/]/).pop();
    const w = sourceImg.naturalWidth;
    const h = sourceImg.naturalHeight;
    state.inputFilename = filename;
    state.inputWidth = w;
    state.inputHeight = h;
    inputMeta.textContent = `${filename} (${w}×${h})`;

    initMaskCanvas(w, h);
    initPaletteGroupsCanvas();
  };

  applyZoom("input");
}

/**
 * Update size constraints based on BAT size selection
 * Ensures image dimensions + offsets don't exceed BAT dimensions
 */
function updateSizeConstraints() {
  const batSizeEl = document.querySelector("#bat-size");
  const widthSlider = document.querySelector("#output-width-tiles");
  const heightSlider = document.querySelector("#output-height-tiles");
  const offsetXEl = document.querySelector("#offset-x");
  const offsetYEl = document.querySelector("#offset-y");

  if (!batSizeEl || !widthSlider || !heightSlider || !offsetXEl || !offsetYEl) return;

  const batSize = batSizeEl.value;
  const [batW, batH] = batSize.split("x").map(Number);

  // Update slider max values based on BAT size
  widthSlider.max = batW;
  heightSlider.max = batH;

  // Clamp current values if they exceed new max
  let imgW = parseInt(widthSlider.value, 10);
  let imgH = parseInt(heightSlider.value, 10);

  if (imgW > batW) {
    imgW = batW;
    widthSlider.value = imgW;
  }
  if (imgH > batH) {
    imgH = batH;
    heightSlider.value = imgH;
  }

  // Update display text
  document.querySelector("#output-width-value").textContent = `${imgW} (${imgW * 8} px)`;
  document.querySelector("#output-height-value").textContent = `${imgH} (${imgH * 8} px)`;

  // Update offset max values (image + offset must fit in BAT)
  const maxOffsetX = batW - imgW;
  const maxOffsetY = batH - imgH;

  offsetXEl.max = maxOffsetX;
  offsetYEl.max = maxOffsetY;

  // Clamp offset values if they exceed new max
  if (parseInt(offsetXEl.value, 10) > maxOffsetX) {
    offsetXEl.value = maxOffsetX;
  }
  if (parseInt(offsetYEl.value, 10) > maxOffsetY) {
    offsetYEl.value = maxOffsetY;
  }

  // Reinitialize palette groups canvas if source image is loaded
  if (state.inputImage) {
    initPaletteGroupsCanvas();
  }
}

function initMaskCanvas(width, height) {
  const maskCanvas = document.querySelector("#mask-canvas");
  if (!maskCanvas) return;

  maskCanvas.width = width;
  maskCanvas.height = height;

  state.mask.canvas = maskCanvas;
  state.mask.ctx = maskCanvas.getContext("2d");
  state.mask.width = width;
  state.mask.height = height;

  // Initialize mask as white (no dithering by default)
  state.mask.ctx.fillStyle = "#FFFFFF";
  state.mask.ctx.fillRect(0, 0, width, height);

  // Reset history and save initial state
  state.mask.history = [];
  state.mask.historyIndex = -1;
  saveMaskState();

  // Setup mask drawing events
  setupMaskDrawing();
}

function saveMaskState() {
  const ctx = state.mask.ctx;
  if (!ctx || !state.mask.width || !state.mask.height) return;

  // Mark project as dirty when mask changes
  markProjectDirty();

  // Remove any redo states
  if (state.mask.historyIndex < state.mask.history.length - 1) {
    state.mask.history = state.mask.history.slice(0, state.mask.historyIndex + 1);
  }

  // Save current state
  const imageData = ctx.getImageData(0, 0, state.mask.width, state.mask.height);
  state.mask.history.push(imageData);

  // Limit history size
  if (state.mask.history.length > state.mask.maxHistory) {
    state.mask.history.shift();
  } else {
    state.mask.historyIndex++;
  }
}

function undoMask() {
  if (state.mask.historyIndex <= 0) return;

  state.mask.historyIndex--;
  const imageData = state.mask.history[state.mask.historyIndex];
  if (imageData && state.mask.ctx) {
    state.mask.ctx.putImageData(imageData, 0, 0);
  }
}

function redoMask() {
  if (state.mask.historyIndex >= state.mask.history.length - 1) return;

  state.mask.historyIndex++;
  const imageData = state.mask.history[state.mask.historyIndex];
  if (imageData && state.mask.ctx) {
    state.mask.ctx.putImageData(imageData, 0, 0);
  }
}

function setupMaskDrawing() {
  const maskCanvas = state.mask.canvas;
  if (!maskCanvas) return;

  const inputCanvas = document.querySelector("#input-canvas");

  // Drawing on mask canvas
  maskCanvas.addEventListener("mousedown", startMaskDraw);
  maskCanvas.addEventListener("mousemove", (e) => {
    updateBrushCursor(e);
    drawOnMask(e);
    // Update polygon preview while moving
    if (state.mask.tool === "polygon" && state.mask.polygonPoints.length > 0) {
      drawPolygonPreview(e);
    }
  });
  maskCanvas.addEventListener("mouseup", (e) => stopMaskDraw(e));
  maskCanvas.addEventListener("dblclick", handlePolygonDoubleClick);
  maskCanvas.addEventListener("mouseleave", (e) => {
    // For brush/eraser, stop drawing on leave
    // For shapes, keep drawing state but hide cursor
    if (state.mask.tool === "brush" || state.mask.tool === "eraser") {
      stopMaskDraw(e);
    }
    hideBrushCursor();
  });
  maskCanvas.addEventListener("mouseenter", () => {
    if (state.mask.isEditing) {
      showBrushCursor();
    }
  });

  // Prevent native drag & drop
  maskCanvas.addEventListener("dragstart", (e) => e.preventDefault());

  // Right-click cancels polygon
  maskCanvas.addEventListener("contextmenu", (e) => {
    if (state.mask.tool === "polygon" && state.mask.polygonPoints.length > 0) {
      e.preventDefault();
      cancelPolygon();
    }
  });

  // Document-level mouseup for shape tools (when releasing outside canvas)
  document.addEventListener("mouseup", (e) => {
    if (state.mask.isDrawing && (state.mask.tool === "circle" || state.mask.tool === "rectangle")) {
      stopMaskDraw(e);
    }
  });

  // Escape key cancels polygon
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.mask.tool === "polygon" && state.mask.polygonPoints.length > 0) {
      cancelPolygon();
    }
  });

  // Also track mouse on the whole input canvas for brush cursor
  if (inputCanvas) {
    inputCanvas.addEventListener("mousemove", (e) => {
      if (state.mask.isEditing) {
        updateBrushCursor(e);
        // For shape tools, update preview even outside mask canvas
        if (state.mask.isDrawing && (state.mask.tool === "circle" || state.mask.tool === "rectangle")) {
          drawOnMask(e);
        }
        // Update polygon preview
        if (state.mask.tool === "polygon" && state.mask.polygonPoints.length > 0) {
          drawPolygonPreview(e);
        }
      }
    });
    inputCanvas.addEventListener("mouseleave", hideBrushCursor);
  }
}

function startMaskDraw(event) {
  if (!state.mask.isEditing) return;
  event.preventDefault(); // Prevent text selection and native drag

  const tool = state.mask.tool;

  if (tool === "polygon") {
    // Polygon uses click-to-add-point, not drag
    handlePolygonClick(event);
    return;
  }

  state.mask.isDrawing = true;

  if (tool === "circle" || tool === "rectangle") {
    // Store start point for shape drawing
    const maskCanvas = state.mask.canvas;
    const canvasRect = maskCanvas.getBoundingClientRect();
    const scaleX = maskCanvas.width / canvasRect.width;
    const scaleY = maskCanvas.height / canvasRect.height;
    state.mask.shapeStart = {
      x: (event.clientX - canvasRect.left) * scaleX,
      y: (event.clientY - canvasRect.top) * scaleY,
    };
    // Create preview canvas
    createShapePreviewCanvas();
  } else {
    drawOnMask(event);
  }
}

function stopMaskDraw(event) {
  if (state.mask.isDrawing) {
    const tool = state.mask.tool;
    if ((tool === "circle" || tool === "rectangle") && state.mask.shapeStart && event) {
      // Finalize shape on mask
      finalizeShape(event);
    }
    state.mask.isDrawing = false;
    state.mask.shapeStart = null;
    removeShapePreviewCanvas();
    // Save state after drawing stroke is complete
    saveMaskState();
  }
}

function createShapePreviewCanvas() {
  // Create a temporary canvas for shape preview
  const maskCanvas = state.mask.canvas;
  if (!maskCanvas) return;

  const wrapper = maskCanvas.parentElement;
  let preview = wrapper.querySelector(".mask-preview-canvas");
  if (!preview) {
    preview = document.createElement("canvas");
    preview.className = "mask-preview-canvas";
    preview.width = maskCanvas.width;
    preview.height = maskCanvas.height;
    preview.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 15;
    `;
    wrapper.appendChild(preview);
  }
  state.mask.previewCanvas = preview;
}

function removeShapePreviewCanvas() {
  if (state.mask.previewCanvas) {
    state.mask.previewCanvas.remove();
    state.mask.previewCanvas = null;
  }
}

function finalizeShape(event) {
  const maskCanvas = state.mask.canvas;
  const ctx = state.mask.ctx;
  const canvasRect = maskCanvas.getBoundingClientRect();
  const scaleX = maskCanvas.width / canvasRect.width;
  const scaleY = maskCanvas.height / canvasRect.height;

  const startX = state.mask.shapeStart.x;
  const startY = state.mask.shapeStart.y;
  const endX = (event.clientX - canvasRect.left) * scaleX;
  const endY = (event.clientY - canvasRect.top) * scaleY;

  // Determine fill color based on shapeFillMode (Shift toggles temporarily)
  const baseIsWhite = state.mask.shapeFillMode === "white";
  const useWhite = event.shiftKey ? !baseIsWhite : baseIsWhite;
  const fillColor = useWhite ? "#FFFFFF" : "#000000";

  ctx.fillStyle = fillColor;

  if (state.mask.tool === "circle") {
    const radiusX = Math.abs(endX - startX);
    const radiusY = Math.abs(endY - startY);
    const radius = Math.max(radiusX, radiusY);
    ctx.beginPath();
    ctx.arc(startX, startY, radius, 0, Math.PI * 2);
    ctx.fill();
  } else if (state.mask.tool === "rectangle") {
    const x = Math.min(startX, endX);
    const y = Math.min(startY, endY);
    const width = Math.abs(endX - startX);
    const height = Math.abs(endY - startY);
    ctx.fillRect(x, y, width, height);
  }
}

// Polygon tool functions
function handlePolygonClick(event) {
  const maskCanvas = state.mask.canvas;
  const canvasRect = maskCanvas.getBoundingClientRect();
  const scaleX = maskCanvas.width / canvasRect.width;
  const scaleY = maskCanvas.height / canvasRect.height;

  const x = (event.clientX - canvasRect.left) * scaleX;
  const y = (event.clientY - canvasRect.top) * scaleY;

  // Check if clicking near the first point to close polygon
  if (state.mask.polygonPoints.length >= 3) {
    const firstPoint = state.mask.polygonPoints[0];
    const distance = Math.sqrt((x - firstPoint.x) ** 2 + (y - firstPoint.y) ** 2);
    const closeThreshold = 15; // pixels in canvas coords

    if (distance < closeThreshold) {
      finalizePolygon(event);
      return;
    }
  }

  // Add point to polygon
  state.mask.polygonPoints.push({ x, y });

  // Create preview canvas if first point
  if (state.mask.polygonPoints.length === 1) {
    createShapePreviewCanvas();
  }

  // Update preview
  drawPolygonPreview(event);
}

function handlePolygonDoubleClick(event) {
  if (state.mask.tool !== "polygon" || state.mask.polygonPoints.length < 3) return;
  finalizePolygon(event);
}

function finalizePolygon(event) {
  const points = state.mask.polygonPoints;
  if (points.length < 3) {
    cancelPolygon();
    return;
  }

  const ctx = state.mask.ctx;

  // Determine fill color
  const baseIsWhite = state.mask.shapeFillMode === "white";
  const useWhite = event?.shiftKey ? !baseIsWhite : baseIsWhite;
  const fillColor = useWhite ? "#FFFFFF" : "#000000";

  ctx.fillStyle = fillColor;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.closePath();
  ctx.fill();

  // Clean up
  state.mask.polygonPoints = [];
  removeShapePreviewCanvas();
  saveMaskState();
}

function cancelPolygon() {
  state.mask.polygonPoints = [];
  removeShapePreviewCanvas();
}

function drawPolygonPreview(event) {
  const preview = state.mask.previewCanvas;
  if (!preview) return;

  const ctx = preview.getContext("2d");
  const points = state.mask.polygonPoints;

  // Clear preview
  ctx.clearRect(0, 0, preview.width, preview.height);

  if (points.length === 0) return;

  // Get current mouse position for rubber band line
  const maskCanvas = state.mask.canvas;
  const canvasRect = maskCanvas.getBoundingClientRect();
  const scaleX = maskCanvas.width / canvasRect.width;
  const scaleY = maskCanvas.height / canvasRect.height;
  const mouseX = (event.clientX - canvasRect.left) * scaleX;
  const mouseY = (event.clientY - canvasRect.top) * scaleY;

  // Determine colors
  const baseIsWhite = state.mask.shapeFillMode === "white";
  const useWhite = event?.shiftKey ? !baseIsWhite : baseIsWhite;
  const fillColor = useWhite ? "rgba(255, 255, 255, 0.3)" : "rgba(0, 0, 0, 0.3)";
  const strokeColor = useWhite ? "#FFFFFF" : "#000000";

  // Draw filled polygon preview
  if (points.length >= 2) {
    ctx.fillStyle = fillColor;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.lineTo(mouseX, mouseY);
    ctx.closePath();
    ctx.fill();
  }

  // Draw outline
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.lineTo(mouseX, mouseY);
  ctx.stroke();

  // Draw points
  ctx.fillStyle = strokeColor;
  for (const point of points) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Highlight first point if we can close
  if (points.length >= 3) {
    const firstPoint = points[0];
    const distance = Math.sqrt((mouseX - firstPoint.x) ** 2 + (mouseY - firstPoint.y) ** 2);
    if (distance < 15) {
      ctx.strokeStyle = "#00FF00";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(firstPoint.x, firstPoint.y, 8, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function updateBrushCursor(event) {
  const brushCursor = document.querySelector("#brush-cursor");
  if (!brushCursor || !state.mask.isEditing) return;

  // Hide cursor for shape tools
  if (state.mask.tool === "circle" || state.mask.tool === "rectangle" || state.mask.tool === "polygon") {
    brushCursor.style.display = "none";
    return;
  }

  const inputCanvas = document.querySelector("#input-canvas");
  const maskCanvas = state.mask.canvas;
  if (!inputCanvas || !maskCanvas) return;

  const inputRect = inputCanvas.getBoundingClientRect();
  const canvasRect = maskCanvas.getBoundingClientRect();

  // Calculate scale between internal resolution and displayed size
  const scale = canvasRect.width / maskCanvas.width;

  // Size of brush cursor in screen pixels
  const size = state.mask.brushSize * scale;

  // Position relative to input canvas container
  const x = event.clientX - inputRect.left;
  const y = event.clientY - inputRect.top;

  brushCursor.style.width = `${size}px`;
  brushCursor.style.height = `${size}px`;
  brushCursor.style.left = `${x - size / 2}px`;
  brushCursor.style.top = `${y - size / 2}px`;
  brushCursor.style.display = "block";
}

function showBrushCursor() {
  const brushCursor = document.querySelector("#brush-cursor");
  if (brushCursor) {
    brushCursor.style.display = "block";
  }
}

function hideBrushCursor() {
  const brushCursor = document.querySelector("#brush-cursor");
  if (brushCursor) {
    brushCursor.style.display = "none";
  }
}

function drawOnMask(event) {
  if (!state.mask.isDrawing || !state.mask.isEditing) return;

  const tool = state.mask.tool;
  const maskCanvas = state.mask.canvas;
  const canvasRect = maskCanvas.getBoundingClientRect();

  // Calculate scale between displayed size and internal resolution
  const scaleX = maskCanvas.width / canvasRect.width;
  const scaleY = maskCanvas.height / canvasRect.height;

  // Mouse position relative to canvas, converted to internal coordinates
  const x = (event.clientX - canvasRect.left) * scaleX;
  const y = (event.clientY - canvasRect.top) * scaleY;

  if (tool === "brush" || tool === "eraser") {
    // Brush/eraser drawing
    const ctx = state.mask.ctx;
    const brushRadius = state.mask.brushSize / 2;
    ctx.beginPath();
    ctx.arc(x, y, brushRadius, 0, Math.PI * 2);
    ctx.fillStyle = tool === "brush" ? "#000000" : "#FFFFFF";
    ctx.fill();
  } else if ((tool === "circle" || tool === "rectangle") && state.mask.shapeStart && state.mask.previewCanvas) {
    // Shape preview drawing
    drawShapePreview(event);
  }
}

function drawShapePreview(event) {
  const preview = state.mask.previewCanvas;
  if (!preview) return;

  const ctx = preview.getContext("2d");
  const maskCanvas = state.mask.canvas;
  const canvasRect = maskCanvas.getBoundingClientRect();
  const scaleX = maskCanvas.width / canvasRect.width;
  const scaleY = maskCanvas.height / canvasRect.height;

  const startX = state.mask.shapeStart.x;
  const startY = state.mask.shapeStart.y;
  const endX = (event.clientX - canvasRect.left) * scaleX;
  const endY = (event.clientY - canvasRect.top) * scaleY;

  // Clear preview
  ctx.clearRect(0, 0, preview.width, preview.height);

  // Determine fill color based on shapeFillMode (Shift toggles temporarily)
  const baseIsWhite = state.mask.shapeFillMode === "white";
  const useWhite = event.shiftKey ? !baseIsWhite : baseIsWhite;
  const fillColor = useWhite ? "rgba(255, 255, 255, 0.5)" : "rgba(0, 0, 0, 0.5)";
  const strokeColor = useWhite ? "#FFFFFF" : "#000000";

  ctx.fillStyle = fillColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 2;

  if (state.mask.tool === "circle") {
    const radiusX = Math.abs(endX - startX);
    const radiusY = Math.abs(endY - startY);
    const radius = Math.max(radiusX, radiusY);
    ctx.beginPath();
    ctx.arc(startX, startY, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else if (state.mask.tool === "rectangle") {
    const rectX = Math.min(startX, endX);
    const rectY = Math.min(startY, endY);
    const width = Math.abs(endX - startX);
    const height = Math.abs(endY - startY);
    ctx.fillRect(rectX, rectY, width, height);
    ctx.strokeRect(rectX, rectY, width, height);
  }
}

function toggleMaskEditing(enabled) {
  state.mask.isEditing = enabled;
  const maskCanvas = document.querySelector("#mask-canvas");
  const maskTools = document.querySelector("#mask-tools");
  const toggleBtn = document.querySelector("#mask-toggle");

  if (maskCanvas) {
    maskCanvas.classList.toggle("is-editing", enabled);
    maskCanvas.classList.toggle("is-visible", enabled);
  }
  if (maskTools) {
    maskTools.classList.toggle("is-visible", enabled);
  }
  if (toggleBtn) {
    toggleBtn.classList.toggle("is-active", enabled);
  }

  // Hide brush cursor when disabling editing
  if (!enabled) {
    hideBrushCursor();
  }
}

function setMaskTool(tool) {
  // Cancel any ongoing polygon when switching tools
  if (state.mask.tool === "polygon" && tool !== "polygon") {
    cancelPolygon();
  }

  state.mask.tool = tool;
  document.querySelector("#mask-brush")?.classList.toggle("is-active", tool === "brush");
  document.querySelector("#mask-eraser")?.classList.toggle("is-active", tool === "eraser");
  document.querySelector("#mask-circle")?.classList.toggle("is-active", tool === "circle");
  document.querySelector("#mask-rectangle")?.classList.toggle("is-active", tool === "rectangle");
  document.querySelector("#mask-polygon")?.classList.toggle("is-active", tool === "polygon");

  // Add crosshair cursor class for shape tools
  const maskCanvas = document.querySelector("#mask-canvas");
  if (maskCanvas) {
    const isShapeTool = tool === "circle" || tool === "rectangle" || tool === "polygon";
    maskCanvas.classList.toggle("shape-tool", isShapeTool);
  }

  // Update shape fill mode indicator
  updateShapeFillModeIndicator();
}

function toggleShapeFillMode() {
  state.mask.shapeFillMode = state.mask.shapeFillMode === "black" ? "white" : "black";
  updateShapeFillModeIndicator();
}

function updateShapeFillModeIndicator() {
  const circleBtn = document.querySelector("#mask-circle");
  const rectBtn = document.querySelector("#mask-rectangle");
  const polygonBtn = document.querySelector("#mask-polygon");
  const isWhite = state.mask.shapeFillMode === "white";

  // Add visual indicator for erase mode
  circleBtn?.classList.toggle("erase-mode", isWhite);
  rectBtn?.classList.toggle("erase-mode", isWhite);
  polygonBtn?.classList.toggle("erase-mode", isWhite);
}

function clearMask(color) {
  const ctx = state.mask.ctx;
  if (!ctx) return;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, state.mask.width, state.mask.height);
}

function invertMask() {
  const ctx = state.mask.ctx;
  if (!ctx || !state.mask.width || !state.mask.height) return;

  const imageData = ctx.getImageData(0, 0, state.mask.width, state.mask.height);
  const data = imageData.data;

  // Invert each pixel (black <-> white)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255 - data[i];       // R
    data[i + 1] = 255 - data[i + 1]; // G
    data[i + 2] = 255 - data[i + 2]; // B
    // Alpha stays the same
  }

  ctx.putImageData(imageData, 0, 0);
}

function getMaskData() {
  if (!state.mask.ctx || !state.mask.width || !state.mask.height) {
    return null;
  }
  const imageData = state.mask.ctx.getImageData(0, 0, state.mask.width, state.mask.height);
  // Convert to binary array (0 or 255 for each pixel)
  const maskData = new Uint8Array(state.mask.width * state.mask.height);
  for (let i = 0; i < maskData.length; i++) {
    // Use red channel to determine mask value (black = 0, white = 255)
    maskData[i] = imageData.data[i * 4] < 128 ? 0 : 255;
  }
  return Array.from(maskData);
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

  // Reset tile editor state for new conversion
  resetTileEditorState();

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

  // Get output dimensions from tile sliders
  const widthTiles = parseInt(document.querySelector("#output-width-tiles").value, 10);
  const heightTiles = parseInt(document.querySelector("#output-height-tiles").value, 10);
  const targetWidth = widthTiles * 8;
  const targetHeight = heightTiles * 8;

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

    // Get dither mask data if enabled
    const useDitherMask = document.querySelector("#dither-mask")?.checked || false;
    const maskData = useDitherMask ? getMaskData() : null;

    // Get palette group constraints
    const paletteGroupConstraints = getPaletteGroupConstraints();

    const conversionResult = await invoke("run_conversion", {
      inputPath: state.inputImage,
      resizeMethod,
      paletteCount,
      ditherMode,
      backgroundColor,
      keepRatio,
      curveLut,
      targetWidth,
      targetHeight,
      useDitherMask: useDitherMask && maskData !== null,
      ditherMask: maskData || [],
      maskWidth: state.mask.width || 0,
      maskHeight: state.mask.height || 0,
      paletteGroupConstraints,
      seed: state.seed,
    });

    const {
      preview_base64: previewBase64,
      palettes,
      tile_palette_map: tilePaletteMap,
      empty_tiles: emptyTiles,
      tile_count: tileCount,
      unique_tile_count: uniqueTileCount,
      tile_to_unique: tileToUnique,
      was_pre_resized: wasPreResized,
    } = conversionResult;

    // Update input meta to show pre-resize info if applicable
    const inputMeta = document.querySelector("#input-meta");
    if (wasPreResized) {
      const preResizeSize = `${targetWidth * 2}×${targetHeight * 2}`;
      inputMeta.textContent = `${state.inputFilename} (${state.inputWidth}×${state.inputHeight}) → ${preResizeSize}`;
    } else {
      inputMeta.textContent = `${state.inputFilename} (${state.inputWidth}×${state.inputHeight})`;
    }

    // Store in state for tile hover feature and export
    state.palettes = palettes;
    state.tilePaletteMap = tilePaletteMap;
    state.emptyTiles = emptyTiles;
    state.tileToUnique = tileToUnique;
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
        <div class="viewer__image-wrapper">
          <canvas id="output-image-canvas" class="viewer__image" width="${targetWidth}" height="${targetHeight}"></canvas>
          <canvas id="tile-lock-overlay" class="tile-lock-overlay" width="${targetWidth}" height="${targetHeight}"></canvas>
        </div>
        <div class="tile-highlight" id="tile-highlight"></div>
      </div>
      <canvas class="tile-zoom" id="tile-zoom" width="80" height="80"></canvas>
    `;

    // Store output dimensions in state for tile hover
    state.outputWidth = targetWidth;
    state.outputHeight = targetHeight;

    // Load image into canvas and store original data
    const img = new Image();
    img.onload = () => {
      const canvas = document.querySelector("#output-image-canvas");
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0);
      state.originalImageData = ctx.getImageData(0, 0, targetWidth, targetHeight);

      // Apply current blur setting
      applyCrtBlur();

      // Update histogram
      drawHistogram();
    };
    img.src = `data:image/png;base64,${previewBase64}`;

    // Calculate VRAM usage
    const totalVram = tilesBytes + batBytes;
    const vramKb = (totalVram / 1024).toFixed(1);
    const vramExceeded = totalVram > 65536;

    const outputMeta = document.querySelector("#output-meta");
    outputMeta.innerHTML = `${tileCount} tuiles (${uniqueTileCount} uniques, ${duplicates} doublons)<br>` +
      `<span class="${vramExceeded ? 'vram-exceeded' : ''}">VRAM: ${vramKb} Ko (BAT: ${batBytes} + Tuiles: ${tilesBytes})${vramExceeded ? ' — capacité VRAM dépassée' : ''}</span>`;

    // Update VRAM gauge
    updateVramGauge(batBytes, tilesBytes);

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
      // Convert hex to RGB333 for tooltip
      const rgb333 = hexToRGB333(color);
      swatch.title = `R:${rgb333.r} G:${rgb333.g} B:${rgb333.b} (${color})`;
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

/**
 * Update the VRAM memory map with BAT and tiles positions
 * @param {number} batBytes - BAT size in bytes
 * @param {number} tilesBytes - Tiles size in bytes
 */
function updateVramGauge(batBytes, tilesBytes) {
  const VRAM_SIZE = 65536; // 64 KB = $10000

  // Parse VRAM address for tiles (default $4000)
  const vramInput = document.querySelector("#vram-address");
  let tilesStart = 0x4000;
  if (vramInput) {
    const val = vramInput.value.trim().replace(/^\$/, "");
    const parsed = parseInt(val, 16);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 0xFFFF) {
      tilesStart = parsed;
    }
  }

  // BAT always starts at $0000
  const batStart = 0;
  const batEnd = batStart + batBytes;
  const tilesEnd = tilesStart + tilesBytes;

  // Calculate percentages for positioning
  const batStartPercent = (batStart / VRAM_SIZE) * 100;
  const batWidthPercent = (batBytes / VRAM_SIZE) * 100;
  const tilesStartPercent = (tilesStart / VRAM_SIZE) * 100;
  const tilesWidthPercent = (tilesBytes / VRAM_SIZE) * 100;

  // Detect overlap: BAT ends after tiles start, and tiles start before BAT ends
  const hasOverlap = batEnd > tilesStart && tilesStart < batEnd;
  const overlapStart = hasOverlap ? tilesStart : 0;
  const overlapEnd = hasOverlap ? Math.min(batEnd, tilesEnd) : 0;
  const overlapBytes = overlapEnd - overlapStart;

  // Calculate total usage (accounting for overlap)
  const totalUsed = hasOverlap
    ? Math.max(batEnd, tilesEnd)
    : batBytes + tilesBytes;
  const totalPercent = (totalUsed / VRAM_SIZE) * 100;

  // Format address for display
  const formatAddr = (addr) => "$" + addr.toString(16).toUpperCase().padStart(4, "0");
  const formatBytes = (bytes) => {
    if (bytes >= 1024) {
      return (bytes / 1024).toFixed(1) + " Ko";
    }
    return bytes + " o";
  };

  // Update BAT block
  const batBlock = document.querySelector("#vram-bat");
  if (batBlock) {
    batBlock.style.left = `${batStartPercent}%`;
    batBlock.style.width = `${batWidthPercent}%`;
    batBlock.title = `BAT: ${formatAddr(batStart)} - ${formatAddr(batEnd)} (${formatBytes(batBytes)})`;
    batBlock.textContent = batWidthPercent > 8 ? "BAT" : "";
  }

  // Update Tiles block
  const tilesBlock = document.querySelector("#vram-tiles");
  if (tilesBlock) {
    tilesBlock.style.left = `${tilesStartPercent}%`;
    tilesBlock.style.width = `${tilesWidthPercent}%`;
    tilesBlock.title = `Tuiles: ${formatAddr(tilesStart)} - ${formatAddr(tilesEnd)} (${formatBytes(tilesBytes)})`;
    tilesBlock.textContent = tilesWidthPercent > 8 ? "Tiles" : "";
  }

  // Update overlap indicator
  const overlapBlock = document.querySelector("#vram-overlap");
  const mapBar = document.querySelector("#vram-bar");
  if (overlapBlock && mapBar) {
    if (hasOverlap) {
      const overlapStartPercent = (overlapStart / VRAM_SIZE) * 100;
      const overlapWidthPercent = (overlapBytes / VRAM_SIZE) * 100;
      overlapBlock.style.left = `${overlapStartPercent}%`;
      overlapBlock.style.width = `${overlapWidthPercent}%`;
      overlapBlock.classList.add("is-visible");
      mapBar.classList.add("has-overlap");
    } else {
      overlapBlock.classList.remove("is-visible");
      mapBar.classList.remove("has-overlap");
    }
  }

  // Update text values
  const usageEl = document.querySelector("#vram-usage");
  const batInfoEl = document.querySelector("#vram-bat-info");
  const tilesInfoEl = document.querySelector("#vram-tiles-info");

  if (usageEl) usageEl.textContent = `${Math.round(totalPercent)}%`;
  if (batInfoEl) batInfoEl.textContent = `${formatAddr(batStart)}-${formatAddr(batEnd)} (${formatBytes(batBytes)})`;
  if (tilesInfoEl) tilesInfoEl.textContent = `${formatAddr(tilesStart)}-${formatAddr(tilesEnd)} (${formatBytes(tilesBytes)})`;

  // Update alert
  const alertEl = document.querySelector("#vram-alert");
  if (alertEl) {
    if (hasOverlap) {
      alertEl.textContent = `Chevauchement BAT/Tuiles: ${formatBytes(overlapBytes)} (${formatAddr(overlapStart)}-${formatAddr(overlapEnd)})`;
      alertEl.classList.add("is-visible");
    } else if (tilesEnd > VRAM_SIZE) {
      alertEl.textContent = `Dépassement VRAM: les tuiles débordent de ${formatBytes(tilesEnd - VRAM_SIZE)}`;
      alertEl.classList.add("is-visible");
    } else {
      alertEl.classList.remove("is-visible");
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
  // Prevent native text selection during drag
  canvas.addEventListener("selectstart", (event) => {
    event.preventDefault();
  });

  canvas.addEventListener("mousedown", (event) => {
    // Don't start drag if mask editing is active on input canvas, unless Shift is held
    if (target === "input" && state.mask.isEditing && !event.shiftKey) {
      return;
    }
    // Don't start drag if palette groups editing is active on input canvas, unless Shift is held
    if (target === "input" && state.paletteGroups.isEditing && !event.shiftKey) {
      return;
    }
    // Don't start drag if tile editing is active on output canvas, unless Shift is held
    if (target === "output" && state.tileEditor.isEditing && !event.shiftKey) {
      return;
    }
    event.preventDefault(); // Prevent text selection
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

  // Mouse wheel zoom
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const slider = document.querySelector(`#zoom-${target}`);
    if (!slider) return;

    const currentZoom = Number(slider.value);
    const delta = event.deltaY > 0 ? -1 : 1;
    const newZoom = Math.max(1, Math.min(8, currentZoom + delta));

    if (newZoom !== currentZoom) {
      slider.value = newZoom;
      applyZoom(target);
      saveSettings();
    }
  }, { passive: false });
}

function setupTileHover() {
  const outputCanvas = document.querySelector("#output-canvas");
  const tileHighlight = document.querySelector("#tile-highlight");
  const tileZoom = document.querySelector("#tile-zoom");

  if (!outputCanvas || !tileHighlight) {
    return;
  }

  outputCanvas.addEventListener("mousemove", (event) => {
    // Disable tile hover when tile editor is active
    if (state.tileEditor.isEditing) {
      tileHighlight.style.display = "none";
      if (tileZoom) {
        tileZoom.style.display = "none";
      }
      clearPaletteHighlight();
      updatePaletteTooltip(null);
      return;
    }

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

    // Convert to image coordinates
    const imgX = mouseX / zoom;
    const imgY = mouseY / zoom;

    // Get output dimensions from state (default to 256 if not set)
    const outputWidth = state.outputWidth || 256;
    const outputHeight = state.outputHeight || 256;
    const tilesPerRow = outputWidth / 8;

    // Check if within image bounds
    if (imgX < 0 || imgX >= outputWidth || imgY < 0 || imgY >= outputHeight) {
      tileHighlight.style.display = "none";
      clearPaletteHighlight();
      updatePaletteTooltip(null);
      return;
    }

    // Calculate tile coordinates (8x8 tiles)
    const tileX = Math.floor(imgX / 8);
    const tileY = Math.floor(imgY / 8);
    const tileIndex = tileY * tilesPerRow + tileX;

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

    // Update palette highlight only when palette changes
    if (paletteIndex !== undefined && paletteIndex !== state.hoveredTile) {
      state.hoveredTile = paletteIndex;
      if (!isEmpty) {
        highlightPalette(paletteIndex);
      } else {
        clearPaletteHighlight();
      }
    }

    // Always update tooltip when tile changes (for VRAM address)
    if (tileIndex !== state.hoveredTileIndex) {
      state.hoveredTileIndex = tileIndex;
      updatePaletteTooltip(paletteIndex, tileX, tileY, isEmpty, tileIndex);
    }
  });

  outputCanvas.addEventListener("mouseleave", () => {
    tileHighlight.style.display = "none";
    if (tileZoom) {
      tileZoom.style.display = "none";
    }
    clearPaletteHighlight();
    updatePaletteTooltip(null, null, null, false, null);
    state.hoveredTile = null;
    state.hoveredTileIndex = null;
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

function getVramBaseAddress() {
  const input = document.querySelector("#vram-address");
  if (!input) return 0x4000;
  const value = input.value.trim();
  // Parse hex format: $4000 or 0x4000
  if (value.startsWith("$")) {
    return parseInt(value.slice(1), 16) || 0x4000;
  } else if (value.startsWith("0x") || value.startsWith("0X")) {
    return parseInt(value, 16) || 0x4000;
  }
  return parseInt(value, 10) || 0x4000;
}

function formatVramAddress(address) {
  return "$" + address.toString(16).toUpperCase().padStart(4, "0");
}

function updatePaletteTooltip(paletteIndex, tileX, tileY, isEmpty = false, tileIndex = null) {
  const tooltip = document.querySelector("#palette-tooltip");
  if (!tooltip) {
    return;
  }

  if (paletteIndex === null) {
    tooltip.innerHTML = "";
    return;
  }

  // Calculate VRAM address for this tile
  let vramAddressStr = "";
  if (tileIndex !== null && state.tileToUnique && state.tileToUnique[tileIndex] !== undefined) {
    const uniqueIndex = state.tileToUnique[tileIndex];
    const baseAddress = getVramBaseAddress();
    const vramAddress = baseAddress + (uniqueIndex * 32);
    vramAddressStr = ` @ ${formatVramAddress(vramAddress)}`;
  }

  // Show empty tile indicator
  if (isEmpty) {
    tooltip.innerHTML = `<span class="palette-tooltip__label">Tuile (${tileX},${tileY}) — vide${vramAddressStr}</span>`;
    return;
  }

  const palette = state.palettes[paletteIndex];
  if (!palette) {
    return;
  }

  // Show mini palette preview in tooltip
  tooltip.innerHTML = `
    <span class="palette-tooltip__label">Tuile (${tileX},${tileY}) → Palette ${paletteIndex}${vramAddressStr}</span>
    <div class="palette-tooltip__colors">
      ${palette.slice(0, 8).map((color) => `<div class="palette-tooltip__swatch" style="background-color:${color}"></div>`).join("")}
    </div>
  `;
}

// ===== Tile Pixel Editor =====

function toggleTileEditing(enabled) {
  state.tileEditor.isEditing = enabled;
  const canvas = document.querySelector("#output-image-canvas");
  const tools = document.querySelector("#tile-editor-tools");
  const toggleBtn = document.querySelector("#tile-editor-toggle");
  const tileHighlight = document.querySelector("#tile-highlight");
  const tileZoom = document.querySelector("#tile-zoom");

  if (canvas) {
    canvas.classList.toggle("tile-editing", enabled);
  }
  if (tools) {
    tools.classList.toggle("is-visible", enabled);
  }
  if (toggleBtn) {
    toggleBtn.classList.toggle("is-active", enabled);
  }

  // Hide/show tile hover elements
  if (enabled) {
    // Hide tile hover elements when editing
    if (tileHighlight) {
      tileHighlight.style.display = "none";
    }
    if (tileZoom) {
      tileZoom.style.display = "none";
    }
    clearPaletteHighlight();
    updatePaletteTooltip(null);
  }

  // Clear any locked state when disabling
  if (!enabled) {
    unlockAllTiles();
    state.tileEditor.selectedColor = null;
    state.tileEditor.activePaletteIndex = null;
  }
}

function setTileEditorTool(tool) {
  state.tileEditor.tool = tool;
  const canvas = document.querySelector("#output-image-canvas");
  const brushBtn = document.querySelector("#tile-editor-brush");
  const selectBtn = document.querySelector("#tile-editor-select");

  // Update button states
  if (brushBtn) {
    brushBtn.classList.toggle("is-active", tool === "brush");
  }
  if (selectBtn) {
    selectBtn.classList.toggle("is-active", tool === "select");
  }

  // Update cursor style
  if (canvas) {
    canvas.classList.toggle("tool-select", tool === "select");
  }

  // Keep the lock state when switching tools - selection defines the work area
}

function lockTilesExceptPalette(paletteIndex) {
  const tilesPerRow = state.outputWidth / 8;
  const totalTiles = (state.outputWidth / 8) * (state.outputHeight / 8);

  state.tileEditor.lockedTiles = new Array(totalTiles).fill(false);
  state.tileEditor.activePaletteIndex = paletteIndex;

  for (let i = 0; i < totalTiles; i++) {
    if (state.tilePaletteMap[i] !== paletteIndex) {
      state.tileEditor.lockedTiles[i] = true;
    }
  }

  drawLockedTileOverlay();
}

function unlockAllTiles() {
  state.tileEditor.lockedTiles = [];
  state.tileEditor.activePaletteIndex = null;

  const overlay = document.querySelector("#tile-lock-overlay");
  if (overlay) {
    const ctx = overlay.getContext("2d");
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    overlay.classList.remove("is-active");
  }
}

function drawLockedTileOverlay() {
  const overlay = document.querySelector("#tile-lock-overlay");
  if (!overlay) return;

  const ctx = overlay.getContext("2d");
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  const tilesPerRow = state.outputWidth / 8;

  // Draw semi-transparent overlay on locked tiles
  ctx.fillStyle = "rgba(0, 0, 0, 0.5)";

  state.tileEditor.lockedTiles.forEach((isLocked, index) => {
    if (isLocked) {
      const tileX = (index % tilesPerRow) * 8;
      const tileY = Math.floor(index / tilesPerRow) * 8;
      ctx.fillRect(tileX, tileY, 8, 8);
    }
  });

  overlay.classList.add("is-active");
}

function updateTileEditorPalette(paletteIndex) {
  const container = document.querySelector("#tile-editor-palette");
  const paletteNumEl = document.querySelector("#tile-editor-palette-num");

  if (!container || paletteIndex === null) return;

  const palette = state.palettes[paletteIndex];
  if (!palette) return;

  // Update palette number display
  if (paletteNumEl) {
    paletteNumEl.textContent = paletteIndex;
  }

  container.innerHTML = "";

  palette.forEach((color, index) => {
    const swatch = document.createElement("div");
    swatch.className = "tile-editor-swatch";
    swatch.style.backgroundColor = color;
    const rgb333 = hexToRGB333(color);
    swatch.title = `R:${rgb333.r} G:${rgb333.g} B:${rgb333.b} (${color}, index ${index})`;
    swatch.dataset.colorIndex = index;

    // Select first non-background color by default if no color selected
    if (index === 1 && !state.tileEditor.selectedColor) {
      swatch.classList.add("is-selected");
      state.tileEditor.selectedColor = color;
    } else if (state.tileEditor.selectedColor &&
               state.tileEditor.selectedColor.toUpperCase() === color.toUpperCase()) {
      swatch.classList.add("is-selected");
    }

    swatch.addEventListener("click", () => selectTileEditorColor(color, swatch));
    container.appendChild(swatch);
  });
}

function selectTileEditorColor(color, swatch) {
  state.tileEditor.selectedColor = color;

  // Update UI
  document.querySelectorAll(".tile-editor-swatch").forEach((s) => {
    s.classList.remove("is-selected");
  });
  if (swatch) {
    swatch.classList.add("is-selected");
  }
}

function setupTileEditorDrawing() {
  // Events are attached to the container #output-canvas which doesn't change
  // This is called once during initial setup, not per conversion
}

function startTileEditorDraw(event) {
  if (!state.tileEditor.isEditing) return;
  // Ignore right-click (handled by context menu)
  if (event.button === 2) return;

  const result = getTileAndPixelFromEvent(event);
  if (result.tileIndex === -1) return;

  // Select tool: lock tiles to this palette and show colors
  if (state.tileEditor.tool === "select") {
    // Check if tile is empty - don't allow selecting empty tiles
    if (state.emptyTiles[result.tileIndex]) return;

    // Lock tiles to this palette
    lockTilesExceptPalette(result.paletteIndex);

    // Update color picker to show this tile's palette
    updateTileEditorPalette(result.paletteIndex);

    // Select first non-background color by default
    if (!state.tileEditor.selectedColor) {
      const palette = state.palettes[result.paletteIndex];
      if (palette && palette.length > 1) {
        state.tileEditor.selectedColor = palette[1];
        updateTileEditorPalette(result.paletteIndex);
      }
    }
    return;
  }

  // Brush tool: can only draw if a selection exists
  if (state.tileEditor.tool === "brush") {
    // Must have a selection first
    if (state.tileEditor.activePaletteIndex === null) {
      return; // No selection made yet, can't draw
    }

    // Check if this tile is locked (different palette)
    if (state.tileEditor.lockedTiles[result.tileIndex]) {
      return; // Can't draw on locked tiles
    }

    // Check if tile is empty
    if (state.emptyTiles[result.tileIndex]) return;

    // Save state for undo before starting to draw
    saveTileEditorState();

    state.tileEditor.isDrawing = true;
    state.tileEditor.lastPixel = null;

    // Draw the first pixel
    if (state.tileEditor.selectedColor) {
      drawPixelAt(result.pixelX, result.pixelY);
    }
  }
}

function drawTileEditorPixel(event) {
  if (!state.tileEditor.isDrawing || !state.tileEditor.isEditing) return;

  const result = getTileAndPixelFromEvent(event);
  if (result.tileIndex === -1) return;

  // Check if this tile is locked
  if (state.tileEditor.lockedTiles[result.tileIndex]) return;

  // Avoid drawing same pixel repeatedly
  const pixelKey = `${result.pixelX},${result.pixelY}`;
  if (state.tileEditor.lastPixel === pixelKey) return;
  state.tileEditor.lastPixel = pixelKey;

  if (state.tileEditor.selectedColor) {
    drawPixelAt(result.pixelX, result.pixelY);
  }
}

function stopTileEditorDraw() {
  if (state.tileEditor.isDrawing) {
    state.tileEditor.isDrawing = false;
    state.tileEditor.lastPixel = null;
    // Keep tiles locked - selection defines the work area
    // Update histogram after drawing
    drawHistogram();
  }
}

function drawPixelAt(x, y) {
  const canvas = document.querySelector("#output-image-canvas");
  if (!canvas || !state.originalImageData) return;

  const ctx = canvas.getContext("2d");
  const color = state.tileEditor.selectedColor;

  // Parse hex color to RGB
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);

  // Update originalImageData
  const index = (y * state.outputWidth + x) * 4;
  state.originalImageData.data[index] = r;
  state.originalImageData.data[index + 1] = g;
  state.originalImageData.data[index + 2] = b;
  state.originalImageData.data[index + 3] = 255;

  // Redraw canvas from originalImageData
  ctx.putImageData(state.originalImageData, 0, 0);

  // Re-apply CRT blur if active
  applyCrtBlur();
}

function getTileAndPixelFromEvent(event) {
  const outputCanvas = document.querySelector("#output-canvas");
  const img = outputCanvas?.querySelector(".viewer__image");
  if (!img) return { tileIndex: -1 };

  const zoomSlider = document.querySelector("#zoom-output");
  const zoom = zoomSlider ? Number(zoomSlider.value) : 1;

  const imgRect = img.getBoundingClientRect();

  // Get actual canvas dimensions (not CSS display size)
  const actualWidth = img.width;
  const actualHeight = img.height;

  // Calculate the CSS display size (without zoom)
  const displayWidth = imgRect.width / zoom;
  const displayHeight = imgRect.height / zoom;

  // Calculate scale ratio between actual size and CSS display size
  const scaleX = actualWidth / displayWidth;
  const scaleY = actualHeight / displayHeight;

  // Calculate mouse position relative to displayed image
  const mouseX = event.clientX - imgRect.left;
  const mouseY = event.clientY - imgRect.top;

  // Convert to actual image pixel coordinates
  // First divide by zoom to get CSS coordinates, then multiply by scale ratio
  const pixelX = Math.floor((mouseX / zoom) * scaleX);
  const pixelY = Math.floor((mouseY / zoom) * scaleY);

  // Get output dimensions from state
  const outputWidth = state.outputWidth || 256;
  const outputHeight = state.outputHeight || 256;

  // Check bounds
  if (pixelX < 0 || pixelX >= outputWidth ||
      pixelY < 0 || pixelY >= outputHeight) {
    return { tileIndex: -1 };
  }

  // Calculate tile index
  const tilesPerRow = outputWidth / 8;
  const tileX = Math.floor(pixelX / 8);
  const tileY = Math.floor(pixelY / 8);
  const tileIndex = tileY * tilesPerRow + tileX;

  const paletteIndex = state.tilePaletteMap[tileIndex];

  return { tileIndex, paletteIndex, pixelX, pixelY };
}

function saveTileEditorState() {
  if (!state.originalImageData) return;

  // Remove any redo states
  if (state.tileEditor.historyIndex < state.tileEditor.history.length - 1) {
    state.tileEditor.history = state.tileEditor.history.slice(
      0, state.tileEditor.historyIndex + 1
    );
  }

  // Save copy of originalImageData and tilePaletteMap
  const imageDataCopy = new ImageData(
    new Uint8ClampedArray(state.originalImageData.data),
    state.originalImageData.width,
    state.originalImageData.height
  );
  const tilePaletteMapCopy = [...state.tilePaletteMap];

  state.tileEditor.history.push({
    imageData: imageDataCopy,
    tilePaletteMap: tilePaletteMapCopy
  });

  // Limit history size
  if (state.tileEditor.history.length > state.tileEditor.maxHistory) {
    state.tileEditor.history.shift();
  } else {
    state.tileEditor.historyIndex++;
  }
}

function undoTileEditor() {
  if (state.tileEditor.historyIndex < 0 || state.tileEditor.history.length === 0) return;

  const historyEntry = state.tileEditor.history[state.tileEditor.historyIndex];
  state.tileEditor.historyIndex--;

  if (historyEntry) {
    // Handle both old format (ImageData) and new format (object with imageData + tilePaletteMap)
    const imageData = historyEntry.imageData || historyEntry;
    const tilePaletteMap = historyEntry.tilePaletteMap;

    // Restore originalImageData
    state.originalImageData = new ImageData(
      new Uint8ClampedArray(imageData.data),
      imageData.width,
      imageData.height
    );

    // Restore tilePaletteMap if available
    if (tilePaletteMap) {
      state.tilePaletteMap = [...tilePaletteMap];
    }

    // Redraw
    const canvas = document.querySelector("#output-image-canvas");
    if (canvas) {
      const ctx = canvas.getContext("2d");
      ctx.putImageData(state.originalImageData, 0, 0);
      applyCrtBlur();
    }

    // Update lock overlay if a palette is selected
    if (state.tileEditor.activePaletteIndex !== null) {
      lockTilesExceptPalette(state.tileEditor.activePaletteIndex);
    }

    // Update histogram
    drawHistogram();
  }
}

function redoTileEditor() {
  if (state.tileEditor.historyIndex >= state.tileEditor.history.length - 1) return;

  state.tileEditor.historyIndex++;
  const historyEntry = state.tileEditor.history[state.tileEditor.historyIndex];

  if (historyEntry) {
    // Handle both old format (ImageData) and new format (object with imageData + tilePaletteMap)
    const imageData = historyEntry.imageData || historyEntry;
    const tilePaletteMap = historyEntry.tilePaletteMap;

    // Restore originalImageData
    state.originalImageData = new ImageData(
      new Uint8ClampedArray(imageData.data),
      imageData.width,
      imageData.height
    );

    // Restore tilePaletteMap if available
    if (tilePaletteMap) {
      state.tilePaletteMap = [...tilePaletteMap];
    }

    const canvas = document.querySelector("#output-image-canvas");
    if (canvas) {
      const ctx = canvas.getContext("2d");
      ctx.putImageData(state.originalImageData, 0, 0);
      applyCrtBlur();
    }

    // Update lock overlay if a palette is selected
    if (state.tileEditor.activePaletteIndex !== null) {
      lockTilesExceptPalette(state.tileEditor.activePaletteIndex);
    }

    // Update histogram
    drawHistogram();
  }
}

function resetTileEditorState() {
  state.tileEditor.isEditing = false;
  state.tileEditor.isDrawing = false;
  state.tileEditor.tool = "brush";
  state.tileEditor.history = [];
  state.tileEditor.historyIndex = -1;
  state.tileEditor.selectedColor = null;
  state.tileEditor.activePaletteIndex = null;
  state.tileEditor.lockedTiles = [];
  state.tileEditor.lastPixel = null;
  state.tileEditor.contextMenuTileIndex = null;
  toggleTileEditing(false);
  setTileEditorTool("brush");

  // Clear the palette picker and number
  const container = document.querySelector("#tile-editor-palette");
  if (container) {
    container.innerHTML = "";
  }
  const paletteNumEl = document.querySelector("#tile-editor-palette-num");
  if (paletteNumEl) {
    paletteNumEl.textContent = "-";
  }
}

// ===== Tile Context Menu =====

function showTileContextMenu(x, y) {
  const menu = document.querySelector("#tile-context-menu");
  if (!menu) return;

  // Position the menu, ensuring it stays within viewport
  const menuWidth = 180;
  const menuHeight = 40;
  const maxX = window.innerWidth - menuWidth - 10;
  const maxY = window.innerHeight - menuHeight - 10;

  menu.style.left = Math.min(x, maxX) + "px";
  menu.style.top = Math.min(y, maxY) + "px";
  menu.classList.add("is-visible");
}

function hideTileContextMenu() {
  const menu = document.querySelector("#tile-context-menu");
  if (menu) {
    menu.classList.remove("is-visible");
  }
}

function showPaletteSelector() {
  hideTileContextMenu();

  const modal = document.querySelector("#palette-selector-modal");
  const grid = document.querySelector("#palette-selector-grid");
  if (!modal || !grid) return;

  // Get current palette of the tile
  const tileIndex = state.tileEditor.contextMenuTileIndex;
  const currentPaletteIndex = tileIndex !== null ? state.tilePaletteMap[tileIndex] : null;

  grid.innerHTML = "";

  state.palettes.forEach((palette, index) => {
    const item = document.createElement("div");
    item.className = "palette-selector-item";

    // Highlight current palette
    if (index === currentPaletteIndex) {
      item.classList.add("is-current");
    }

    const label = document.createElement("span");
    label.textContent = `Palette ${index}${index === currentPaletteIndex ? " (current)" : ""}`;
    item.appendChild(label);

    const colorsDiv = document.createElement("div");
    colorsDiv.className = "palette-selector-colors";

    palette.forEach((color) => {
      const colorDiv = document.createElement("div");
      colorDiv.className = "palette-selector-color";
      colorDiv.style.background = color;
      colorsDiv.appendChild(colorDiv);
    });

    item.appendChild(colorsDiv);
    item.addEventListener("click", () => convertTileToPalette(index));
    grid.appendChild(item);
  });

  modal.classList.add("is-visible");
}

function hidePaletteSelector() {
  const modal = document.querySelector("#palette-selector-modal");
  if (modal) {
    modal.classList.remove("is-visible");
  }
}

function findClosestColorInPalette(r, g, b, palette) {
  let minDist = Infinity;
  let closest = { r: 0, g: 0, b: 0 };

  for (const hex of palette) {
    const pr = parseInt(hex.slice(1, 3), 16);
    const pg = parseInt(hex.slice(3, 5), 16);
    const pb = parseInt(hex.slice(5, 7), 16);

    // Euclidean distance in RGB space
    const dist = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;

    if (dist < minDist) {
      minDist = dist;
      closest = { r: pr, g: pg, b: pb };
    }
  }

  return closest;
}

function convertTileToPalette(targetPaletteIndex) {
  hidePaletteSelector();

  const tileIndex = state.tileEditor.contextMenuTileIndex;
  if (tileIndex === null) return;

  const targetPalette = state.palettes[targetPaletteIndex];
  if (!targetPalette) return;

  // Save state for undo
  saveTileEditorState();

  // Calculate tile coordinates
  const tilesPerRow = state.outputWidth / 8;
  const tileX = (tileIndex % tilesPerRow) * 8;
  const tileY = Math.floor(tileIndex / tilesPerRow) * 8;

  // Convert each pixel of the tile
  for (let py = 0; py < 8; py++) {
    for (let px = 0; px < 8; px++) {
      const x = tileX + px;
      const y = tileY + py;
      const idx = (y * state.outputWidth + x) * 4;

      const r = state.originalImageData.data[idx];
      const g = state.originalImageData.data[idx + 1];
      const b = state.originalImageData.data[idx + 2];

      // Find closest color in target palette
      const closest = findClosestColorInPalette(r, g, b, targetPalette);

      state.originalImageData.data[idx] = closest.r;
      state.originalImageData.data[idx + 1] = closest.g;
      state.originalImageData.data[idx + 2] = closest.b;
    }
  }

  // Update tilePaletteMap
  state.tilePaletteMap[tileIndex] = targetPaletteIndex;

  // Redraw canvas
  const canvas = document.querySelector("#output-image-canvas");
  if (canvas) {
    const ctx = canvas.getContext("2d");
    ctx.putImageData(state.originalImageData, 0, 0);
    applyCrtBlur();
  }

  // Update selection to new palette
  lockTilesExceptPalette(targetPaletteIndex);
  updateTileEditorPalette(targetPaletteIndex);

  // Update histogram
  drawHistogram();

  state.tileEditor.contextMenuTileIndex = null;
}

// ===== Palette Groups Editor =====

function calculateVirtualTileGrid(sourceWidth, sourceHeight, outputWidthTiles, outputHeightTiles) {
  // Virtual tile size = source pixels per output tile (round up for full coverage)
  const virtualTileWidth = Math.ceil(sourceWidth / outputWidthTiles);
  const virtualTileHeight = Math.ceil(sourceHeight / outputHeightTiles);

  return {
    gridWidth: outputWidthTiles,
    gridHeight: outputHeightTiles,
    virtualTileWidth,
    virtualTileHeight,
  };
}

function initPaletteGroupsCanvas() {
  const sourceImg = document.querySelector("#source-image");
  const wrapper = document.querySelector("#input-canvas .viewer__image-wrapper");
  if (!sourceImg || !wrapper) return;

  // Get current output dimensions from sliders
  const outputWidthTiles = parseInt(document.querySelector("#output-width-tiles")?.value || "32", 10);
  const outputHeightTiles = parseInt(document.querySelector("#output-height-tiles")?.value || "32", 10);

  const grid = calculateVirtualTileGrid(
    sourceImg.naturalWidth,
    sourceImg.naturalHeight,
    outputWidthTiles,
    outputHeightTiles
  );

  state.paletteGroups.gridWidth = grid.gridWidth;
  state.paletteGroups.gridHeight = grid.gridHeight;
  state.paletteGroups.virtualTileWidth = grid.virtualTileWidth;
  state.paletteGroups.virtualTileHeight = grid.virtualTileHeight;

  // Create or reuse canvas
  let canvas = wrapper.querySelector("#palette-groups-canvas");
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.id = "palette-groups-canvas";
    canvas.className = "palette-groups-canvas";
    wrapper.appendChild(canvas);
  }

  canvas.width = sourceImg.naturalWidth;
  canvas.height = sourceImg.naturalHeight;

  state.paletteGroups.canvas = canvas;
  state.paletteGroups.ctx = canvas.getContext("2d");

  // Initialize or resize assignments array
  const oldAssignments = state.paletteGroups.assignments;
  const needsReset = !oldAssignments.length ||
    oldAssignments.length !== grid.gridHeight ||
    (oldAssignments[0] && oldAssignments[0].length !== grid.gridWidth);

  if (needsReset) {
    state.paletteGroups.assignments = Array(grid.gridHeight)
      .fill(null)
      .map(() => Array(grid.gridWidth).fill(null));
    state.paletteGroups.history = [];
    state.paletteGroups.historyIndex = -1;
    savePaletteGroupsState();
  }

  // Setup event handlers
  setupPaletteGroupsDrawing();

  // Render overlay
  renderPaletteGroupsOverlay();
}

function setupPaletteGroupsDrawing() {
  const canvas = state.paletteGroups.canvas;
  if (!canvas) return;

  // Remove old listeners to avoid duplicates
  canvas.removeEventListener("mousedown", handlePaletteGroupsMouseDown);
  canvas.removeEventListener("mousemove", handlePaletteGroupsMouseMove);
  canvas.removeEventListener("mouseup", handlePaletteGroupsMouseUp);
  canvas.removeEventListener("mouseleave", handlePaletteGroupsMouseUp);

  // Add new listeners
  canvas.addEventListener("mousedown", handlePaletteGroupsMouseDown);
  canvas.addEventListener("mousemove", handlePaletteGroupsMouseMove);
  canvas.addEventListener("mouseup", handlePaletteGroupsMouseUp);
  canvas.addEventListener("mouseleave", handlePaletteGroupsMouseUp);
}

function handlePaletteGroupsMouseDown(event) {
  if (!state.paletteGroups.isEditing) return;
  // Allow Shift+drag for panning
  if (event.shiftKey) return;
  event.preventDefault();
  state.paletteGroups.isDrawing = true;
  applyPaletteGroupsBrush(event);
}

function handlePaletteGroupsMouseMove(event) {
  if (!state.paletteGroups.isDrawing || !state.paletteGroups.isEditing) return;
  applyPaletteGroupsBrush(event);
}

function handlePaletteGroupsMouseUp() {
  if (state.paletteGroups.isDrawing) {
    state.paletteGroups.isDrawing = false;
    savePaletteGroupsState();
  }
}

function applyPaletteGroupsBrush(event) {
  const canvas = state.paletteGroups.canvas;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

  const x = (event.clientX - rect.left) * scaleX;
  const y = (event.clientY - rect.top) * scaleY;

  const { virtualTileWidth, virtualTileHeight, gridWidth, gridHeight, brushSize, tool, selectedGroup, assignments } = state.paletteGroups;

  const tileX = Math.floor(x / virtualTileWidth);
  const tileY = Math.floor(y / virtualTileHeight);

  if (tileX < 0 || tileX >= gridWidth || tileY < 0 || tileY >= gridHeight) {
    return;
  }

  const halfBrush = Math.floor(brushSize / 2);

  // Apply brush to surrounding tiles
  for (let dy = -halfBrush; dy <= halfBrush; dy++) {
    for (let dx = -halfBrush; dx <= halfBrush; dx++) {
      const tx = tileX + dx;
      const ty = tileY + dy;

      if (tx >= 0 && tx < gridWidth && ty >= 0 && ty < gridHeight) {
        if (tool === "brush") {
          assignments[ty][tx] = selectedGroup;
        } else if (tool === "eraser") {
          assignments[ty][tx] = null;
        }
      }
    }
  }

  renderPaletteGroupsOverlay();
}

function renderPaletteGroupsOverlay() {
  const ctx = state.paletteGroups.ctx;
  const canvas = state.paletteGroups.canvas;
  if (!ctx || !canvas) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const { gridWidth, gridHeight, virtualTileWidth, virtualTileHeight, assignments } = state.paletteGroups;

  // Draw colored overlays for assigned tiles
  for (let y = 0; y < gridHeight; y++) {
    for (let x = 0; x < gridWidth; x++) {
      const group = assignments[y]?.[x];
      if (group !== null && group !== undefined) {
        ctx.fillStyle = PALETTE_GROUP_COLORS[group];
        ctx.fillRect(
          x * virtualTileWidth,
          y * virtualTileHeight,
          virtualTileWidth,
          virtualTileHeight
        );
      }
    }
  }

  // Draw grid lines (subtle)
  ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
  ctx.lineWidth = 1;

  for (let x = 0; x <= gridWidth; x++) {
    ctx.beginPath();
    ctx.moveTo(x * virtualTileWidth, 0);
    ctx.lineTo(x * virtualTileWidth, canvas.height);
    ctx.stroke();
  }

  for (let y = 0; y <= gridHeight; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * virtualTileHeight);
    ctx.lineTo(canvas.width, y * virtualTileHeight);
    ctx.stroke();
  }
}

function togglePaletteGroupsEditing(enabled) {
  state.paletteGroups.isEditing = enabled;

  const canvas = document.querySelector("#palette-groups-canvas");
  const tools = document.querySelector("#palette-groups-tools");
  const toggleBtn = document.querySelector("#palette-groups-toggle");

  if (canvas) {
    canvas.classList.toggle("is-editing", enabled);
    canvas.classList.toggle("is-visible", enabled);
  }
  if (tools) {
    tools.classList.toggle("is-visible", enabled);
  }
  if (toggleBtn) {
    toggleBtn.classList.toggle("is-active", enabled);
  }

  // Close mask editor if opening palette groups
  if (enabled && state.mask.isEditing) {
    toggleMaskEditing(false);
  }
}

function savePaletteGroupsState() {
  const { assignments, history, historyIndex, maxHistory } = state.paletteGroups;

  // Mark project as dirty when palette groups change
  markProjectDirty();

  // Remove redo states
  if (historyIndex < history.length - 1) {
    state.paletteGroups.history = history.slice(0, historyIndex + 1);
  }

  // Deep copy assignments
  const copy = assignments.map((row) => [...row]);
  state.paletteGroups.history.push(copy);

  if (state.paletteGroups.history.length > maxHistory) {
    state.paletteGroups.history.shift();
  } else {
    state.paletteGroups.historyIndex++;
  }
}

function undoPaletteGroups() {
  if (state.paletteGroups.historyIndex <= 0) return;

  state.paletteGroups.historyIndex--;
  const data = state.paletteGroups.history[state.paletteGroups.historyIndex];
  state.paletteGroups.assignments = data.map((row) => [...row]);
  renderPaletteGroupsOverlay();
}

function redoPaletteGroups() {
  if (state.paletteGroups.historyIndex >= state.paletteGroups.history.length - 1) return;

  state.paletteGroups.historyIndex++;
  const data = state.paletteGroups.history[state.paletteGroups.historyIndex];
  state.paletteGroups.assignments = data.map((row) => [...row]);
  renderPaletteGroupsOverlay();
}

function clearPaletteGroups() {
  const { gridWidth, gridHeight } = state.paletteGroups;
  state.paletteGroups.assignments = Array(gridHeight)
    .fill(null)
    .map(() => Array(gridWidth).fill(null));
  renderPaletteGroupsOverlay();
  savePaletteGroupsState();
}

function initPaletteGroupsSelector() {
  const container = document.querySelector("#palette-groups-selector");
  if (!container) return;

  container.innerHTML = "";

  for (let i = 0; i < 16; i++) {
    const btn = document.createElement("button");
    btn.className = "pg-group-btn" + (i === 0 ? " is-selected" : "");
    btn.dataset.group = i;
    btn.textContent = i.toString(16).toUpperCase();
    btn.title = `Groupe ${i}`;

    btn.addEventListener("click", () => selectPaletteGroup(i));
    container.appendChild(btn);
  }
}

function selectPaletteGroup(group) {
  state.paletteGroups.selectedGroup = group;

  document.querySelectorAll(".pg-group-btn").forEach((btn) => {
    btn.classList.toggle("is-selected", parseInt(btn.dataset.group, 10) === group);
  });
}

function getPaletteGroupConstraints() {
  const { gridWidth, gridHeight, assignments } = state.paletteGroups;

  // If no assignments exist, return empty array (no constraints)
  if (!assignments || !assignments.length) {
    return [];
  }

  // Get output dimensions in tiles
  const outputWidthTiles = parseInt(document.querySelector("#output-width-tiles").value, 10);
  const outputHeightTiles = parseInt(document.querySelector("#output-height-tiles").value, 10);
  const keepRatio = document.querySelector("#keep-ratio")?.checked || false;

  // If dimensions match and no keep ratio, use direct mapping
  if (!keepRatio && gridWidth === outputWidthTiles && gridHeight === outputHeightTiles) {
    const constraints = [];
    for (let y = 0; y < gridHeight; y++) {
      for (let x = 0; x < gridWidth; x++) {
        const group = assignments[y]?.[x];
        constraints.push(group !== null && group !== undefined ? group : -1);
      }
    }
    return constraints;
  }

  // Get source image dimensions
  const sourceImg = document.querySelector("#source-image");
  if (!sourceImg) {
    return [];
  }
  const srcWidth = sourceImg.naturalWidth;
  const srcHeight = sourceImg.naturalHeight;

  // Target dimensions in pixels
  const dstWidth = outputWidthTiles * 8;
  const dstHeight = outputHeightTiles * 8;

  // Calculate scaled dimensions (same logic as Rust resize_to_target)
  let scaledWidth, scaledHeight, offsetX, offsetY;

  if (!keepRatio) {
    // Simple stretch to fill
    scaledWidth = dstWidth;
    scaledHeight = dstHeight;
    offsetX = 0;
    offsetY = 0;
  } else {
    // Calculate scaled dimensions keeping aspect ratio
    const srcRatio = srcWidth / srcHeight;
    const dstRatio = dstWidth / dstHeight;

    if (srcRatio > dstRatio) {
      // Source is wider - fit to width
      scaledWidth = dstWidth;
      scaledHeight = Math.min(Math.round(dstWidth / srcRatio), dstHeight);
    } else {
      // Source is taller - fit to height
      scaledHeight = dstHeight;
      scaledWidth = Math.min(Math.round(dstHeight * srcRatio), dstWidth);
    }

    // Calculate offsets to center
    offsetX = Math.floor((dstWidth - scaledWidth) / 2);
    offsetY = Math.floor((dstHeight - scaledHeight) / 2);
  }

  // Convert pixel offsets to tile offsets
  const tileOffsetX = Math.floor(offsetX / 8);
  const tileOffsetY = Math.floor(offsetY / 8);
  const scaledWidthTiles = Math.ceil(scaledWidth / 8);
  const scaledHeightTiles = Math.ceil(scaledHeight / 8);

  // Create constraints array for OUTPUT tiles
  const constraints = [];
  for (let outY = 0; outY < outputHeightTiles; outY++) {
    for (let outX = 0; outX < outputWidthTiles; outX++) {
      // Check if this output tile is within the actual image area
      if (outX >= tileOffsetX && outX < tileOffsetX + scaledWidthTiles &&
          outY >= tileOffsetY && outY < tileOffsetY + scaledHeightTiles) {
        // Map output tile to source virtual tile
        const localX = outX - tileOffsetX;
        const localY = outY - tileOffsetY;
        const srcX = Math.floor(localX * gridWidth / scaledWidthTiles);
        const srcY = Math.floor(localY * gridHeight / scaledHeightTiles);

        // Get constraint from source grid
        const group = assignments[srcY]?.[srcX];
        constraints.push(group !== null && group !== undefined ? group : -1);
      } else {
        // Tile is outside image area (padding) - no constraint
        constraints.push(-1);
      }
    }
  }

  return constraints;
}

function setupPaletteGroupsEventListeners() {
  // Toggle button
  document.querySelector("#palette-groups-toggle")?.addEventListener("click", () => {
    togglePaletteGroupsEditing(!state.paletteGroups.isEditing);
  });

  // Tool buttons
  document.querySelector("#pg-brush")?.addEventListener("click", () => {
    state.paletteGroups.tool = "brush";
    document.querySelector("#pg-brush")?.classList.add("is-active");
    document.querySelector("#pg-eraser")?.classList.remove("is-active");
  });

  document.querySelector("#pg-eraser")?.addEventListener("click", () => {
    state.paletteGroups.tool = "eraser";
    document.querySelector("#pg-eraser")?.classList.add("is-active");
    document.querySelector("#pg-brush")?.classList.remove("is-active");
  });

  // Brush size
  document.querySelector("#pg-brush-size")?.addEventListener("input", (e) => {
    state.paletteGroups.brushSize = parseInt(e.target.value, 10);
    const label = document.querySelector("#pg-brush-size-value");
    if (label) label.textContent = e.target.value;
  });

  // Undo/Redo/Clear
  document.querySelector("#pg-undo")?.addEventListener("click", undoPaletteGroups);
  document.querySelector("#pg-redo")?.addEventListener("click", redoPaletteGroups);
  document.querySelector("#pg-clear")?.addEventListener("click", clearPaletteGroups);

  // Initialize group selector
  initPaletteGroupsSelector();
}

// ===== End Palette Groups Editor =====

// ===== Histogram =====

function drawHistogram() {
  const canvas = document.querySelector("#histogram-canvas");
  if (!canvas || !state.originalImageData) return;

  // Resize canvas to match display size for crisp rendering
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const width = rect.width;
  const height = rect.height;

  // Clear
  ctx.fillStyle = "#0d1016";
  ctx.fillRect(0, 0, width, height);

  // Calculate histogram with 8 bins (RGB333 levels)
  // Track min and max colors per bin (by luminance)
  const bins = new Array(8).fill(0);
  const binColors = Array.from({ length: 8 }, () => ({
    minLum: 256,
    maxLum: -1,
    minColor: null,
    maxColor: null
  }));
  const data = state.originalImageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    // Calculate luminance and map to RGB333 level (0-7)
    const lum = (r + g + b) / 3;
    const level = Math.min(Math.round(lum / 36.43), 7); // 255/7 ≈ 36.43
    bins[level]++;

    // Track min and max colors by luminance
    const binData = binColors[level];
    if (lum < binData.minLum) {
      binData.minLum = lum;
      binData.minColor = { r, g, b };
    }
    if (lum > binData.maxLum) {
      binData.maxLum = lum;
      binData.maxColor = { r, g, b };
    }
  }

  // Calculate total pixels for percentage
  const totalPixels = data.length / 4;

  // Find max value for normalization (ignore first bin if it dominates)
  const maxVal = Math.max(...bins.slice(1), bins[0] * 0.5);

  if (maxVal === 0) return;

  // Draw 8 bars with gradient from min to max color
  for (let i = 0; i < 8; i++) {
    const x = (i / 8) * width;
    const nextX = ((i + 1) / 8) * width;
    const barWidth = nextX - x;
    const barHeight = (bins[i] / maxVal) * height;

    const binData = binColors[i];
    const barTop = height - barHeight;

    if (binData.minColor && binData.maxColor) {
      // Create vertical gradient from min (bottom) to max (top)
      const gradient = ctx.createLinearGradient(0, height, 0, barTop);
      const minC = binData.minColor;
      const maxC = binData.maxColor;
      gradient.addColorStop(0, `rgb(${minC.r}, ${minC.g}, ${minC.b})`);
      gradient.addColorStop(1, `rgb(${maxC.r}, ${maxC.g}, ${maxC.b})`);
      ctx.fillStyle = gradient;
    } else {
      // Fallback gray for empty bins
      const gray = Math.round((i / 7) * 255);
      ctx.fillStyle = `rgb(${gray}, ${gray}, ${gray})`;
    }

    ctx.fillRect(x, barTop, barWidth, barHeight);
  }

  // Draw percentage labels vertically in each bar
  ctx.font = "bold 13px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (let i = 0; i < 8; i++) {
    const percentage = ((bins[i] / totalPixels) * 100).toFixed(1);
    if (parseFloat(percentage) === 0) continue;

    const x = (i / 8) * width;
    const barWidth = width / 8;
    const barCenterX = x + barWidth / 2;

    // Draw text vertically (rotated -90 degrees)
    ctx.save();
    ctx.translate(barCenterX, height - 22);
    ctx.rotate(-Math.PI / 2);

    // Draw text with outline for visibility (30% transparent)
    ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
    ctx.lineWidth = 3;
    ctx.strokeText(`${percentage}%`, 0, 0);
    ctx.fillStyle = "#fff";
    ctx.fillText(`${percentage}%`, 0, 0);

    ctx.restore();
  }
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

    // Get BAT size and offset settings
    const batSizeValue = document.querySelector("#bat-size")?.value || "32x32";
    const [batWidth, batHeight] = batSizeValue.split("x").map(Number);
    const offsetX = parseInt(document.querySelector("#offset-x")?.value, 10) || 0;
    const offsetY = parseInt(document.querySelector("#offset-y")?.value, 10) || 0;

    // Call Rust export function
    const result = await invoke("export_plain_text", {
      imageData: Array.from(imageData),
      palettes: state.palettes,
      tilePaletteMap: state.tilePaletteMap,
      emptyTiles: state.emptyTiles,
      vramBaseAddress: vramAddress,
      batWidth,
      batHeight,
      offsetX,
      offsetY,
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

    // Get endianness settings
    const batBigEndian = document.querySelector("#bat-big-endian")?.checked || false;
    const palBigEndian = document.querySelector("#pal-big-endian")?.checked || false;
    const tilesBigEndian = document.querySelector("#tiles-big-endian")?.checked || false;

    // Get BAT size and offset settings
    const batSizeValue = document.querySelector("#bat-size")?.value || "32x32";
    const [batWidth, batHeight] = batSizeValue.split("x").map(Number);
    const offsetX = parseInt(document.querySelector("#offset-x")?.value, 10) || 0;
    const offsetY = parseInt(document.querySelector("#offset-y")?.value, 10) || 0;

    // Debug: log data being passed
    console.info(`DEBUG EXPORT: imageData size: ${imageData.length} bytes`);
    console.info(`DEBUG EXPORT: palettes: ${state.palettes.length}, tilePaletteMap: ${state.tilePaletteMap.length}, emptyTiles: ${state.emptyTiles.length}`);
    console.info(`DEBUG EXPORT: Endianness - BAT: ${batBigEndian ? 'big' : 'little'}, PAL: ${palBigEndian ? 'big' : 'little'}, TILES: ${tilesBigEndian ? 'big' : 'little'}`);
    // Log first palette content
    if (state.palettes.length > 0) {
      console.info(`DEBUG EXPORT: Palette 0 has ${state.palettes[0].length} colors: ${state.palettes[0].slice(0, 5).join(', ')}...`);
    }
    // Log first few tile palette assignments (non-empty tiles)
    const nonEmptyIndices = state.tilePaletteMap.slice(0, 20).map((p, i) => state.emptyTiles[i] ? 'E' : p);
    console.info(`DEBUG EXPORT: First 20 tiles (E=empty): ${nonEmptyIndices.join(', ')}`);

    // Call Rust export function to generate binary data
    const result = await invoke("export_binaries", {
      imageData: Array.from(imageData),
      palettes: state.palettes,
      tilePaletteMap: state.tilePaletteMap,
      emptyTiles: state.emptyTiles,
      vramBaseAddress: vramAddress,
      batBigEndian,
      palBigEndian,
      tilesBigEndian,
      batWidth,
      batHeight,
      offsetX,
      offsetY,
    });

    // Show save dialog - user picks base filename
    const { save } = window.__TAURI__.dialog;

    const basePath = await save({
      defaultPath: "export",
      filters: [{ name: "Export name", extensions: ["bin"] }],
    });

    if (!basePath) {
      return; // User cancelled
    }

    // Call Rust to create directory and write files
    await invoke("save_binaries_to_disk", {
      basePath,
      batData: result.bat,
      tilesData: result.tiles,
      palData: result.palettes,
    });

    console.info(`Binaires exportés dans le répertoire`);
    console.info(`${result.unique_tile_count} tuiles uniques (${result.tile_count} total)`);
    console.info(`DEBUG: Image ${result.image_width}x${result.image_height}, ${result.palette_count} palettes, ${result.empty_tile_count} tuiles vides`);
    console.info(`DEBUG: Tiles data size: ${result.tiles.length} bytes (expected: ${result.unique_tile_count * 32})`);
    if (result.debug_info) {
      console.info("=== RUST DEBUG INFO ===");
      console.info(result.debug_info);
    }
  } catch (error) {
    console.error("Erreur d'export binaire:", error);
  }
}

/**
 * Export HTML report with image, palettes, and statistics
 */
async function exportHtmlReport() {
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

    // Gather current settings
    const settings = {
      resize: document.querySelector("#resize-method")?.value || "lanczos",
      palettes: document.querySelector("#palette-count")?.value || "16",
      dithering: document.querySelector("#dither-mode")?.value || "none",
      transparency: document.querySelector("#transparency")?.checked ? "Oui" : "Non",
      keepRatio: document.querySelector("#keep-ratio")?.checked ? "Oui" : "Non",
      width: document.querySelector("#output-width-tiles")?.value || "32",
      height: document.querySelector("#output-height-tiles")?.value || "32",
    };

    // Show save dialog
    const { save } = window.__TAURI__.dialog;

    const basePath = await save({
      defaultPath: "rapport",
      filters: [{ name: "HTML Report", extensions: ["html"] }],
    });

    if (!basePath) {
      return; // User cancelled
    }

    // Call Rust to generate and save the HTML report
    await invoke("save_html_report", {
      basePath,
      imageData: Array.from(imageData),
      palettes: state.palettes,
      tilePaletteMap: state.tilePaletteMap,
      tileCount: state.tileCount || state.tilePaletteMap.length,
      uniqueTileCount: state.uniqueTileCount || 0,
      vramBaseAddress: vramAddress,
      settings,
    });

    console.info("Rapport HTML exporté avec succès");
  } catch (error) {
    console.error("Erreur d'export HTML:", error);
  }
}

// ===== End Export Functions =====

// ===== Settings Persistence =====

const SETTINGS_KEY = "image2pce-settings";

function saveSettings() {
  // Mark project as dirty when settings change
  markProjectDirty();

  const viewer = document.querySelector(".viewer");
  const viewerHeight = viewer ? parseInt(getComputedStyle(viewer).getPropertyValue("--viewer-height")) || 500 : 500;
  const viewerSplit = viewer ? parseFloat(getComputedStyle(viewer).getPropertyValue("--viewer-split")) || 50 : 50;

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
    outputWidthTiles: document.querySelector("#output-width-tiles")?.value,
    outputHeightTiles: document.querySelector("#output-height-tiles")?.value,
    batSize: document.querySelector("#bat-size")?.value,
    offsetX: document.querySelector("#offset-x")?.value,
    offsetY: document.querySelector("#offset-y")?.value,
    viewerHeight: viewerHeight,
    viewerSplit: viewerSplit,
    curvePoints: state.curvePoints,
    fixedColor0: state.fixedColor0,
    batBigEndian: document.querySelector("#bat-big-endian")?.checked,
    palBigEndian: document.querySelector("#pal-big-endian")?.checked,
    tilesBigEndian: document.querySelector("#tiles-big-endian")?.checked,
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
    if (settings.outputWidthTiles) {
      const el = document.querySelector("#output-width-tiles");
      if (el) {
        el.value = settings.outputWidthTiles;
        document.querySelector("#output-width-value").textContent = `${settings.outputWidthTiles} (${settings.outputWidthTiles * 8} px)`;
      }
    }
    if (settings.outputHeightTiles) {
      const el = document.querySelector("#output-height-tiles");
      if (el) {
        el.value = settings.outputHeightTiles;
        document.querySelector("#output-height-value").textContent = `${settings.outputHeightTiles} (${settings.outputHeightTiles * 8} px)`;
      }
    }
    if (settings.batSize) {
      const el = document.querySelector("#bat-size");
      if (el) el.value = settings.batSize;
    }
    if (settings.offsetX !== undefined) {
      const el = document.querySelector("#offset-x");
      if (el) el.value = settings.offsetX;
    }
    if (settings.offsetY !== undefined) {
      const el = document.querySelector("#offset-y");
      if (el) el.value = settings.offsetY;
    }
    // Update constraints after restoring BAT size and offsets
    updateSizeConstraints();
    if (settings.viewerHeight) {
      applyViewerHeight(settings.viewerHeight);
    }
    if (settings.viewerSplit) {
      applyViewerSplit(settings.viewerSplit);
    }

    // Restore state values
    if (settings.curvePoints && Array.isArray(settings.curvePoints)) {
      state.curvePoints = settings.curvePoints;
    }
    if (settings.fixedColor0) {
      state.fixedColor0 = settings.fixedColor0;
    }

    // Restore endianness settings
    if (settings.batBigEndian !== undefined) {
      const el = document.querySelector("#bat-big-endian");
      if (el) el.checked = settings.batBigEndian;
    }
    if (settings.palBigEndian !== undefined) {
      const el = document.querySelector("#pal-big-endian");
      if (el) el.checked = settings.palBigEndian;
    }
    if (settings.tilesBigEndian !== undefined) {
      const el = document.querySelector("#tiles-big-endian");
      if (el) el.checked = settings.tilesBigEndian;
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
    "#output-width-tiles",
    "#output-height-tiles",
    "#bat-big-endian",
    "#pal-big-endian",
    "#tiles-big-endian",
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

// ===== Project Save/Load =====

const PROJECT_VERSION = 1;

function markProjectDirty() {
  // Don't mark as dirty while loading a project
  if (state.isLoadingProject) return;

  if (!state.projectDirty) {
    state.projectDirty = true;
    const saveBtn = document.querySelector("#save-project");
    if (saveBtn) {
      saveBtn.classList.add("btn--dirty");
    }
  }
}

function clearProjectDirty() {
  state.projectDirty = false;
  const saveBtn = document.querySelector("#save-project");
  if (saveBtn) {
    saveBtn.classList.remove("btn--dirty");
  }
}

async function saveProject() {
  try {
    // Collect all project data
    const project = {
      version: PROJECT_VERSION,
      // Source image path (state.inputImage is the file path string)
      sourceImagePath: typeof state.inputImage === "string" ? state.inputImage : null,
      // Conversion settings
      settings: {
        resizeMethod: document.querySelector("#resize-method")?.value,
        paletteCount: document.querySelector("#palette-count")?.value,
        color0Mode: document.querySelector("#color0-mode")?.value,
        ditherMode: document.querySelector("#dither-mode")?.value,
        ditherSeed: state.seed.toString(),
        backgroundColor: document.querySelector("#background-color")?.value,
        transparency: document.querySelector("#transparency")?.checked,
        keepRatio: document.querySelector("#keep-ratio")?.checked,
        ditherMask: document.querySelector("#dither-mask")?.checked,
        vramAddress: document.querySelector("#vram-address")?.value,
        outputWidthTiles: document.querySelector("#output-width-tiles")?.value,
        outputHeightTiles: document.querySelector("#output-height-tiles")?.value,
        batSize: document.querySelector("#bat-size")?.value,
        offsetX: document.querySelector("#offset-x")?.value,
        offsetY: document.querySelector("#offset-y")?.value,
        batBigEndian: document.querySelector("#bat-big-endian")?.checked,
        palBigEndian: document.querySelector("#pal-big-endian")?.checked,
        tilesBigEndian: document.querySelector("#tiles-big-endian")?.checked,
      },
      // Curve points
      curvePoints: state.curvePoints,
      // Fixed color 0
      fixedColor0: state.fixedColor0,
      // Dithering mask (as base64 data URL)
      ditherMask: null,
      // Palette group assignments
      paletteGroups: null,
    };

    // Save dithering mask if it exists
    if (state.mask.canvas && state.mask.width > 0 && state.mask.height > 0) {
      project.ditherMask = {
        width: state.mask.width,
        height: state.mask.height,
        dataUrl: state.mask.canvas.toDataURL("image/png"),
      };
    }

    // Save palette group assignments if they exist
    if (state.paletteGroups.assignments.length > 0) {
      project.paletteGroups = {
        gridWidth: state.paletteGroups.gridWidth,
        gridHeight: state.paletteGroups.gridHeight,
        assignments: state.paletteGroups.assignments,
      };
    }

    // Save to file via Tauri (use last loaded project path as default)
    const result = await invoke("save_project", {
      content: JSON.stringify(project, null, 2),
      defaultPath: state.projectPath,
    });
    if (result) {
      console.log("Project saved to:", result);
      state.projectPath = result; // Update stored path
      clearProjectDirty();
    }
  } catch (error) {
    console.error("Failed to save project:", error);
    alert("Erreur lors de la sauvegarde du projet: " + error);
  }
}

async function loadProject() {
  try {
    // Suppress dirty marking during project loading
    state.isLoadingProject = true;

    const result = await invoke("load_project");
    if (!result) {
      state.isLoadingProject = false;
      return; // User cancelled
    }

    const [projectPath, content] = result;
    state.projectPath = projectPath; // Store for later use when saving
    const project = JSON.parse(content);

    // Check version compatibility
    if (!project.version || project.version > PROJECT_VERSION) {
      alert("Ce fichier projet est incompatible avec cette version d'Image2PCE II.");
      return;
    }

    // Restore conversion settings
    const s = project.settings;
    if (s) {
      if (s.resizeMethod) {
        const el = document.querySelector("#resize-method");
        if (el) el.value = s.resizeMethod;
      }
      if (s.paletteCount) {
        const el = document.querySelector("#palette-count");
        if (el) el.value = s.paletteCount;
      }
      if (s.color0Mode) {
        const el = document.querySelector("#color0-mode");
        if (el) el.value = s.color0Mode;
      }
      if (s.ditherMode) {
        const el = document.querySelector("#dither-mode");
        if (el) el.value = s.ditherMode;
      }
      if (s.ditherSeed) {
        try {
          state.seed = parseInt(s.ditherSeed, 10) || 0;
          const el = document.querySelector("#dither-seed");
          if (el) el.value = state.seed.toString();
        } catch {
          // Ignore invalid seed
        }
      }
      if (s.backgroundColor) {
        const el = document.querySelector("#background-color");
        if (el) el.value = s.backgroundColor;
      }
      if (s.transparency !== undefined) {
        const el = document.querySelector("#transparency");
        if (el) el.checked = s.transparency;
      }
      if (s.keepRatio !== undefined) {
        const el = document.querySelector("#keep-ratio");
        if (el) el.checked = s.keepRatio;
      }
      if (s.ditherMask !== undefined) {
        const el = document.querySelector("#dither-mask");
        if (el) el.checked = s.ditherMask;
      }
      if (s.vramAddress) {
        const el = document.querySelector("#vram-address");
        if (el) el.value = s.vramAddress;
      }
      if (s.batSize) {
        const el = document.querySelector("#bat-size");
        if (el) el.value = s.batSize;
      }
      // Update constraints before setting width/height
      updateSizeConstraints();
      if (s.outputWidthTiles) {
        const el = document.querySelector("#output-width-tiles");
        if (el) {
          el.value = s.outputWidthTiles;
          document.querySelector("#output-width-value").textContent = `${s.outputWidthTiles} (${s.outputWidthTiles * 8} px)`;
        }
      }
      if (s.outputHeightTiles) {
        const el = document.querySelector("#output-height-tiles");
        if (el) {
          el.value = s.outputHeightTiles;
          document.querySelector("#output-height-value").textContent = `${s.outputHeightTiles} (${s.outputHeightTiles * 8} px)`;
        }
      }
      if (s.offsetX !== undefined) {
        const el = document.querySelector("#offset-x");
        if (el) el.value = s.offsetX;
      }
      if (s.offsetY !== undefined) {
        const el = document.querySelector("#offset-y");
        if (el) el.value = s.offsetY;
      }
      if (s.batBigEndian !== undefined) {
        const el = document.querySelector("#bat-big-endian");
        if (el) el.checked = s.batBigEndian;
      }
      if (s.palBigEndian !== undefined) {
        const el = document.querySelector("#pal-big-endian");
        if (el) el.checked = s.palBigEndian;
      }
      if (s.tilesBigEndian !== undefined) {
        const el = document.querySelector("#tiles-big-endian");
        if (el) el.checked = s.tilesBigEndian;
      }
    }

    // Restore curve points
    if (project.curvePoints && Array.isArray(project.curvePoints)) {
      state.curvePoints = project.curvePoints;
      const curveCtx = document.querySelector("#curve-canvas")?.getContext("2d");
      if (curveCtx) {
        drawCurve(curveCtx);
      }
    }

    // Restore fixed color 0
    if (project.fixedColor0) {
      state.fixedColor0 = project.fixedColor0;
      updateColor0Preview();
    }

    // Load source image if available
    let imageLoaded = false;
    if (project.sourceImagePath) {
      try {
        // Extract the actual file path from the asset URL if needed
        let imagePath = project.sourceImagePath;
        if (imagePath.startsWith("asset://")) {
          // Extract path from asset URL (asset://localhost/path)
          const url = new URL(imagePath);
          imagePath = decodeURIComponent(url.pathname);
        }
        await loadImageFromPath(imagePath);
        imageLoaded = true;
      } catch (e) {
        console.warn("Could not load source image from project:", e);
      }
    }

    // Restore dithering mask (after image is loaded to ensure canvas exists)
    if (project.ditherMask && project.ditherMask.dataUrl && imageLoaded) {
      await new Promise((resolve) => {
        const maskImg = new Image();
        maskImg.onload = () => {
          // The mask canvas should exist after loadImageFromPath
          if (state.mask.canvas && state.mask.ctx) {
            // Clear existing content and history
            state.mask.history = [];
            state.mask.historyIndex = -1;
            // Resize canvas to match saved mask dimensions
            state.mask.canvas.width = project.ditherMask.width;
            state.mask.canvas.height = project.ditherMask.height;
            state.mask.width = project.ditherMask.width;
            state.mask.height = project.ditherMask.height;
            // Draw the loaded mask
            state.mask.ctx.drawImage(maskImg, 0, 0);
            // Save initial state for undo (isLoadingProject still true)
            saveMaskState();
          }
          resolve();
        };
        maskImg.onerror = resolve; // Don't block on error
        maskImg.src = project.ditherMask.dataUrl;
      });
    }

    // Restore palette group assignments (after image is loaded to ensure canvas exists)
    if (project.paletteGroups && project.paletteGroups.assignments && imageLoaded) {
      // Clear existing history
      state.paletteGroups.history = [];
      state.paletteGroups.historyIndex = -1;
      // Restore assignments
      state.paletteGroups.gridWidth = project.paletteGroups.gridWidth;
      state.paletteGroups.gridHeight = project.paletteGroups.gridHeight;
      state.paletteGroups.assignments = project.paletteGroups.assignments;
      // Update canvas dimensions and re-render
      if (state.paletteGroups.canvas) {
        state.paletteGroups.virtualTileWidth = state.mask.width / state.paletteGroups.gridWidth;
        state.paletteGroups.virtualTileHeight = state.mask.height / state.paletteGroups.gridHeight;
        state.paletteGroups.canvas.width = state.mask.width;
        state.paletteGroups.canvas.height = state.mask.height;
        renderPaletteGroupsOverlay();
        savePaletteGroupsState();
      }
    }

    console.log("Project loaded from:", projectPath);
    state.isLoadingProject = false;
    clearProjectDirty();
  } catch (error) {
    state.isLoadingProject = false;
    console.error("Failed to load project:", error);
    alert("Erreur lors du chargement du projet: " + error);
  }
}

// Helper function to load image from path (similar to openImage)
async function loadImageFromPath(imagePath) {
  // Close editors if open
  toggleMaskEditing(false);
  togglePaletteGroupsEditing(false);

  state.inputImage = imagePath;
  const inputMeta = document.querySelector("#input-meta");
  const inputCanvas = document.querySelector("#input-canvas");
  const fileUrl = convertFileSrc(imagePath);

  inputCanvas.innerHTML = `
    <div class="viewer__stage">
      <div class="viewer__image-wrapper">
        <img src="${fileUrl}" alt="source" class="viewer__image" id="source-image" draggable="false" />
        <canvas id="mask-canvas" class="mask-canvas"></canvas>
      </div>
    </div>
    <div id="brush-cursor" class="brush-cursor"></div>
  `;

  return new Promise((resolve) => {
    const sourceImg = document.querySelector("#source-image");
    sourceImg.onload = () => {
      // Extract filename from path and store in state
      const filename = imagePath.split(/[\\/]/).pop();
      const w = sourceImg.naturalWidth;
      const h = sourceImg.naturalHeight;
      state.inputFilename = filename;
      state.inputWidth = w;
      state.inputHeight = h;
      inputMeta.textContent = `${filename} (${w}×${h})`;

      initMaskCanvas(w, h);
      initPaletteGroupsCanvas();
      resolve(sourceImg);
    };
  });
}

// ===== End Project Save/Load =====

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
  const crtMode = document.querySelector("#crt-mode")?.value;

  if (!canvas || !state.originalImageData) return;

  const ctx = canvas.getContext("2d");

  // If no CRT mode, restore original image (no blur)
  if (!crtMode || crtMode === "none") {
    ctx.putImageData(state.originalImageData, 0, 0);
    return;
  }

  // Apply fixed blur (value 4 maps to radius 0.12)
  const blurRadius = (4 / 100) * 3;
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

  const MIN_HEIGHT = 450;
  const MAX_HEIGHT = 1200;

  let isDragging = false;
  let startY = 0;
  let startHeight = 0;

  handle.addEventListener("mousedown", (e) => {
    isDragging = true;
    startY = e.clientY;
    startHeight = viewer.offsetHeight;
    handle.classList.add("is-dragging");
    handle.classList.remove("is-at-limit");
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!isDragging) return;

    const deltaY = e.clientY - startY;
    const rawHeight = startHeight + deltaY;
    const newHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, rawHeight));

    // Visual feedback when hitting limits
    if (rawHeight <= MIN_HEIGHT || rawHeight >= MAX_HEIGHT) {
      handle.classList.add("is-at-limit");
    } else {
      handle.classList.remove("is-at-limit");
    }

    viewer.style.setProperty("--viewer-height", `${newHeight}px`);
  });

  window.addEventListener("mouseup", () => {
    if (isDragging) {
      isDragging = false;
      handle.classList.remove("is-dragging", "is-at-limit");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      saveSettings();
    }
  });
}

function setupViewerSplitter() {
  const viewer = document.querySelector(".viewer");
  const splitter = document.querySelector("#viewer-splitter");
  if (!viewer || !splitter) return;

  let isDragging = false;
  let startX = 0;
  let startLeftWidth = 0;

  splitter.addEventListener("mousedown", (e) => {
    isDragging = true;
    startX = e.clientX;
    const leftPanel = viewer.querySelector(".viewer__panel");
    startLeftWidth = leftPanel ? leftPanel.offsetWidth : viewer.offsetWidth / 2;
    splitter.classList.add("is-dragging");
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!isDragging) return;

    const viewerRect = viewer.getBoundingClientRect();
    const viewerWidth = viewerRect.width;
    const deltaX = e.clientX - startX;
    const newLeftWidth = startLeftWidth + deltaX;

    // Calculate percentage (min 20%, max 80%)
    const leftPercent = Math.max(20, Math.min(80, (newLeftWidth / viewerWidth) * 100));
    const rightPercent = 100 - leftPercent;

    viewer.style.setProperty("--viewer-split", `${leftPercent}fr`);
    viewer.style.setProperty("--viewer-split-right", `${rightPercent}fr`);
  });

  window.addEventListener("mouseup", () => {
    if (isDragging) {
      isDragging = false;
      splitter.classList.remove("is-dragging");
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

function applyViewerSplit(leftPercent) {
  const viewer = document.querySelector(".viewer");
  if (viewer && leftPercent) {
    const rightPercent = 100 - leftPercent;
    viewer.style.setProperty("--viewer-split", `${leftPercent}fr`);
    viewer.style.setProperty("--viewer-split-right", `${rightPercent}fr`);
  }
}

// ===== End Viewer Resize =====

function bindActions() {
  document.querySelector("#open-image").addEventListener("click", openImage);
  document.querySelector("#load-project").addEventListener("click", loadProject);
  document.querySelector("#save-project").addEventListener("click", saveProject);
  document.querySelector("#run-conversion").addEventListener("click", runConversion);
  document.querySelector("#zoom-input").addEventListener("input", () => applyZoom("input"));
  document.querySelector("#zoom-output").addEventListener("input", () => applyZoom("output"));
  setupDrag("input");
  setupDrag("output");
  document.querySelector("#save-binaries").addEventListener("click", exportBinaries);
  document.querySelector("#save-text").addEventListener("click", exportPlainText);
  document.querySelector("#save-html-report").addEventListener("click", exportHtmlReport);

  // Color0 mode change
  document.querySelector("#color0-mode").addEventListener("change", updateColor0Preview);

  // Seed controls
  const seedInput = document.querySelector("#dither-seed");
  if (seedInput) {
    // Initialize seed display from state
    seedInput.value = state.seed.toString();
    seedInput.addEventListener("change", (e) => {
      const val = parseInt(e.target.value, 10);
      state.seed = isNaN(val) ? 0 : Math.abs(val) % Number.MAX_SAFE_INTEGER;
      e.target.value = state.seed.toString();
    });
  }
  document.querySelector("#randomize-seed")?.addEventListener("click", () => {
    state.seed = (Date.now() ^ Math.floor(Math.random() * 1000000)) % Number.MAX_SAFE_INTEGER;
    const seedInput = document.querySelector("#dither-seed");
    if (seedInput) seedInput.value = state.seed.toString();
  });

  // BAT size and output size controls
  document.querySelector("#bat-size")?.addEventListener("change", updateSizeConstraints);
  document.querySelector("#output-width-tiles")?.addEventListener("input", (e) => {
    const tiles = e.target.value;
    document.querySelector("#output-width-value").textContent = `${tiles} (${tiles * 8} px)`;
    updateSizeConstraints();
  });
  document.querySelector("#output-height-tiles")?.addEventListener("input", (e) => {
    const tiles = e.target.value;
    document.querySelector("#output-height-value").textContent = `${tiles} (${tiles * 8} px)`;
    updateSizeConstraints();
  });
  document.querySelector("#offset-x")?.addEventListener("input", updateSizeConstraints);
  document.querySelector("#offset-y")?.addEventListener("input", updateSizeConstraints);

  // Initialize size constraints on load
  updateSizeConstraints();

  // Mask editor controls
  document.querySelector("#mask-toggle")?.addEventListener("click", () => {
    toggleMaskEditing(!state.mask.isEditing);
  });
  document.querySelector("#mask-brush")?.addEventListener("click", () => {
    setMaskTool("brush");
  });
  document.querySelector("#mask-eraser")?.addEventListener("click", () => {
    setMaskTool("eraser");
  });
  document.querySelector("#mask-circle")?.addEventListener("click", () => {
    setMaskTool("circle");
  });
  document.querySelector("#mask-circle")?.addEventListener("dblclick", () => {
    toggleShapeFillMode();
  });
  document.querySelector("#mask-rectangle")?.addEventListener("click", () => {
    setMaskTool("rectangle");
  });
  document.querySelector("#mask-rectangle")?.addEventListener("dblclick", () => {
    toggleShapeFillMode();
  });
  document.querySelector("#mask-polygon")?.addEventListener("click", () => {
    setMaskTool("polygon");
  });
  document.querySelector("#mask-polygon")?.addEventListener("dblclick", () => {
    toggleShapeFillMode();
  });
  document.querySelector("#mask-brush-size")?.addEventListener("input", (e) => {
    state.mask.brushSize = Number(e.target.value);
    document.querySelector("#mask-brush-size-value").textContent = e.target.value;
  });
  document.querySelector("#mask-clear-white")?.addEventListener("click", () => {
    clearMask("#FFFFFF");
    saveMaskState();
  });
  document.querySelector("#mask-fill-black")?.addEventListener("click", () => {
    clearMask("#000000");
    saveMaskState();
  });
  document.querySelector("#mask-invert")?.addEventListener("click", () => {
    invertMask();
    saveMaskState();
  });
  document.querySelector("#mask-undo")?.addEventListener("click", () => {
    undoMask();
  });
  document.querySelector("#mask-redo")?.addEventListener("click", () => {
    redoMask();
  });

  // Tile editor controls
  document.querySelector("#tile-editor-toggle")?.addEventListener("click", () => {
    toggleTileEditing(!state.tileEditor.isEditing);
  });
  document.querySelector("#tile-editor-brush")?.addEventListener("click", () => {
    setTileEditorTool("brush");
  });
  document.querySelector("#tile-editor-select")?.addEventListener("click", () => {
    setTileEditorTool("select");
  });
  document.querySelector("#tile-editor-undo")?.addEventListener("click", () => {
    undoTileEditor();
  });
  document.querySelector("#tile-editor-redo")?.addEventListener("click", () => {
    redoTileEditor();
  });

  // Tile editor drawing events - attached to container which doesn't change
  const outputContainer = document.querySelector("#output-canvas");
  if (outputContainer) {
    outputContainer.addEventListener("mousedown", startTileEditorDraw);
    outputContainer.addEventListener("mousemove", drawTileEditorPixel);
    outputContainer.addEventListener("mouseup", stopTileEditorDraw);
    outputContainer.addEventListener("mouseleave", stopTileEditorDraw);

    // Context menu for tile conversion
    outputContainer.addEventListener("contextmenu", (e) => {
      if (!state.tileEditor.isEditing) return;
      if (state.tileEditor.tool !== "brush") return;

      e.preventDefault();
      const result = getTileAndPixelFromEvent(e);
      if (result.tileIndex === -1) return;
      if (state.emptyTiles[result.tileIndex]) return;

      state.tileEditor.contextMenuTileIndex = result.tileIndex;
      showTileContextMenu(e.clientX, e.clientY);
    });
  }

  // Close context menu on click outside
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#tile-context-menu")) {
      hideTileContextMenu();
    }
  });

  // Context menu: Convert to palette button
  document.querySelector("#convert-to-palette-btn")?.addEventListener("click", () => {
    showPaletteSelector();
  });

  // Palette selector: Cancel button
  document.querySelector("#palette-selector-cancel")?.addEventListener("click", () => {
    hidePaletteSelector();
  });

  // About modal
  document.querySelector("#about-btn")?.addEventListener("click", async () => {
    // Fetch version from Tauri
    try {
      const version = await window.__TAURI__.app.getVersion();
      const versionEl = document.querySelector("#about-version");
      if (versionEl) versionEl.textContent = version;
    } catch (e) {
      console.warn("Could not fetch app version:", e);
    }
    document.querySelector("#about-modal")?.classList.add("is-visible");
  });
  document.querySelector("#about-close")?.addEventListener("click", () => {
    document.querySelector("#about-modal")?.classList.remove("is-visible");
  });
  document.querySelector("#about-modal")?.addEventListener("click", (e) => {
    if (e.target.id === "about-modal") {
      document.querySelector("#about-modal")?.classList.remove("is-visible");
    }
  });

  // Keyboard shortcuts for mask editing and tile editing
  document.addEventListener("keydown", (e) => {
    // Ignore shortcuts when typing in input fields
    const isInputFocused = document.activeElement?.tagName === "INPUT" ||
                           document.activeElement?.tagName === "TEXTAREA" ||
                           document.activeElement?.tagName === "SELECT";

    // Project shortcuts (Ctrl+S = Save, Ctrl+Shift+O = Load)
    if (!isInputFocused && (e.ctrlKey || e.metaKey)) {
      if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        saveProject();
        return;
      }
      if (e.shiftKey && (e.key === "o" || e.key === "O")) {
        e.preventDefault();
        loadProject();
        return;
      }
    }

    // Tile editor shortcuts (priority over mask editor when active)
    if (state.tileEditor.isEditing) {
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undoTileEditor();
        return;
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
        e.preventDefault();
        redoTileEditor();
        return;
      } else if (e.key === "x" || e.key === "X") {
        // Toggle between brush and select
        e.preventDefault();
        const newTool = state.tileEditor.tool === "brush" ? "select" : "brush";
        setTileEditorTool(newTool);
        return;
      }
    }

    // Mask editor shortcuts
    if (state.mask.isEditing) {
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undoMask();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
        e.preventDefault();
        redoMask();
      } else if (e.key === "x" || e.key === "X") {
        // Toggle between brush and eraser
        e.preventDefault();
        const newTool = state.mask.tool === "brush" ? "eraser" : "brush";
        setMaskTool(newTool);
      }
    }

    // Palette groups editor shortcuts
    if (state.paletteGroups.isEditing) {
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undoPaletteGroups();
        return;
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
        e.preventDefault();
        redoPaletteGroups();
        return;
      } else if (e.key === "x" || e.key === "X") {
        // Toggle between brush and eraser
        e.preventDefault();
        const newTool = state.paletteGroups.tool === "brush" ? "eraser" : "brush";
        state.paletteGroups.tool = newTool;
        document.querySelector("#pg-brush")?.classList.toggle("is-active", newTool === "brush");
        document.querySelector("#pg-eraser")?.classList.toggle("is-active", newTool === "eraser");
        return;
      } else if (/^[0-9a-f]$/i.test(e.key)) {
        // Quick group selection with 0-9, a-f
        e.preventDefault();
        const group = parseInt(e.key, 16);
        selectPaletteGroup(group);
        return;
      }
    }
  });

  // CRT mode change
  document.querySelector("#crt-mode")?.addEventListener("change", (e) => {
    applyCrtMode(e.target.value);
  });

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

  // Setup viewer resize and splitter
  setupViewerResize();
  setupViewerSplitter();

  // Setup palette groups editor
  setupPaletteGroupsEventListeners();

  // Setup auto-save for settings
  setupSettingsAutoSave();

  // Setup endianness reset button
  document.querySelector("#endian-reset")?.addEventListener("click", () => {
    // Default values: BAT=little, Tiles=big, Pal=little
    const batEl = document.querySelector("#bat-big-endian");
    const palEl = document.querySelector("#pal-big-endian");
    const tilesEl = document.querySelector("#tiles-big-endian");
    if (batEl) batEl.checked = false;
    if (palEl) palEl.checked = false;
    if (tilesEl) tilesEl.checked = true;
    saveSettings();
  });
});
