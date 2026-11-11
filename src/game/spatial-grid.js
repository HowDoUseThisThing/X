const byEnemyOrder = (a, b) => a - b;

// Store each enemy's center once. Expanding queries by the largest enemy
// radius covers cell boundaries and arbitrarily large circles without filling
// thousands of buckets for a single large enemy.
export class SpatialGrid {
  constructor(cellSize = 64) {
    this.cellSize = cellSize;
    this.rows = new Map();
    this.rowPool = [];
    this.bucketPool = [];
    this.rowCount = 0;
    this.bucketCount = 0;
    this.items = [];
    this.removed = new Set();
    this.candidates = [];
    this.maxRadius = 0;
  }

  clear() {
    for (let i = 0; i < this.rowCount; i += 1) this.rowPool[i].clear();
    for (let i = 0; i < this.bucketCount; i += 1) this.bucketPool[i].length = 0;
    this.rows.clear();
    this.rowCount = 0;
    this.bucketCount = 0;
    this.items.length = 0;
    this.removed.clear();
    this.candidates.length = 0;
    this.maxRadius = 0;
  }

  rebuild(enemies) {
    this.clear();
    for (let i = 0; i < enemies.length; i += 1) {
      const enemy = enemies[i];
      this.items.push(enemy);
      this.maxRadius = Math.max(this.maxRadius, enemy.radius);
      const x = Math.floor(enemy.x / this.cellSize);
      const y = Math.floor(enemy.y / this.cellSize);
      let row = this.rows.get(y);
      if (!row) {
        row = this.rowPool[this.rowCount] ??= new Map();
        this.rowCount += 1;
        this.rows.set(y, row);
      }
      let bucket = row.get(x);
      if (!bucket) {
        bucket = this.bucketPool[this.bucketCount] ??= [];
        this.bucketCount += 1;
        row.set(x, bucket);
      }
      bucket.push(i);
    }
  }

  remove(enemy) {
    if (this.items.length) this.removed.add(enemy);
  }

  collect(bucket) {
    for (const index of bucket) {
      if (!this.removed.has(this.items[index])) this.candidates.push(index);
    }
  }

  // Returns a reused array of indices into items, ordered like the original
  // enemy array even when killEnemy splices the live array during this frame.
  query(x, y, radius) {
    this.candidates.length = 0;
    const reach = radius + this.maxRadius;
    const minX = Math.floor((x - reach) / this.cellSize);
    const maxX = Math.floor((x + reach) / this.cellSize);
    const minY = Math.floor((y - reach) / this.cellSize);
    const maxY = Math.floor((y + reach) / this.cellSize);

    // A huge radius or sparse layout must not cause an enormous empty-cell
    // walk. Visit occupied buckets instead when that costs less.
    if ((maxX - minX + 1) * (maxY - minY + 1) > this.bucketCount) {
      for (const [cy, row] of this.rows) {
        if (cy < minY || cy > maxY) continue;
        for (const [cx, bucket] of row) {
          if (cx >= minX && cx <= maxX) this.collect(bucket);
        }
      }
    } else {
      for (let cy = minY; cy <= maxY; cy += 1) {
        const row = this.rows.get(cy);
        if (!row) continue;
        for (let cx = minX; cx <= maxX; cx += 1) {
          const bucket = row.get(cx);
          if (bucket) this.collect(bucket);
        }
      }
    }
    this.candidates.sort(byEnemyOrder);
    return this.candidates;
  }
}
