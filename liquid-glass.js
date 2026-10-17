import "./vendor/liquid-web/lg-component.js";

// Keep the original form controls and dialog semantics outside the decorative glass.
const surfaces = document.querySelectorAll(".composer, .model-menu, .settings-dialog, .search-dialog, .topbar .mobile-menu, .topbar .top-new-chat");
for (const surface of surfaces) {
  surface.classList.add("liquid-surface");
  const glass = document.createElement("liquid-glass");
  glass.className = "liquid-surface-optics";
  glass.setAttribute("aria-hidden", "true");
  glass.setAttribute("flex-center", "false");
  glass.setAttribute("blur", "0.35");
  glass.setAttribute("fallback-blur", "16");
  glass.setAttribute("bezel-width", "18");
  glass.setAttribute("glass-thickness", "100");
  glass.setAttribute("refraction-scale", "1.5");
  glass.setAttribute("specular-opacity", "0.3");
  glass.setAttribute("tint", surface.matches(".composer") ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.3)");
  // A hidden menu/dialog will get its first map only when opened.
  glass.setAttribute("width", "1");
  glass.setAttribute("height", "1");
  surface.prepend(glass);
  let lastSize = "";
  let timer;
  const resize = () => {
    if (!surface.isConnected || surface.getClientRects().length === 0) return;
    const width = Math.round(surface.clientWidth), height = Math.round(surface.clientHeight);
    if (!width || !height) return;
    const radius = Math.min(parseFloat(getComputedStyle(surface).borderTopLeftRadius) || 20, width / 2, height / 2);
    const size = `${width}:${height}:${radius}`;
    if (lastSize === size) return;
    lastSize = size;
    // Batch dimensions: upstream otherwise recalculates both maps for each attribute.
    glass.CONFIG.isInitialized = false;
    glass.setAttribute("width", String(width));
    glass.setAttribute("height", String(height));
    glass.setAttribute("radius", String(radius));
    glass.setAttribute("bezel-width", String(Math.min(18, radius, height / 3)));
    glass.init();
  };
  new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(resize, 80);
  }).observe(surface);
  // Model options are rendered again after connection and model changes.
  new MutationObserver(() => {
    if (!surface.contains(glass)) surface.prepend(glass);
  }).observe(surface, { childList: true });
  resize();
}

// Reserve scrollable space for the floating composer, including growing drafts
// and attachments, so the last message can still be read above it.
const composerArea = document.querySelector(".composer-area");
const conversation = document.getElementById("conversation");
new ResizeObserver(() => {
  const atBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 3;
  composerArea.closest(".main-panel").style.setProperty("--composer-height", `${Math.ceil(composerArea.getBoundingClientRect().height)}px`);
  if (atBottom) requestAnimationFrame(() => { conversation.scrollTop = conversation.scrollHeight; });
}).observe(composerArea);
