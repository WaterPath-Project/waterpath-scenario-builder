function visitPolygonRings(geojson, visitor) {
  if (!geojson) return;
  if (geojson.type === 'FeatureCollection') {
    geojson.features?.forEach(feature => visitPolygonRings(feature, visitor));
    return;
  }
  if (geojson.type === 'Feature') {
    visitPolygonRings(geojson.geometry, visitor);
    return;
  }
  if (geojson.type === 'GeometryCollection') {
    geojson.geometries?.forEach(geometry => visitPolygonRings(geometry, visitor));
    return;
  }
  if (geojson.type === 'Polygon') {
    visitor(geojson.coordinates);
    return;
  }
  if (geojson.type === 'MultiPolygon') {
    geojson.coordinates?.forEach(visitor);
  }
}

function clipTileToGeoJson(tile, coords, map, geojson, tileSize) {
  const context = tile.getContext?.('2d');
  if (!context || !coords) return;

  const marginLeft = Number.parseFloat(tile.style.marginLeft) || 0;
  const marginTop = Number.parseFloat(tile.style.marginTop) || 0;
  const cssWidth = Number.parseFloat(tile.style.width) || tile.width;
  const cssHeight = Number.parseFloat(tile.style.height) || tile.height;
  const originX = coords.x * tileSize.x + marginLeft;
  const originY = coords.y * tileSize.y + marginTop;
  const scaleX = tile.width / cssWidth;
  const scaleY = tile.height / cssHeight;

  context.save();
  context.globalCompositeOperation = 'destination-in';
  context.beginPath();

  visitPolygonRings(geojson, polygonRings => {
    polygonRings?.forEach(ring => {
      ring?.forEach(([longitude, latitude], index) => {
        const point = map.project([latitude, longitude], coords.z);
        const x = (point.x - originX) * scaleX;
        const y = (point.y - originY) * scaleY;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.closePath();
    });
  });

  context.fillStyle = '#fff';
  context.fill('evenodd');
  context.restore();
}

export function configureRasterTileRendering(layer, {
  map,
  geojson,
  clipToAreas = false,
  imageRendering,
}) {
  if (!imageRendering && !(clipToAreas && geojson)) return;

  layer.on('tileload', event => {
    if (imageRendering && event.tile) {
      event.tile.style.imageRendering = imageRendering;
    }
    if (clipToAreas && geojson && event.tile) {
      clipTileToGeoJson(event.tile, event.coords, map, geojson, layer.getTileSize());
    }
  });
}
