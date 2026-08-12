"""Top-level entry point: register all routes and start the two Flask apps.

The original monolithic app.py has been split into focused modules:
  - state.py       : Flask apps, sockets, docker client, constants, mutable globals
  - fs_utils.py    : filesystem/CSV helpers
  - livestock.py   : livestock module (handlers + register_routes)
  - hydrology.py   : hydrology module (handlers + register_routes)
  - data.py        : data-service projection helpers (no routes)
  - glowpa.py      : YAML/Docker glowpa wrapper + endpoints
  - scenario.py    : scenario CRUD + treatment/geodata/isodata
  - case_study.py  : case-study CRUD, ZIP upload, datapackage, SPA catch-all
  - analytics.py   : analytics/driver/narrative endpoints
  - results.py     : output rasters, raster-diff, output CSV/PNG
  - session.py     : metrics summary + activity feed

NOTE: case_study.register_routes MUST be called LAST on the frontend app so
its catch-all SPA route ``/<path:path>`` is registered after every other endpoint.
"""

import threading

import state

# Expose the Flask app at module level so `flask --app backend/app.py run`
# can discover it automatically (Flask CLI looks for a name called 'app').
app = state.app
import analytics
import case_study
import glowpa
import hydrology
import livestock
import qmra
import results
import scenario
import session

# Register all API routes on both Flask apps.  case_study is registered LAST
# because it adds the catch-all SPA route on the frontend app.
for mod in (scenario, livestock, hydrology, glowpa, analytics, results, session, qmra):
    mod.register_routes(state.app, state.frontend_app)

case_study.register_routes(state.app, state.frontend_app)

# Load existing case studies on startup
case_study.load_existing_case_studies()

# Pre-warm the pathogens cache in background so the first UI request is instant
threading.Thread(target=glowpa._prefetch_pathogens, daemon=True).start()


def run_frontend_server():
    """Run the frontend Flask app on port 3000"""
    # Debug: Print all registered routes
    print("[DEBUG] Frontend app registered routes:")
    for rule in state.frontend_app.url_map.iter_rules():
        print(f"  {rule.rule} -> {rule.endpoint} (methods: {rule.methods})")

    state.frontend_app.run(host='0.0.0.0', port=3000, debug=False)


if __name__ == '__main__':
    # Start frontend server in a separate thread
    frontend_thread = threading.Thread(target=run_frontend_server, daemon=True)
    frontend_thread.start()

    print("Starting Flask servers...")
    print("Frontend server: http://127.0.0.1:3000")
    print("Backend API server: http://127.0.0.1:5000")

    # Start backend server with SocketIO
    state.socketio.run(state.app, host='0.0.0.0', port=5000, debug=True, allow_unsafe_werkzeug=True)
