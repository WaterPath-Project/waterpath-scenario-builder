const BLEND_RADIUS_CELLS = 2;

function smoothBand(rows, noDataValue, radius, logarithmic) {
  const height = rows.length;
  const width = rows[0]?.length || 0;
  const valid = (value) => Number.isFinite(value)
    && value !== noDataValue
    && (!logarithmic || value > 0);
  const toWorking = logarithmic ? Math.log10 : (value) => value;
  const fromWorking = logarithmic ? (value) => 10 ** value : (value) => value;
  const horizontal = Array.from({ length: height }, () => new Float64Array(width).fill(Number.NaN));

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      if (!valid(rows[row][col])) continue;
      let weightedSum = 0;
      let weightTotal = 0;
      for (let offset = -radius; offset <= radius; offset++) {
        const sourceCol = col + offset;
        if (sourceCol < 0 || sourceCol >= width) continue;
        const value = rows[row][sourceCol];
        if (!valid(value)) continue;
        const weight = radius + 1 - Math.abs(offset);
        weightedSum += toWorking(value) * weight;
        weightTotal += weight;
      }
      horizontal[row][col] = weightedSum / weightTotal;
    }
  }

  return rows.map((sourceRow, row) => {
    const output = new Float64Array(width);
    for (let col = 0; col < width; col++) {
      if (!valid(sourceRow[col])) {
        output[col] = sourceRow[col];
        continue;
      }
      let weightedSum = 0;
      let weightTotal = 0;
      for (let offset = -radius; offset <= radius; offset++) {
        const sourceRowIndex = row + offset;
        if (sourceRowIndex < 0 || sourceRowIndex >= height) continue;
        const value = horizontal[sourceRowIndex][col];
        if (!Number.isFinite(value)) continue;
        const weight = radius + 1 - Math.abs(offset);
        weightedSum += value * weight;
        weightTotal += weight;
      }
      output[col] = fromWorking(weightedSum / weightTotal);
    }
    return output;
  });
}

export function blendRasterForDisplay(georaster, { logarithmic = false } = {}) {
  if (!georaster.values?.length) return georaster;
  return {
    ...georaster,
    values: georaster.values.map((band) => smoothBand(
      band,
      georaster.noDataValue,
      BLEND_RADIUS_CELLS,
      logarithmic,
    )),
  };
}