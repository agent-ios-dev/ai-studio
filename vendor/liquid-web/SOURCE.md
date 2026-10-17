# Liquid Web

Source: https://github.com/winaviation/liquid-web
Revision: `8661faf0ad30ebd66437bab28b1ac209b9ff531f`

`lg-component.js` is the upstream static Liquid Glass custom element, downloaded
on 2026-10-17. Copyright (c) 2026 wings; distributed under the included MIT LICENSE.
The upstream refraction and specular map implementation is unmodified.

AI Studio integration lives in `/liquid-glass.js` and `styles.css`: decorative
layers preserve the existing controls, ResizeObserver keeps the optics aligned
with each surface, and dimensions are batched before recalculating the maps.
Maps are generated locally with Canvas, then used by an SVG displacement filter
on the backdrop. No user data is sent to Liquid Web or a CDN.

Upstream supports SVG backdrop refraction in Chromium. Other engines use the
component's blur fallback. Reduced transparency and forced colors use a solid
surface. The visual layers never receive pointer input or accessibility focus.
