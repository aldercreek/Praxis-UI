# Praxis outline icons

Original SVG geometry designed for Praxis, using the approved WorkBuddy-inspired
outline style. No WorkBuddy assets or third-party icon paths are included.

`praxis-outline.json` is the source of truth. Each named icon contains a 24 × 24
viewBox and a self-contained SVG body: 1.7-unit strokes, round caps and joins,
curved corners, and `currentColor`. Stop, reorder dots and the selected bookmark
use solid fills. Keep the approved geometry and proportions when extending this
family; do not override its strokes or fills globally.

`src/renderer/src/icons.tsx` supplies the shared React components. Queue actions
and composer controls use 20px icons, sidebar actions 18px, and dense tool rows
16px. Small disclosures and status marks use 12–14px. Interaction slots center
the SVG independently of text baselines. File changes use the common document
icon with their existing text label, avoiding crowded symbols inside a page.
