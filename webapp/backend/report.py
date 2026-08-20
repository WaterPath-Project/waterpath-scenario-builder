"""
report.py
=========

Persistence and PDF rendering for the narrative reports built under
``/narratives``.

A report is a JSON document stored alongside the case study it describes::

    data/<case_study>/reports/<report_id>.json
    data/<case_study>/reports/<report_id>/figures/<figure_id>.png

Each report holds an ordered list of sections. ``generated_md`` is whatever the
narrative generator produced; ``edited_md`` is the user's version and always
wins when present. Regenerating a report refreshes ``generated_md`` and, unless
the user explicitly asks to overwrite, leaves ``edited_md`` untouched.

Security notes
--------------
* ``report_id`` and ``figure_id`` are server-generated UUID4s and are validated
  against a strict pattern before they are ever joined onto a path, so a
  crafted id cannot escape the case study's ``reports`` directory.
* Section Markdown is user-supplied. It is converted to HTML and then run
  through a bleach allow-list, so raw HTML, scripts and event handlers in the
  editor cannot reach the PDF renderer or the preview.
* WeasyPrint is given a URL fetcher that only resolves the report's own figure
  files. Every other URL -- remote hosts, ``file://``, other local paths -- is
  refused, which blocks both SSRF and local file disclosure through the PDF.
"""

import io
import json
import os
import re
import uuid
from datetime import datetime, timezone

from flask import jsonify, request, send_file

import analytics
import case_study
import state
from narrative_generator import generate_report

# ──────────────────────────────────────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────────────────────────────────────

REPORTS_DIRNAME = 'reports'

# The QMRA quantiles the risk sections and the risk map can be built on, matching
# the Low / Median / High selector in the app's risk panel.
QUANTILE_CHOICES = (0.025, 0.5, 0.975)

# Server-generated identifiers only: hex with dashes, nothing path-like.
_ID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')

MAX_FIGURE_BYTES = 5 * 1024 * 1024
MAX_UPLOADED_FIGURES = 40
MAX_FIGURES_PER_REPORT = 250
MAX_SECTIONS_PER_REPORT = 400
MAX_MARKDOWN_CHARS = 40_000
_PNG_MAGIC = b'\x89PNG\r\n\x1a\n'
_FIGURE_FILE_RE = re.compile(r'^[0-9a-f-]{36}\.png$')

SECTION_KINDS = ('intro', 'driver_table', 'driver', 'map', 'risk', 'summary',
                 'appendix', 'custom')

# HTML that may survive sanitising. Deliberately excludes every scripting and
# embedding construct; images are added by the figure workflow, not by Markdown.
_ALLOWED_TAGS = [
    'p', 'br', 'hr', 'strong', 'em', 'b', 'i', 'u', 'sup', 'sub', 'blockquote',
    'code', 'pre', 'span',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
]
_ALLOWED_ATTRS = {'th': ['align'], 'td': ['align'], 'span': []}


# ──────────────────────────────────────────────────────────────────────────────
# Paths and identifiers
# ──────────────────────────────────────────────────────────────────────────────

def _valid_id(value):
    return bool(value) and bool(_ID_RE.match(str(value)))


def _find_case_study(case_study_id):
    return next((c for c in state.case_studies if c['id'] == case_study_id), None)


def _reports_dir(cs, create=False):
    path = os.path.join(cs['folder_path'], REPORTS_DIRNAME)
    if create:
        os.makedirs(path, exist_ok=True)
    return path


def _report_path(cs, report_id):
    """Absolute path of a report's JSON file. Raises ValueError on a bad id."""
    if not _valid_id(report_id):
        raise ValueError('Invalid report id')
    return os.path.join(_reports_dir(cs), f'{report_id}.json')


def _figures_dir(cs, report_id, create=False):
    if not _valid_id(report_id):
        raise ValueError('Invalid report id')
    path = os.path.join(_reports_dir(cs), report_id, 'figures')
    if create:
        os.makedirs(path, exist_ok=True)
    return path


def _now():
    return datetime.now(timezone.utc).isoformat()


# ──────────────────────────────────────────────────────────────────────────────
# Storage
# ──────────────────────────────────────────────────────────────────────────────

def _read_report(cs, report_id):
    path = _report_path(cs, report_id)
    if not os.path.exists(path):
        return None
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def _write_report(cs, report):
    _reports_dir(cs, create=True)
    report['updated_at'] = _now()
    path = _report_path(cs, report['report_id'])
    tmp_path = f'{path}.tmp'
    with open(tmp_path, 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    os.replace(tmp_path, path)
    return report


def _list_reports(cs):
    reports_dir = _reports_dir(cs)
    if not os.path.isdir(reports_dir):
        return []
    summaries = []
    for name in os.listdir(reports_dir):
        if not name.endswith('.json'):
            continue
        try:
            with open(os.path.join(reports_dir, name), 'r', encoding='utf-8') as f:
                report = json.load(f)
        except Exception:
            continue
        summaries.append({
            'report_id': report.get('report_id'),
            'title': report.get('title'),
            'scenario_ids': report.get('scenario_ids') or [],
            'baseline_scenario_id': report.get('baseline_scenario_id'),
            'quantile': report.get('quantile'),
            'created_at': report.get('created_at'),
            'updated_at': report.get('updated_at'),
            'section_count': len(report.get('sections') or []),
            'figure_count': len(report.get('figures') or []),
        })
    summaries.sort(key=lambda r: r.get('updated_at') or '', reverse=True)
    return summaries


# ──────────────────────────────────────────────────────────────────────────────
# Report assembly
# ──────────────────────────────────────────────────────────────────────────────

def _load_scenarios(cs, scenario_ids, quantile):
    """Return (baseline, ordered comparison scenarios, all rows).

    The baseline is always taken from the case study's metadata rather than the
    request, so a report can never compare against an arbitrary scenario.
    """
    rows = analytics.load_scenario_rows(cs['folder_path'])
    if not rows:
        raise ValueError('This case study has no scenario metadata')

    baseline_row = next(
        (r for r in rows.values()
         if str(r.get('is_baseline', '')).lower() in ('true', '1', 'yes')),
        None,
    )
    if baseline_row is None:
        baseline_row = next(
            (r for r in rows.values() if str(r.get('name', '')).strip().lower() == 'baseline'),
            None,
        )
    if baseline_row is None:
        raise ValueError('This case study has no baseline scenario')

    baseline_id = baseline_row.get('scenario_id')
    selected = [sid for sid in (scenario_ids or []) if sid in rows and sid != baseline_id]
    if not selected:
        raise ValueError('Select at least one scenario other than the baseline')

    baseline = analytics.build_narrative_scenario(cs, baseline_row, quantile)
    scenarios = [analytics.build_narrative_scenario(cs, rows[sid], quantile) for sid in selected]
    for scenario in [baseline] + scenarios:
        scenario['outputs'] = _output_stats(cs, scenario.get('folder'))
    return baseline, scenarios


def _output_stats(cs, folder):
    """Emission / concentration statistics for a scenario, or {} if unavailable.

    Reading the model outputs needs numpy and rasterio; a case study that has
    never been run must still be reportable, so failures are not fatal here.
    """
    if not folder:
        return {}
    try:
        import report_outputs
        return report_outputs.compute_output_stats(cs['folder_path'], folder)
    except Exception:
        return {}


def _table_snapshot(baseline, scenarios):
    """Freeze the driver-comparison table into the report.

    The table is part of the report's content, so it must not silently change
    when the underlying scenario data is edited later.
    """
    return {
        'metrics': analytics.DRIVER_METRIC_DEFS,
        'baseline': {
            'id': baseline.get('id'),
            'name': baseline.get('name'),
            'year': baseline.get('year'),
            'wwtp_mode': baseline.get('wwtp_mode'),
            'metrics': baseline.get('metrics'),
        },
        'scenarios': [{
            'id': s.get('id'),
            'name': s.get('name'),
            'year': s.get('year'),
            'wwtp_mode': s.get('wwtp_mode'),
            'metrics': s.get('metrics'),
        } for s in scenarios],
    }


def _build_sections(cs, baseline, scenarios):
    generated = generate_report(
        case_study.derive_case_study_context(cs),
        baseline,
        scenarios,
        analytics.DRIVER_METRIC_DEFS,
    )
    return [{
        'id': s['id'],
        'kind': s['kind'],
        'title': s['title'],
        'scenario_id': s['scenario_id'],
        'driver': s['driver'],
        'map_kind': s.get('map_kind'),
        'order': index,
        'include': True,
        'generated_md': s['markdown'],
        'edited_md': None,
    } for index, s in enumerate(generated)]


# ──────────────────────────────────────────────────────────────────────────────
# Result maps
# ──────────────────────────────────────────────────────────────────────────────

def _render_map_figures(cs, report_id, sections, scenarios, quantile):
    """Render the emission / concentration / risk maps the sections ask for.

    Returns figure records marked ``source: 'auto'`` so a later regeneration can
    tell them apart from the images the user uploaded.
    """
    wanted = {}
    for section in sections:
        map_kind = section.get('map_kind')
        if map_kind:
            wanted.setdefault(section.get('scenario_id'), {})[map_kind] = section['id']
    if not wanted:
        return []

    try:
        import report_outputs
    except Exception:
        return []

    figures_dir = _figures_dir(cs, report_id, create=True)
    figures = []
    for scenario in scenarios:
        kinds = wanted.get(scenario.get('id'))
        if not kinds:
            continue
        try:
            rendered = report_outputs.render_scenario_maps(
                cs['folder_path'], scenario.get('folder'), quantile, tuple(kinds))
        except Exception:
            continue
        for map_kind, section_id in kinds.items():
            image = rendered.get(map_kind)
            if not image:
                continue
            figure_id = str(uuid.uuid4())
            with open(os.path.join(figures_dir, f'{figure_id}.png'), 'wb') as f:
                f.write(image['png'])
            caption = report_outputs.MAP_CAPTIONS.get(map_kind, 'Model output')
            figures.append({
                'id': figure_id,
                'section_id': section_id,
                'caption': f"{caption}, {scenario.get('name') or 'scenario'}",
                'filename': f'{figure_id}.png',
                'size_bytes': len(image['png']),
                'created_at': _now(),
                'source': 'auto',
                'map_kind': map_kind,
                'legend': image['legend'],
            })
    return figures


def _delete_figure_files(cs, report_id, figures):
    figures_dir = _figures_dir(cs, report_id)
    for figure in figures:
        name = str(figure.get('filename') or '')
        if not _FIGURE_FILE_RE.match(name):
            continue
        path = os.path.join(figures_dir, name)
        if os.path.exists(path):
            try:
                os.remove(path)
            except OSError:
                pass


def _refresh_map_figures(cs, report, sections, scenarios, quantile, section_ids=None):
    """Re-render the auto maps, keeping every figure the user uploaded.

    ``section_ids`` is None to refresh everything, otherwise only the maps of
    those sections are redrawn; maps whose section disappeared are dropped.
    """
    live_ids = {s['id'] for s in sections}
    keep, stale = [], []
    for figure in report.get('figures') or []:
        if figure.get('source') != 'auto':
            keep.append(figure)
            continue
        section_id = figure.get('section_id')
        refreshing = section_ids is None or section_id in section_ids
        (stale if refreshing or section_id not in live_ids else keep).append(figure)

    targets = [s for s in sections
               if s.get('map_kind') and (section_ids is None or s['id'] in section_ids)]
    fresh = _render_map_figures(cs, report['report_id'], targets, scenarios, quantile)
    _delete_figure_files(cs, report['report_id'], stale)
    return keep + fresh


def _scenario_headings(baseline, scenarios):
    return [{
        'id': s.get('id'),
        'name': s.get('name'),
        'year': s.get('year'),
        'ssp': s.get('ssp'),
        'folder': s.get('folder'),
        'has_risk': (s.get('qmra') or {}).get('risk_annual_combined') is not None,
    } for s in scenarios]


def _baseline_heading(baseline):
    """The baseline is not a chapter, but the appendix still needs its inputs."""
    return {
        'id': baseline.get('id'),
        'name': baseline.get('name'),
        'year': baseline.get('year'),
        'ssp': baseline.get('ssp'),
        'folder': baseline.get('folder'),
    }


# ──────────────────────────────────────────────────────────────────────────────
# Endpoints: reports
# ──────────────────────────────────────────────────────────────────────────────

def list_reports(case_study_id):
    cs = _find_case_study(case_study_id)
    if not cs:
        return jsonify({'error': 'Case study not found'}), 404
    return jsonify({'reports': _list_reports(cs)}), 200


def create_report(case_study_id):
    cs = _find_case_study(case_study_id)
    if not cs:
        return jsonify({'error': 'Case study not found'}), 404

    payload = request.get_json(silent=True) or {}
    scenario_ids = payload.get('scenario_ids') or []
    if not isinstance(scenario_ids, list):
        return jsonify({'error': 'scenario_ids must be a list'}), 400

    try:
        quantile = float(payload.get('quantile', 0.5))
    except (TypeError, ValueError):
        return jsonify({'error': 'quantile must be a number'}), 400
    if quantile not in QUANTILE_CHOICES:
        return jsonify({'error': 'quantile must be one of %s'
                                 % ', '.join(str(q) for q in QUANTILE_CHOICES)}), 400

    try:
        baseline, scenarios = _load_scenarios(cs, scenario_ids, quantile)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400

    report_id = str(uuid.uuid4())
    sections = _build_sections(cs, baseline, scenarios)
    report = {
        'report_id': report_id,
        'case_study_id': case_study_id,
        'title': str(payload.get('title') or cs.get('name') or 'Scenario report')[:200],
        'subtitle': str(payload.get('subtitle') or '')[:200],
        'baseline_scenario_id': baseline.get('id'),
        'scenario_ids': [s.get('id') for s in scenarios],
        'baseline': _baseline_heading(baseline),
        'scenarios': _scenario_headings(baseline, scenarios),
        'quantile': quantile,
        'created_at': _now(),
        'updated_at': _now(),
        'sections': sections,
        'figures': _render_map_figures(cs, report_id, sections, scenarios, quantile),
        'table_snapshot': _table_snapshot(baseline, scenarios),
    }
    _write_report(cs, report)
    return jsonify(report), 201


def get_report(case_study_id, report_id):
    cs = _find_case_study(case_study_id)
    if not cs:
        return jsonify({'error': 'Case study not found'}), 404
    try:
        report = _read_report(cs, report_id)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    if report is None:
        return jsonify({'error': 'Report not found'}), 404
    return jsonify(report), 200


def update_report(case_study_id, report_id):
    """Save user edits. Only the editable fields of a report are accepted."""
    cs = _find_case_study(case_study_id)
    if not cs:
        return jsonify({'error': 'Case study not found'}), 404
    try:
        report = _read_report(cs, report_id)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    if report is None:
        return jsonify({'error': 'Report not found'}), 404

    payload = request.get_json(silent=True) or {}

    if 'title' in payload:
        report['title'] = str(payload['title'] or '')[:200]
    if 'subtitle' in payload:
        report['subtitle'] = str(payload['subtitle'] or '')[:200]

    if 'sections' in payload:
        incoming = payload['sections']
        if not isinstance(incoming, list):
            return jsonify({'error': 'sections must be a list'}), 400
        if len(incoming) > MAX_SECTIONS_PER_REPORT:
            return jsonify({'error': 'Too many sections'}), 400

        by_id = {s['id']: s for s in report.get('sections') or []}
        merged = []
        for order, item in enumerate(incoming):
            if not isinstance(item, dict):
                continue
            section_id = str(item.get('id') or '')
            existing = by_id.get(section_id)
            if existing is None:
                # A section the user added by hand: generated text stays empty.
                kind = item.get('kind') if item.get('kind') in SECTION_KINDS else 'custom'
                existing = {
                    'id': section_id or f'custom-{uuid.uuid4()}',
                    'kind': kind,
                    'title': '',
                    'scenario_id': item.get('scenario_id'),
                    'driver': None,
                    'generated_md': '',
                    'edited_md': None,
                }
            if 'title' in item:
                existing['title'] = str(item['title'] or '')[:200]
            if 'include' in item:
                existing['include'] = bool(item['include'])
            if 'edited_md' in item:
                edited = item['edited_md']
                existing['edited_md'] = None if edited is None else str(edited)[:MAX_MARKDOWN_CHARS]
            existing['order'] = order
            merged.append(existing)
        report['sections'] = merged

    _write_report(cs, report)
    return jsonify(report), 200


def delete_report(case_study_id, report_id):
    cs = _find_case_study(case_study_id)
    if not cs:
        return jsonify({'error': 'Case study not found'}), 404
    try:
        path = _report_path(cs, report_id)
        figures_dir = _figures_dir(cs, report_id)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    if not os.path.exists(path):
        return jsonify({'error': 'Report not found'}), 404

    os.remove(path)
    report_dir = os.path.dirname(figures_dir)
    if os.path.isdir(report_dir):
        import shutil
        shutil.rmtree(report_dir, ignore_errors=True)
    return jsonify({'status': 'deleted', 'report_id': report_id}), 200


def regenerate_report(case_study_id, report_id):
    """Re-run the narrative generator for some or all sections.

    ``section_ids`` limits the refresh; omit it (or pass 'all') for everything.
    ``overwrite_edited`` decides whether the user's own text is discarded --
    it defaults to False so edits survive a regeneration by accident.
    """
    cs = _find_case_study(case_study_id)
    if not cs:
        return jsonify({'error': 'Case study not found'}), 404
    try:
        report = _read_report(cs, report_id)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    if report is None:
        return jsonify({'error': 'Report not found'}), 404

    payload = request.get_json(silent=True) or {}
    requested = payload.get('section_ids')
    overwrite_edited = bool(payload.get('overwrite_edited'))
    target_ids = None if requested in (None, 'all') else set(requested or [])

    if 'scenario_ids' in payload:
        scenario_ids = payload.get('scenario_ids') or []
    else:
        scenario_ids = report.get('scenario_ids') or []

    quantile = report.get('quantile', 0.5)
    if 'quantile' in payload:
        try:
            quantile = float(payload.get('quantile'))
        except (TypeError, ValueError):
            return jsonify({'error': 'quantile must be a number'}), 400
        if quantile not in QUANTILE_CHOICES:
            return jsonify({'error': 'quantile must be one of %s'
                                     % ', '.join(str(q) for q in QUANTILE_CHOICES)}), 400
        report['quantile'] = quantile

    try:
        baseline, scenarios = _load_scenarios(cs, scenario_ids, quantile)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400

    fresh = {s['id']: s for s in _build_sections(cs, baseline, scenarios)}
    previous = {s['id']: s for s in report.get('sections') or []}

    merged = []
    for order, (section_id, section) in enumerate(fresh.items()):
        old = previous.get(section_id)
        if old is None:
            merged.append({**section, 'order': order})
            continue
        keep_edit = old.get('edited_md')
        refreshing = target_ids is None or section_id in target_ids
        merged.append({
            **old,
            'title': section['title'],
            'kind': section['kind'],
            'driver': section['driver'],
            'scenario_id': section['scenario_id'],
            'map_kind': section.get('map_kind'),
            'order': order,
            'generated_md': section['generated_md'] if refreshing else old.get('generated_md', ''),
            'edited_md': None if (refreshing and overwrite_edited) else keep_edit,
        })

    # Sections the user wrote themselves have no generated counterpart and are
    # appended unchanged so a regeneration never destroys them.
    custom = [s for s in previous.values() if s['id'] not in fresh]
    for offset, section in enumerate(custom):
        merged.append({**section, 'order': len(merged) + offset})

    report['sections'] = merged
    report['figures'] = _refresh_map_figures(cs, report, merged, scenarios, quantile, target_ids)
    report['scenario_ids'] = [s.get('id') for s in scenarios]
    report['baseline'] = _baseline_heading(baseline)
    report['scenarios'] = _scenario_headings(baseline, scenarios)
    report['baseline_scenario_id'] = baseline.get('id')
    report['table_snapshot'] = _table_snapshot(baseline, scenarios)
    _write_report(cs, report)
    return jsonify(report), 200


# ──────────────────────────────────────────────────────────────────────────────
# Endpoints: figures
# ──────────────────────────────────────────────────────────────────────────────

def upload_figure(case_study_id, report_id):
    """Store a PNG captured in the browser and attach it to a section."""
    cs = _find_case_study(case_study_id)
    if not cs:
        return jsonify({'error': 'Case study not found'}), 404
    try:
        report = _read_report(cs, report_id)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    if report is None:
        return jsonify({'error': 'Report not found'}), 404

    if sum(1 for f in report.get('figures') or []
           if f.get('source') != 'auto') >= MAX_UPLOADED_FIGURES:
        return jsonify({'error': f'A report may hold at most {MAX_UPLOADED_FIGURES} uploaded figures'}), 400
    if len(report.get('figures') or []) >= MAX_FIGURES_PER_REPORT:
        return jsonify({'error': f'A report may hold at most {MAX_FIGURES_PER_REPORT} figures'}), 400

    upload = request.files.get('file')
    if upload is None:
        return jsonify({'error': 'No file provided'}), 400

    blob = upload.read(MAX_FIGURE_BYTES + 1)
    if len(blob) > MAX_FIGURE_BYTES:
        return jsonify({'error': 'Figure exceeds the 5 MB limit'}), 413
    if not blob.startswith(_PNG_MAGIC):
        return jsonify({'error': 'Only PNG images are accepted'}), 400

    section_id = str(request.form.get('section_id') or '')
    known_sections = {s['id'] for s in report.get('sections') or []}
    if section_id not in known_sections:
        return jsonify({'error': 'Unknown section_id'}), 400

    figure_id = str(uuid.uuid4())
    figures_dir = _figures_dir(cs, report_id, create=True)
    with open(os.path.join(figures_dir, f'{figure_id}.png'), 'wb') as f:
        f.write(blob)

    figure = {
        'id': figure_id,
        'section_id': section_id,
        'caption': str(request.form.get('caption') or '')[:300],
        'filename': f'{figure_id}.png',
        'size_bytes': len(blob),
        'created_at': _now(),
        'source': 'upload',
    }
    report.setdefault('figures', []).append(figure)
    _write_report(cs, report)
    return jsonify(figure), 201


def delete_figure(case_study_id, report_id, figure_id):
    cs = _find_case_study(case_study_id)
    if not cs:
        return jsonify({'error': 'Case study not found'}), 404
    if not _valid_id(figure_id):
        return jsonify({'error': 'Invalid figure id'}), 400
    try:
        report = _read_report(cs, report_id)
        figures_dir = _figures_dir(cs, report_id)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    if report is None:
        return jsonify({'error': 'Report not found'}), 404

    remaining = [f for f in report.get('figures') or [] if f.get('id') != figure_id]
    if len(remaining) == len(report.get('figures') or []):
        return jsonify({'error': 'Figure not found'}), 404

    file_path = os.path.join(figures_dir, f'{figure_id}.png')
    if os.path.exists(file_path):
        os.remove(file_path)
    report['figures'] = remaining
    _write_report(cs, report)
    return jsonify({'status': 'deleted', 'figure_id': figure_id}), 200


def get_figure(case_study_id, report_id, figure_id):
    cs = _find_case_study(case_study_id)
    if not cs:
        return jsonify({'error': 'Case study not found'}), 404
    if not _valid_id(figure_id):
        return jsonify({'error': 'Invalid figure id'}), 400
    try:
        figures_dir = _figures_dir(cs, report_id)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    path = os.path.join(figures_dir, f'{figure_id}.png')
    if not os.path.exists(path):
        return jsonify({'error': 'Figure not found'}), 404
    return send_file(path, mimetype='image/png')


# ──────────────────────────────────────────────────────────────────────────────
# Rendering
# ──────────────────────────────────────────────────────────────────────────────

def _markdown_to_safe_html(text):
    """Convert stored Markdown to HTML and strip anything unsafe."""
    import bleach
    import markdown as md

    html = md.markdown(str(text or ''), extensions=['tables', 'sane_lists'])
    return bleach.clean(html, tags=_ALLOWED_TAGS, attributes=_ALLOWED_ATTRS, strip=True)


def _render_html(cs, report, for_pdf=True):
    from report_render import render_report_html
    return render_report_html(cs, report, _markdown_to_safe_html, for_pdf=for_pdf)


def _render_appendix_html(cs, report):
    from report_render import render_appendix_html
    return render_appendix_html(cs, report, _markdown_to_safe_html)


def preview_report(case_study_id, report_id):
    """Return the report as standalone HTML (same markup the PDF is built from)."""
    cs = _find_case_study(case_study_id)
    if not cs:
        return jsonify({'error': 'Case study not found'}), 404
    try:
        report = _read_report(cs, report_id)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    if report is None:
        return jsonify({'error': 'Report not found'}), 404
    # The preview is served over HTTP, so figures resolve through the figure
    # route rather than through the PDF renderer's private `figure:` scheme.
    return _render_html(cs, report, for_pdf=False), 200, {'Content-Type': 'text/html; charset=utf-8'}


def _figure_url_fetcher(figures_dir):
    """Restrict WeasyPrint to this report's own figure files.

    WeasyPrint would otherwise resolve any URL in the document, which would let
    report content reach internal services (SSRF) or read arbitrary local files.
    ``data:`` URIs are handed to WeasyPrint's own decoder: they carry their own
    payload (the inlined webfonts) and cause no network or filesystem access.
    """
    from weasyprint.urls import URLFetchingError, default_url_fetcher

    real_dir = os.path.realpath(figures_dir)

    def fetcher(url):
        if url.startswith('data:'):
            return default_url_fetcher(url)
        prefix = 'figure:'
        if not url.startswith(prefix):
            raise URLFetchingError(f'Refusing to fetch external resource: {url}')
        name = url[len(prefix):]
        if not _FIGURE_FILE_RE.match(name):
            raise URLFetchingError('Invalid figure reference')
        path = os.path.realpath(os.path.join(real_dir, name))
        if os.path.dirname(path) != real_dir or not os.path.exists(path):
            raise URLFetchingError('Figure not found')
        with open(path, 'rb') as f:
            return {'mime_type': 'image/png', 'string': f.read()}

    return fetcher


def download_report_pdf(case_study_id, report_id):
    cs = _find_case_study(case_study_id)
    if not cs:
        return jsonify({'error': 'Case study not found'}), 404
    try:
        report = _read_report(cs, report_id)
        figures_dir = _figures_dir(cs, report_id)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    if report is None:
        return jsonify({'error': 'Report not found'}), 404

    try:
        from weasyprint import HTML
    except ImportError:
        return jsonify({'error': 'PDF rendering is unavailable: WeasyPrint is not installed'}), 500

    html = _render_html(cs, report)
    pdf_bytes = HTML(
        string=html,
        base_url=None,
        url_fetcher=_figure_url_fetcher(figures_dir),
    ).write_pdf()

    safe_title = re.sub(r'[^A-Za-z0-9._-]+', '_', report.get('title') or 'report').strip('_')
    return send_file(
        io.BytesIO(pdf_bytes),
        mimetype='application/pdf',
        as_attachment=True,
        download_name=f'{safe_title or "report"}.pdf',
    )


def _data_uri_only_fetcher():
    """The appendix has no figures, so only the inlined webfonts may resolve."""
    from weasyprint.urls import URLFetchingError, default_url_fetcher

    def fetcher(url):
        if url.startswith('data:'):
            return default_url_fetcher(url)
        raise URLFetchingError(f'Refusing to fetch external resource: {url}')

    return fetcher


def download_report_appendix_pdf(case_study_id, report_id):
    """The raw model-input data behind a report, as its own PDF.

    Unlike the report PDF, this is not stored and is rebuilt from the
    scenarios' current input files on every download.
    """
    cs = _find_case_study(case_study_id)
    if not cs:
        return jsonify({'error': 'Case study not found'}), 404
    try:
        report = _read_report(cs, report_id)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    if report is None:
        return jsonify({'error': 'Report not found'}), 404

    try:
        from weasyprint import HTML
    except ImportError:
        return jsonify({'error': 'PDF rendering is unavailable: WeasyPrint is not installed'}), 500

    html = _render_appendix_html(cs, report)
    pdf_bytes = HTML(
        string=html,
        base_url=None,
        url_fetcher=_data_uri_only_fetcher(),
    ).write_pdf()

    safe_title = re.sub(r'[^A-Za-z0-9._-]+', '_', report.get('title') or 'report').strip('_')
    return send_file(
        io.BytesIO(pdf_bytes),
        mimetype='application/pdf',
        as_attachment=True,
        download_name=f'{safe_title or "report"}_appendix.pdf',
    )


# ──────────────────────────────────────────────────────────────────────────────
# Route registration
# ──────────────────────────────────────────────────────────────────────────────

def register_routes(app, frontend_app):
    routes = [
        ('/api/case-studies/<case_study_id>/reports',                              ['GET'],    list_reports),
        ('/api/case-studies/<case_study_id>/reports',                              ['POST'],   create_report),
        ('/api/case-studies/<case_study_id>/reports/<report_id>',                  ['GET'],    get_report),
        ('/api/case-studies/<case_study_id>/reports/<report_id>',                  ['PUT'],    update_report),
        ('/api/case-studies/<case_study_id>/reports/<report_id>',                  ['DELETE'], delete_report),
        ('/api/case-studies/<case_study_id>/reports/<report_id>/regenerate',       ['POST'],   regenerate_report),
        ('/api/case-studies/<case_study_id>/reports/<report_id>/figures',          ['POST'],   upload_figure),
        ('/api/case-studies/<case_study_id>/reports/<report_id>/figures/<figure_id>', ['GET'],    get_figure),
        ('/api/case-studies/<case_study_id>/reports/<report_id>/figures/<figure_id>', ['DELETE'], delete_figure),
        ('/api/case-studies/<case_study_id>/reports/<report_id>/preview',          ['GET'],    preview_report),
        ('/api/case-studies/<case_study_id>/reports/<report_id>/pdf',              ['GET'],    download_report_pdf),
        ('/api/case-studies/<case_study_id>/reports/<report_id>/appendix.pdf',     ['GET'],    download_report_appendix_pdf),
    ]
    for rule, methods, view in routes:
        app.add_url_rule(rule, endpoint=f'main_{view.__name__}_{methods[0]}',
                         view_func=view, methods=methods)
        frontend_app.add_url_rule(rule, endpoint=f'frontend_{view.__name__}_{methods[0]}',
                                  view_func=view, methods=methods)
