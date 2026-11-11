export function mulberry32(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const distance = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
export const normalize = (x, y) => {
  const length = Math.hypot(x, y);
  return length > 1e-8 ? { x: x / length, y: y / length } : { x: 0, y: 0 };
};
