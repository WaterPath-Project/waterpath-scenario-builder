"""Shared module-level state and constants for the WaterPath backend.

All globals that must be accessed across the split route/service modules live
here.  Mutable containers (``case_studies``, ``scenarios``, ``model_runs``)
should be mutated in place (``.append``, ``[:] = ...``, ``.clear()``) so that
``from state import case_studies`` keeps the same reference.

Scalar globals that are reassigned (``glowpa_running``, ``_pathogens_cache``)
must be accessed via the module attribute (``state.glowpa_running``).
"""

import os

import docker
from flask import Flask
from flask_cors import CORS
from flask_socketio import SocketIO


# ── Flask apps ───────────────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*")

# Second Flask app that serves the React build on port 3000 and mirrors the
# API.  Routes are registered onto both ``app`` and ``frontend_app`` by the
# ``register_routes`` helpers in each split module.
frontend_app = Flask(__name__, static_folder='/app/frontend/build', static_url_path='')
CORS(frontend_app)


# ── Docker client ────────────────────────────────────────────────────────────
try:
    docker_client = docker.from_env()
    docker_available = True
except Exception as e:  # pragma: no cover - depends on host
    print(f"Warning: Could not connect to Docker: {e}")
    docker_client = None
    docker_available = False


# ── Filesystem layout ────────────────────────────────────────────────────────
if os.path.exists('/app/data'):
    DATA_DIR = '/app/data'
else:
    DATA_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'data'))


# ── External Data API ────────────────────────────────────────────────────────
WATERPATH_DATA_API_URL = os.environ.get(
    'WATERPATH_DATA_API_URL', 'https://dev.waterpath.venthic.com/api'
).rstrip('/')
PROJECTION_API_TIMEOUT = int(os.environ.get('PROJECTION_API_TIMEOUT', '600'))


# ── Static configuration constants ───────────────────────────────────────────
CATEGORY_FOLDER_MAP = {
    'human-emissions':      'human_emissions',
    'livestock-emissions':  'livestock_emissions',
    'concentrations':       'concentrations',
    'risk':                 'risk',
}

RASTER_RENAME_MAP = {
    'pop_urban.tif': 'popurban.tif',
    'pop_rural.tif': 'poprural.tif',
}

SCENARIO_METADATA_FIELDS = [
    'scenario_id', 'name', 'folder', 'ssp', 'pathogen', 'year',
    'is_baseline', 'notes', 'created_at', 'updated_at',
    'qmra_config',  # JSON blob: {mci, model, pathways: {route: {enabled, volume, frequency, ...}}}
]

_SCHEMA_CATEGORY_MAP = {
    'population':  'human_emissions',
    'sanitation':  'human_emissions',
    'treatment':   'human_emissions',
    'hydrology':   'human_emissions',
}

ANALYTICS_REQUIRED_FILES = ['isodata.csv', 'isoraster.tif', 'poprural.tif', 'popurban.tif']
ANALYTICS_OPTIONAL_FILES = ['treatment.csv']

GLOWPA_IMAGE = 'docker-registry.wur.nl/glowpa/glowpa-r/glowpa-main:0.2.1'
DOCKER_SOCK = 'unix://var/run/docker.sock'

# GloWPa-recognised animal types (per model documentation).
_GLOWPA_ANIMALS = [
    'asses', 'buffaloes', 'camels', 'cattle', 'chickens',
    'ducks', 'goats', 'horses', 'mules', 'pigs', 'sheep',
]

# Files returned by the projections API that belong at the root of
# livestock_emissions/ (not in the animals/ sub-folder).
_LIVESTOCK_ROOT_FILES = frozenset([
    'animal_isoraster.tif',
    'manure_fractions.csv',
    'manure_management.csv',
    'production_systems.csv',
])

_LIVESTOCK_EDITABLE_CSVS = {
    'manure_management.csv',
    'manure_fractions.csv',
    'production_systems.csv',
}

GLOWPA_DESCRIPTION_PATH = '/usr/local/lib/R/site-library/glowpa/DESCRIPTION'
GLOWPA_EXTDATA_PATHOGENS = '/usr/local/lib/R/site-library/glowpa/extdata/kla/pathogen_inputs.csv'
GLOWPA_DATARAW_PATHOGENS = 'data-raw/pathogens.csv'


# ── Mutable in-memory state (rebinding NOT allowed; mutate in place) ─────────
case_studies = []   # list[dict]
scenarios = []      # list[dict] — legacy in-memory cache (mostly unused)
model_runs = {}     # run_id -> run status/output dict


# ── Mutable scalar state (rebound; access via state.<name>) ──────────────────
glowpa_running = False
_pathogens_cache = None
