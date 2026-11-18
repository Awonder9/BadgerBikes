// Marker images for saved places (Home, Work, favorites): a colored disc with a white icon, drawn on a
// canvas and registered with map.addImage. Re-added after every style change (setStyle drops images).
import type { Map as MlMap } from 'maplibre-gl'
import { SAVED_MARKER } from './colors'

/** Same 24×24 outlines as src/ui/primitives/Icon.tsx. */
const PATHS = {
  home: 'M3 11 12 4l9 7M5 10v10h5v-6h4v6h5V10',
  work: 'M4 8h16v12H4V8Zm5 0V5h6v3',
  star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9L12 3Z',
} as const

export type SavedIcon = keyof typeof PATHS

export const savedImageId = (icon: SavedIcon) => `bc-saved-${icon}`

/** CSS pixels; drawn at 2× for sharp markers on phones. */
const SIZE = 30
const RATIO = 2

function drawMarker(icon: SavedIcon): ImageData | null {
  const px = SIZE * RATIO
  const canvas = document.createElement('canvas')
  canvas.width = px
  canvas.height = px
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.scale(RATIO, RATIO)
  // Disc with a white outline, like the station circles.
  ctx.beginPath()
  ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 2, 0, Math.PI * 2)
  ctx.fillStyle = SAVED_MARKER[icon]
  ctx.fill()
  ctx.lineWidth = 2.5
  ctx.strokeStyle = SAVED_MARKER.outline
  ctx.stroke()
  // The 24×24 icon scaled to 16 px, centered.
  const scale = 16 / 24
  ctx.translate((SIZE - 16) / 2, (SIZE - 16) / 2)
  ctx.scale(scale, scale)
  const path = new Path2D(PATHS[icon])
  ctx.strokeStyle = '#ffffff'
  ctx.fillStyle = '#ffffff'
  ctx.lineWidth = 2.4
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  // oxlint-disable-next-line unicorn/no-array-fill-with-reference-type -- CanvasRenderingContext2D.fill, not Array.fill
  if (icon === 'star') ctx.fill(path)
  ctx.stroke(path)
  return ctx.getImageData(0, 0, px, px)
}

export function addSavedIcons(map: MlMap): void {
  for (const icon of Object.keys(PATHS) as SavedIcon[]) {
    const id = savedImageId(icon)
    if (map.hasImage(id)) continue
    const img = drawMarker(icon)
    if (img) map.addImage(id, img, { pixelRatio: RATIO })
  }
}
