import { clamp } from "../core/math.js";

export const WORLD = Object.freeze({ width: 3200, height: 2200 });

export function clampToWorld(x, y, padding = 0, world = WORLD) {
  const halfWidth = world.width / 2;
  const halfHeight = world.height / 2;
  const px = clamp(padding, 0, halfWidth);
  const py = clamp(padding, 0, halfHeight);
  return {
    x: clamp(x, -halfWidth + px, halfWidth - px),
    y: clamp(y, -halfHeight + py, halfHeight - py),
  };
}

export function isInsideWorld(x, y, padding = 0, world = WORLD) {
  const point = clampToWorld(x, y, padding, world);
  return point.x === x && point.y === y;
}

export function getCameraCenter(x, y, viewportWidth, viewportHeight, world = WORLD) {
  const width = Math.max(1, Number(viewportWidth) || 0);
  const height = Math.max(1, Number(viewportHeight) || 0);
  const limitX = Math.max(0, world.width / 2 - width / 2);
  const limitY = Math.max(0, world.height / 2 - height / 2);
  return {
    x: clamp(x, -limitX, limitX),
    y: clamp(y, -limitY, limitY),
  };
}
