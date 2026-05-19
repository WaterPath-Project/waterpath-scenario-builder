# Backend Architecture

The original `app.py` monolith (~5 300 lines) has been split into focused modules that live in `webapp/backend/`. The entry point is a slim `app.py` that wires everything together.

---

## Module overview

| File | Responsibility |
|------|---------------|
| `state.py` | Flask apps, SocketIO, Docker client, all constants, mutable globals |
| `fs_utils.py` | Filesystem / CSV / TIF helpers; scenario locator; readiness check |
| `scenario.py` | Scenario CRUD, isodata, treatment, geodata, fractions, input raster |
| `case_study.py` | Case-study CRUD, ZIP upload, datapackage, SPA catch-all |
| `livestock.py` | Livestock module detection, CSV/TIF endpoints |
| `hydrology.py` | Hydrology module detection, metrics endpoints |
| `data.py` | Data-service projection helper (`apply_projections_to_scenario`) — no routes |
| `glowpa.py` | YAML config generation, R expression builders, Docker model run, pathogens cache |
| `analytics.py` | Analytics, driver-comparison, narrative endpoints |
| `results.py` | Output rasters, raster-diff (EPSG:3857), PNG colour ramps, output CSV |
| `session.py` | Metrics summary and activity feed |
| `app.py` | Entry point: registers all route modules, starts both Flask servers |

---

## Two Flask apps in one process

The application intentionally runs two Flask apps in the same process:

| App object | Port | Purpose |
|------------|------|---------|
| `state.app` | 5000 | Backend API — consumed by Vite dev proxy and `curl` testing |
| `state.frontend_app` | 3000 | Frontend — serves the built React SPA and mirrors all API routes |

Both apps share the same handler functions. SocketIO is attached to `state.app` only.

### Why two apps?
The React dev server proxies `/api` to port 5000. Production runs on port 3000. Mirroring all routes on both apps means the same code works in both setups without any proxy at all.

---

## Route registration pattern

No module uses `@app.route` decorators. Instead, every module exposes:

```python
def register_routes(app, frontend_app):
    app.add_url_rule('/api/...', endpoint='main_<name>', view_func=fn, methods=[...])
    frontend_app.add_url_rule('/api/...', endpoint='frontend_<name>', view_func=fn, methods=[...])
```

Endpoint names must be unique per app. Where the same URL rule needs different HTTP methods (e.g. `GET /api/scenarios` and `POST /api/scenarios`), the method is appended to the endpoint name:

```python
endpoint=f'main_{view.__name__}_{methods[0]}'
```

### Registration order matters

`case_study.register_routes` **must be called last** on `frontend_app` because it adds the SPA catch-all:

```python
frontend_app.add_url_rule('/<path:path>', endpoint='frontend_serve_static_files', ...)
```

Flask matches rules in registration order; registering this before any API rule would swallow all API traffic.

`app.py` respects this:

```python
for mod in (scenario, livestock, hydrology, glowpa, analytics, results, session):
    mod.register_routes(state.app, state.frontend_app)

case_study.register_routes(state.app, state.frontend_app)   # LAST
```

---

## Shared mutable state

All mutable globals live in `state.py`. Modules access them via `import state` then `state.<name>`:

```python
state.case_studies   # list[dict] — in-memory case study registry
state.scenarios      # list[dict] — legacy in-memory cache
state.model_runs     # dict: run_id → run-status dict
state.glowpa_running # bool
state._pathogens_cache  # list[dict] | None
```

**Mutation rules:**
- Rebind a scalar: `state.glowpa_running = True`
- Rebind a list: `state.scenarios = [s for s in state.scenarios if ...]`
- Mutate in place: `state.case_studies.append(cs)` or `state.case_studies.clear()`

---

## Intentional behavioural differences between the two apps

`glowpa.py` preserves a legacy split in the stop-GloWPa endpoint:

| App | `/api/glowpa/stop` handler | What it does |
|-----|---------------------------|-------------|
| `frontend_app` (port 3000) | `stop_glowpa_frontend` | Actually `docker stop glowpa-container` |
| `app` (port 5000) | `stop_glowpa_main` | Writes a command to `/app/data/docker_commands.txt` (legacy interface) |

Do not unify these — both behaviours are intentional.

---

## Import cycle avoidance

Some cross-module dependencies would create circular imports. These are resolved with late (inside-function) imports:

| Module | Late import | Why |
|--------|-------------|-----|
| `scenario.py` | `from data import apply_projections_to_scenario` inside `create_scenario()` | `data.py` imports from `hydrology.py`; hydrology imports state only |
| `data.py` | `from hydrology import _detect_hydrology_module` inside `apply_projections_to_scenario()` | Hydrology imported by analytics, glowpa, etc. |

---

## GloWPa model execution

`glowpa._execute_model_run` runs in a background thread started by `start_glowpa()`. It:

1. Generates a YAML config file via `generate_yaml_content`.
2. Builds an R expression string via `build_r_expr_exec` / `build_r_expr_run`.
3. Starts or reuses `glowpa-container` via the Docker SDK (`state.docker_client`) with a CLI fallback.
4. Streams container stdout looking for `simulation_complete`.
5. On R crash, falls back to reading the last R log file for a human-readable error.
6. Unless `debug_mode` is set, deletes intermediate `.rds` files after the run.

State is written to `state.model_runs[run_id]` so the frontend can poll `/api/run-status/<run_id>`.

---

## Pathogens cache

`glowpa._read_pathogens()` populates `state._pathogens_cache` on first call:

1. **Preferred**: fetch `data-raw/pathogens.csv` from the GloWPa GitLab source repo at the exact commit SHA recorded in the installed package's `DESCRIPTION` file.
2. **Fallback**: `docker exec glowpa-container cat <extdata path>`.

A background thread in `app.py` pre-warms the cache at startup so the first UI request is instant.

---

## Projection system

`data.apply_projections_to_scenario` calls the external Waterpath data service:

- URL: `WATERPATH_DATA_API_URL` (default `https://dev.waterpath.venthic.com/api`)
- Endpoint: `POST /data/projections/download`
- Payload: the scenario's `isodata.csv`
- Parameters: `ssp`, `year`, `schema` (population / sanitation / treatment / all)
- Timeout: `PROJECTION_API_TIMEOUT` (default 600 s)
- Response: ZIP archive; files are unpacked into the appropriate category subfolders and rasters are renamed per `state.RASTER_RENAME_MAP`.

---

## Case-study on-disk layout

```
DATA_DIR/
  <name>_<uuid8>/
    datapackage.json          # metadata + enabled_categories
    config/
      scenario_metadata.csv   # one row per scenario
      baseline_config.yaml
      <scenario>_config.yaml
    input/
      baseline/               # baseline input data
      <scenario_folder>/      # copied from baseline, then modified
    output/
      baseline/
      <scenario_folder>/      # written by GloWPa after a model run
```

`case_study.load_existing_case_studies()` scans `DATA_DIR` for directories containing a `datapackage.json` and rebuilds `state.case_studies` from disk. It is called once at startup and can be triggered at runtime via `POST /api/case-studies/reload`.
