"""
report_render.py
================

Turns a stored report (see report.py) into the single HTML document that both
the browser preview and the WeasyPrint PDF are produced from.

The template lives in  templates/report/report.html.j2  and the print styling
in  templates/report/report.css . Keeping them separate from the narrative
templates means the wording and the layout can be changed independently.

Figure images are referenced with a private ``figure:<uuid>.png`` scheme so
that WeasyPrint's restricted URL fetcher (report.py) is the only thing that can
resolve them; for the HTML preview they are rewritten to the figure endpoint.
"""

import os
import re

import jinja2

_TEMPLATES_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), 'templates', 'report'
)

_env = jinja2.Environment(
    loader=jinja2.FileSystemLoader(_TEMPLATES_DIR),
    autoescape=True,
)


# ── Value formatting (mirrors frontend/src/components/driverMetricUtils.js) ───

def format_metric_value(value, value_format):
    if value is None:
        return 'n/a'
    try:
        v = float(value)
    except (TypeError, ValueError):
        return 'n/a'
    if v != v:  # NaN
        return 'n/a'
    if value_format == 'percent':
        return f'{v:.1f}%'
    if value_format == 'hdi':
        return f'{v:.3f}'
    if value_format == 'integer':
        return f'{round(v):,}'
    if value_format == 'probability':
        return f'{v:.2e}' if 0 < v < 0.001 else f'{v:.4f}'
    return f'{v:.2f}'


def compute_metric_delta(base, value, delta_mode):
    if base is None or value is None:
        return None
    try:
        b, v = float(base), float(value)
    except (TypeError, ValueError):
        return None
    if delta_mode in ('pp', 'absolute'):
        return v - b
    if abs(b) < 1e-9:
        return 0.0 if abs(v) < 1e-9 else None
    return ((v - b) / abs(b)) * 100.0


def format_delta_value(delta, delta_mode):
    if delta is None:
        return 'n/a'
    sign = '+' if delta >= 0 else ''
    if delta_mode == 'pp':
        return f'{sign}{delta:.1f} pp'
    if delta_mode == 'absolute':
        return f'{sign}{delta:.3f}'
    return f'{sign}{delta:.1f}%'


def _is_metric_applicable(metric_key, scenario):
    """Point-source and area-based wastewater runs expose different metrics."""
    if not metric_key.startswith('wastewater_'):
        return True
    mode = (scenario or {}).get('wwtp_mode')
    if mode == 'point' and metric_key.startswith('wastewater_share_'):
        return False
    if mode == 'area' and metric_key in ('wastewater_facility_count', 'wastewater_total_capacity'):
        return False
    return True


def _delta_class(delta, color_direction, delta_mode):
    if delta is None or color_direction == 'neutral':
        return ''
    threshold = 0.05 if delta_mode == 'absolute' else 0.5
    if abs(delta) < threshold:
        return ''
    improving = delta > 0 if color_direction == 'positive_good' else delta < 0
    return 'delta-good' if improving else 'delta-bad'


def build_driver_table(snapshot):
    """Group the frozen metric snapshot into per-driver blocks of rows."""
    if not snapshot:
        return {'columns': [], 'groups': []}

    baseline = snapshot.get('baseline') or {}
    scenarios = snapshot.get('scenarios') or []
    base_metrics = baseline.get('metrics') or {}

    groups, current = [], None
    for metric in snapshot.get('metrics') or []:
        key = metric['key']
        driver = metric['driver']
        if current is None or current['driver'] != driver:
            current = {'driver': driver, 'rows': []}
            groups.append(current)

        base_value = base_metrics.get(key)
        cells = []
        for scenario in scenarios:
            if not _is_metric_applicable(key, scenario):
                cells.append({'value': 'n/a', 'delta': '', 'cls': 'cell-na'})
                continue
            value = (scenario.get('metrics') or {}).get(key)
            delta = compute_metric_delta(base_value, value, metric['delta_mode'])
            cells.append({
                'value': format_metric_value(value, metric['value_format']),
                'delta': format_delta_value(delta, metric['delta_mode']) if delta is not None else '',
                'cls': _delta_class(delta, metric.get('color_direction'), metric['delta_mode']),
            })

        current['rows'].append({
            'label': metric['label'],
            'baseline': format_metric_value(base_value, metric['value_format']),
            'cells': cells,
        })

    columns = [{'name': baseline.get('name') or 'Baseline', 'year': baseline.get('year')}]
    columns += [{'name': s.get('name') or 'Scenario', 'year': s.get('year')} for s in scenarios]
    return {'columns': columns, 'groups': groups}


def build_appendix_scenarios(cs, report):
    """Raw model-input tables per scenario, for the data appendix.

    These are the CSVs the model is actually run from, read from the scenario's
    current input folder rather than frozen into the report, so the appendix
    always matches what a re-run would use.
    """
    import report_inputs

    scenarios = []
    baseline = report.get('baseline')
    if baseline and baseline.get('folder'):
        scenarios.append({**baseline, 'name': baseline.get('name') or 'Baseline'})
    scenarios += [s for s in (report.get('scenarios') or []) if s.get('folder')]
    if not scenarios:
        return []
    try:
        return report_inputs.build_raw_data_appendix(cs['folder_path'], scenarios)
    except Exception:
        return []


def render_appendix_html(cs, report, markdown_to_html):
    """Render the model-input appendix as its own standalone document.

    Unlike the main report, this is not stored with the report and is not
    editable: it is rebuilt from the scenarios' current input files every time
    it is downloaded, so it always matches what a re-run would use.
    """
    appendix_scenarios = build_appendix_scenarios(cs, report)
    for scenario in appendix_scenarios:
        scenario['anchor'] = _anchor('appendix', scenario.get('scenario_id')
                                     or scenario.get('folder') or '')

    drivers = []
    for scenario in appendix_scenarios:
        for group in scenario.get('groups') or []:
            if group.get('driver') and group['driver'] not in drivers:
                drivers.append(group['driver'])

    import narrative_generator
    intro_md = narrative_generator._render('appendix_intro.j2', {
        'drivers': drivers,
        'scenario_count': len(appendix_scenarios),
    }) or ''

    toc = [{'level': 1, 'title': scenario.get('name') or 'Scenario', 'anchor': scenario['anchor']}
           for scenario in appendix_scenarios]

    with open(os.path.join(_TEMPLATES_DIR, 'report.css'), 'r', encoding='utf-8') as f:
        css = f.read()

    template = _env.get_template('report_appendix.html.j2')
    return template.render(
        css=css,
        fonts=_font_faces(),
        report=report,
        case_study=cs,
        intro_html=markdown_to_html(intro_md),
        appendix_scenarios=appendix_scenarios,
        toc=toc,
        generated_on=_generated_on(report),
    )


def _figure_src(figure, for_pdf):
    if for_pdf:
        return f"figure:{figure['filename']}"
    return f"figures/{figure['id']}"


def render_report_html(cs, report, markdown_to_html, for_pdf=True):
    """Render the whole report document.

    ``markdown_to_html`` is injected so that the sanitising step stays in
    report.py -- this module never trusts section text on its own.
    """
    figures_by_section = {}
    for figure in report.get('figures') or []:
        figures_by_section.setdefault(figure.get('section_id'), []).append(figure)

    sections = sorted(
        (s for s in (report.get('sections') or []) if s.get('include', True)),
        key=lambda s: s.get('order', 0),
    )

    rendered = []
    figure_number = 0
    for section in sections:
        text = section.get('edited_md')
        if text is None:
            text = section.get('generated_md') or ''
        section_figures = figures_by_section.get(section['id'], [])
        if not str(text).strip() and not section_figures:
            continue
        numbered = []
        for figure in section_figures:
            figure_number += 1
            numbered.append({
                'number': figure_number,
                'caption': figure.get('caption') or '',
                'legend': figure.get('legend'),
                'src': _figure_src(figure, for_pdf),
            })
        rendered.append({
            'id': section['id'],
            'anchor': _anchor('sec', section['id']),
            'kind': section.get('kind'),
            'title': section.get('title') or '',
            'scenario_id': section.get('scenario_id'),
            'driver': section.get('driver'),
            'html': markdown_to_html(text),
            'figures': numbered,
        })

    table_sections = [s for s in rendered if s['kind'] == 'driver_table']
    # 'appendix' sections may still linger in reports generated before the
    # appendix became its own downloadable document; drop them from the main
    # text rather than render them here.
    front = [s for s in rendered
             if not s['scenario_id'] and s['kind'] not in ('driver_table', 'appendix')]
    placed = {s['id'] for s in front} | {s['id'] for s in table_sections}
    chapters = _group_chapters(report, [s for s in rendered
                                        if s['id'] not in placed and s['kind'] != 'appendix'])
    for chapter in chapters:
        chapter['anchor'] = _anchor('chapter', chapter.get('scenario_id')
                                    or chapter.get('name') or '')

    table = build_driver_table(report.get('table_snapshot')) if table_sections else None

    with open(os.path.join(_TEMPLATES_DIR, 'report.css'), 'r', encoding='utf-8') as f:
        css = f.read()

    template = _env.get_template('report.html.j2')
    return template.render(
        css=css,
        fonts=_font_faces(),
        report=report,
        case_study=cs,
        front_sections=front,
        table_sections=table_sections,
        chapters=chapters,
        table=table,
        toc=_build_toc(front, table, chapters),
        generated_on=_generated_on(report),
    )


def _anchor(prefix, value):
    """A stable, HTML-safe id for a section, chapter or appendix entry."""
    slug = re.sub(r'[^a-z0-9]+', '-', str(value or '').lower()).strip('-')
    return f'{prefix}-{slug}' if slug else prefix


def _build_toc(front, table, chapters):
    """Flat list of {level, title, anchor} entries for the contents page."""
    toc = []
    for section in front:
        if section['title']:
            toc.append({'level': 1, 'title': section['title'], 'anchor': section['anchor']})
    if table and table.get('groups'):
        toc.append({'level': 1, 'title': 'Driver summary table', 'anchor': 'driver-table-page'})
    for chapter in chapters:
        title = chapter.get('name') or 'Scenario'
        # Scenario names usually already carry the SSP and the year; only spell
        # them out when they do not.
        detail = ', '.join(str(p) for p in (chapter.get('ssp'), chapter.get('year'))
                           if p and str(p).lower() not in title.lower())
        if detail:
            title = f'{title} ({detail})'
        toc.append({'level': 1, 'title': title, 'anchor': chapter['anchor']})
        for section in chapter.get('sections') or []:
            if section['title']:
                toc.append({'level': 2, 'title': section['title'], 'anchor': section['anchor']})
    return toc


# The app's Outfit/Inter webfonts are loaded from a CDN in the browser, which
# the PDF renderer's restricted URL fetcher deliberately cannot reach. Inlining
# them as data URIs keeps the preview and the PDF identical without opening up
# any network or filesystem access. Read once, then cached for the process.
_FONT_FILES = (('Outfit', 'Outfit.woff2'), ('Inter', 'Inter.woff2'))
_font_css_cache = None


def _font_faces():
    global _font_css_cache
    if _font_css_cache is not None:
        return _font_css_cache
    import base64
    blocks = []
    for family, filename in _FONT_FILES:
        path = os.path.join(_TEMPLATES_DIR, 'fonts', filename)
        try:
            with open(path, 'rb') as f:
                encoded = base64.b64encode(f.read()).decode('ascii')
        except OSError:
            continue
        blocks.append(
            "@font-face{font-family:'%s';font-style:normal;font-weight:100 900;"
            "font-display:swap;src:url(data:font/woff2;base64,%s) format('woff2');}"
            % (family, encoded)
        )
    _font_css_cache = '\n'.join(blocks)
    return _font_css_cache


def _group_chapters(report, sections):
    """One chapter per scenario, in the order the report stores them."""
    names = {s.get('id'): s for s in report.get('scenarios') or []}
    chapters, index = [], {}
    for section in sections:
        scenario_id = section['scenario_id']
        chapter = index.get(scenario_id)
        if chapter is None:
            meta = names.get(scenario_id) or {}
            chapter = {
                'scenario_id': scenario_id,
                'name': meta.get('name') or 'Scenario',
                'year': meta.get('year'),
                'ssp': meta.get('ssp'),
                'sections': [],
            }
            index[scenario_id] = chapter
            chapters.append(chapter)
        chapter['sections'].append(section)
    return chapters


def _generated_on(report):
    stamp = report.get('updated_at') or report.get('created_at') or ''
    return stamp[:10]
