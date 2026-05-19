"""Session-level helpers: aggregate metrics summary and recent activity feed."""

import csv
import os
from datetime import datetime

from flask import jsonify

from state import case_studies


def metrics_summary():
    """Return aggregate metrics: count of scenarios that have produced outputs."""
    try:
        scenarios_with_outputs = 0
        for cs in case_studies:
            cs_path = cs.get('folder_path')
            if not cs_path:
                continue
            meta_path = os.path.join(cs_path, 'config', 'scenario_metadata.csv')
            if not os.path.exists(meta_path):
                continue
            with open(meta_path, 'r', newline='', encoding='utf-8') as f:
                for row in csv.DictReader(f):
                    folder = row.get('folder', '')
                    if not folder:
                        continue
                    output_dir = os.path.join(cs_path, 'output', folder)
                    if os.path.isdir(output_dir) and any(
                        fn.endswith(('.csv', '.tif'))
                        for fn in os.listdir(output_dir)
                        if not fn.endswith('.log')
                    ):
                        scenarios_with_outputs += 1
        return jsonify({'scenarios_with_outputs': scenarios_with_outputs}), 200
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


def get_activity():
    """Return recent filesystem activity across all case studies.

    Scans output directories and scenario_metadata.csv timestamps to produce a
    sorted list of recent events (new case study, new scenario, new outputs).
    """
    try:
        events = []
        now = datetime.now().timestamp()

        for cs in case_studies:
            cs_path = cs.get('folder_path')
            cs_name = cs.get('name', 'Unknown')
            if not cs_path or not os.path.exists(cs_path):
                continue

            # Case study folder creation/modification time
            cs_mtime = os.path.getmtime(cs_path)
            events.append({
                'type': 'case_study',
                'icon': 'folderOpen',
                'message': f'Case study available: {cs_name}',
                'detail': cs.get('folder_name', ''),
                'mtime': cs_mtime,
                'time_iso': datetime.fromtimestamp(cs_mtime).isoformat(),
            })

            meta_path = os.path.join(cs_path, 'config', 'scenario_metadata.csv')
            if not os.path.exists(meta_path):
                continue

            with open(meta_path, 'r', newline='', encoding='utf-8') as f:
                for row in csv.DictReader(f):
                    folder = row.get('folder', '')
                    sc_name = row.get('name', folder)
                    is_baseline = row.get('is_baseline', 'False').lower() in ('true', '1', 'yes')

                    # New scenario event (non-baseline)
                    if not is_baseline:
                        sc_created = row.get('created_at', '')
                        try:
                            ts = datetime.fromisoformat(sc_created).timestamp()
                        except Exception:
                            ts = os.path.getmtime(meta_path)
                        events.append({
                            'type': 'scenario',
                            'icon': 'barChart',
                            'message': f'Scenario created: {sc_name}',
                            'detail': cs_name,
                            'mtime': ts,
                            'time_iso': datetime.fromtimestamp(ts).isoformat(),
                        })

                    # Output event
                    output_dir = os.path.join(cs_path, 'output', folder)
                    if os.path.isdir(output_dir):
                        out_files = [
                            fn for fn in os.listdir(output_dir)
                            if fn.endswith(('.csv', '.tif')) and not fn.endswith('.log')
                        ]
                        if out_files:
                            latest = max(
                                os.path.getmtime(os.path.join(output_dir, fn))
                                for fn in out_files
                            )
                            events.append({
                                'type': 'output',
                                'icon': 'checkCircle',
                                'message': f'Outputs ready: {sc_name}',
                                'detail': cs_name,
                                'mtime': latest,
                                'time_iso': datetime.fromtimestamp(latest).isoformat(),
                            })

        # Sort by most recent first, return top 20
        events.sort(key=lambda e: e['mtime'], reverse=True)
        # Compute human-readable relative time
        for ev in events:
            delta = int(now - ev['mtime'])
            if delta < 60:
                ev['rel'] = 'just now'
            elif delta < 3600:
                ev['rel'] = f"{delta // 60} min ago"
            elif delta < 86400:
                ev['rel'] = f"{delta // 3600} hr ago"
            else:
                ev['rel'] = f"{delta // 86400} days ago"

        return jsonify({'events': events[:20]}), 200
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


def register_routes(app, frontend_app):
    routes = [
        ('/api/metrics/summary', ['GET'], metrics_summary),
        ('/api/activity',        ['GET'], get_activity),
    ]
    for rule, methods, view in routes:
        app.add_url_rule(rule, endpoint=f'main_{view.__name__}', view_func=view, methods=methods)
        frontend_app.add_url_rule(rule, endpoint=f'frontend_{view.__name__}', view_func=view, methods=methods)
