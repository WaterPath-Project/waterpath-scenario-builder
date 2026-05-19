# Hydrology Map — Architecture & Features

The hydrology map lives inside the `HydrologyMapSection` component
(`webapp/frontend/src/components/ResultsView.jsx`). It shows:

1. A Leaflet basemap (CartoDB Light)
2. A GeoTIFF raster overlay (pathogen loads or concentration)
3. Admin-area boundary outlines
4. Optional **Flow** overlay — river lines + direction arrows

---

## Layer Stack

Layers are stacked using Leaflet panes. Higher z-index = drawn on top.

| z-index | Pane | What's in it |
|---------|------|--------------|
| 200 | `tilePane` | CartoDB basemap (land, roads) |
| 400 | `overlayPane` | Scenario GeoTIFF raster |
| 450 | `polygonPane` | Admin boundary GeoJSON |
| 540 | `waterPane` | Second basemap copy — only shown with Flow on; uses `mix-blend-mode: multiply` so water bodies (lakes, rivers) show through the raster |
| 550 | `riverPane` | River network lines (`HydrologyRiverLayer`) |
| 590 | *(canvas)* | Flow-direction arrows (`FlowArrowLayer`) — see note below |
| 600 | `labelsPane` | Place-name labels; `pointer-events: none` |

**Why the arrow canvas is not in a pane:** Leaflet applies CSS `transform: translate(…)` to panes during pan/zoom. If the canvas lived in a pane, every arrow coordinate would be shifted twice — once by the pane transform, once by the `latLngToContainerPoint` math. Instead, the canvas is attached directly to `map.getContainer()`.

---

## Water Overlay (`waterPane`)

The scenario raster covers the entire bounding box, which hides lakes and rivers that are nodata in the model (e.g. Lake Kyoga). The `waterPane` tile layer fixes this:

- **Land pixels** in CartoDB Light are near-white (~0.97 brightness). Multiplying by ~0.97 barely changes the raster colour beneath.
- **Water pixels** are light blue (~`rgb(168,212,230)`). Over transparent raster cells, the blue shows through fully. Over land cells, a slight blue tint appears.

Net effect: water bodies remain visually distinct even when the raster covers the region.

---

## Flow Toggle

Enabling Flow renders three things simultaneously:

```
<TileLayer pane="waterPane" />      ← water-body fix (see above)
<HydrologyRiverLayer />             ← river network lines
<FlowArrowLayer />                  ← D8 direction arrows
```

All three remount automatically when the selected month changes.

---

## `HydrologyRiverLayer` — River Lines

**Endpoint:** `GET /api/scenarios/<id>/hydrology-river-lines?month=<month>`

Draws a line from each raster cell to the centre of its downstream neighbour.
Only cells above a minimum accumulation threshold are shown (default: top 95% by
accumulation, i.e. `min_acc_pct=5`). Lines are coloured and weighted on a log
scale: light teal for headwaters, dark teal for trunk rivers.

The backend reads `routing/flowdir.tif` and `routing/flowacc.tif`, auto-detects
the D8 encoding (see below), and returns a GeoJSON `FeatureCollection` of
`LineString` features, capped at 8 000 features (highest accumulation first).

---

## `FlowArrowLayer` — Direction Arrows

**Endpoint:** `GET /api/scenarios/<id>/hydrology-flow-vectors?month=<month>`

Draws one arrow per raster cell, pointing **downstream** (in the direction water
flows out of that cell). Arrow appearance scales with the river's size:

| Visual property | Encodes |
|-----------------|---------|
| Arrow colour (dark → light teal) | Discharge (m³/s), log scale |
| Line weight (thin → thick) | Flow accumulation, log scale |
| Arrow size | Cell's geographic footprint (~75% of cell width) |

The response JSON includes an `encoding` field (`"esri"` or `"taudem"`) — visible
in the browser console and DevTools Network tab — confirming which D8 convention
was detected.

### D8 direction encoding

Flow-direction rasters store one integer per cell indicating which of the 8
neighbours water drains into. Two conventions exist:

| Convention | Values | Used by |
|-----------|--------|---------|
| **TauDEM** | 1=E, 2=NE, 3=N, 4=NW, 5=W, 6=SW, 7=S, 8=SE | GloWPa (all current datasets) |
| **ESRI** | Powers of 2: 1=E, 2=SE, 4=S, 8=SW, 16=W, 32=NW, 64=N, 128=NE | ArcGIS / older datasets |

Auto-detection uses the full set of unique values in the raster: if values like
3, 5, 6, or 7 appear → TauDEM; if values like 16, 32, 64, or 128 appear → ESRI;
otherwise defaults to ESRI. Float32 rasters (integer codes stored as floats due
to resampling) are rounded before lookup.

**Note on apparent flow direction:** arrows may appear to point away from the
nearest ocean coastline. This is correct — many model domains drain into inland
features (Lake Victoria, the Danube, Lake Kyoga) rather than directly to the sea.
Check that arrows follow visible river channels and point from narrow headwaters
toward the main river trunk.

---

## Discharge vs Concentration

```
C = L / Q
```

`C` = pathogen concentration (oocysts/L), `L` = load (oocysts/s), `Q` = discharge (m³/s).

High discharge in wet months dilutes the load → low concentration. Low discharge in the dry season → same load produces much higher concentration. WaterPath tracks both: loads show the absolute hazard; concentration shows the drinking-water exposure risk.

---

## Key Files

| File | Role |
|------|------|
| `webapp/frontend/src/components/ResultsView.jsx` | All map components and state |
| `webapp/backend/hydrology.py` | All hydrology API endpoints |
| `webapp/backend/app.py` | Route registration (calls `hydrology.register_routes`) |
