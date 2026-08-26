"""GloWPa wrapper: YAML config generation, R expression building, Docker
exec/run model invocation, model-run logging, container start/stop and the
endpoints that expose all of these to the UI.
"""

import csv
import io
import os
import subprocess
import threading
import traceback
import uuid
from datetime import datetime

import docker
import requests
from flask import jsonify, request

import state
from fs_utils import _locate_scenario, _resolve_data_path
from hydrology import _detect_hydrology_module
from livestock import _detect_livestock_module
from state import (
    DOCKER_SOCK,
    GLOWPA_DATARAW_PATHOGENS,
    GLOWPA_DESCRIPTION_PATH,
    GLOWPA_EXTDATA_PATHOGENS,
    GLOWPA_IMAGE,
    case_studies,
    docker_client,
    model_runs,
)


# ──────────────────────────────────────────────────────────────────────────────
# YAML generation
# ──────────────────────────────────────────────────────────────────────────────



def generate_yaml_content(folder, pathogen, flat=False, cs_path=None, wwtp_mode='POINT'):
    """Return a YAML config string for glowpa_init()."""
    p = (pathogen or 'unknown').lower().strip()
    slug = folder
    ls = _detect_livestock_module(cs_path, folder) if cs_path else None
    hy = _detect_hydrology_module(cs_path, folder) if cs_path else None

    # If the scenario has livestock but no temperature raster, fall back to
    # the baseline's temperature file (it is static across SSP scenarios).
    if ls and not ls['temperature_tif'] and cs_path and folder != 'baseline':
        baseline_ls = _detect_livestock_module(cs_path, 'baseline')
        if baseline_ls and baseline_ls['temperature_tif']:
            ls = dict(ls, temperature_tif=baseline_ls['temperature_tif'])

    # For non-baseline scenarios, fall back to baseline heads TIFs for animals
    # that only have isodata (e.g. camels — no SSP-projected heads raster).
    if ls and cs_path and folder != 'baseline':
        baseline_animals_dir = os.path.join(
            cs_path, 'input', 'baseline', 'livestock_emissions', 'animals'
        )
        patched = {}
        for animal, info in ls['animals'].items():
            if not info['has_heads']:
                fb = os.path.join(baseline_animals_dir, f'{animal}_heads.tif')
                if os.path.exists(fb):
                    info = dict(info, has_heads=True, _heads_fallback=fb)
            patched[animal] = info
        ls = dict(ls, animals=patched)

    if flat:
        out_dir  = 'output'
        log_file = 'output/glowpa.log'

        def inp_path(fname):
            if cs_path:
                full = _resolve_data_path(cs_path, folder, fname)
                base = os.path.join(cs_path, 'input', folder)
                rel  = os.path.relpath(full, base).replace(os.sep, '/')
                return f'input/{rel}'
            return f'input/{fname}'

        def ls_path(sub):
            abs_p = os.path.join(ls['dir'], sub)
            base  = os.path.join(cs_path, 'input', folder)
            return 'input/' + os.path.relpath(abs_p, base).replace(os.sep, '/')

        def hy_path(abs_p):
            base = os.path.join(cs_path, 'input', folder)
            return 'input/' + os.path.relpath(abs_p, base).replace(os.sep, '/')
    else:
        out_dir  = f'output/{folder}'
        log_file = f'output/{folder}/glowpa.log'

        def inp_path(fname):
            if cs_path:
                full = _resolve_data_path(cs_path, folder, fname)
                return os.path.relpath(full, cs_path).replace(os.sep, '/')
            return f'input/{folder}/{fname}'

        def ls_path(sub):
            abs_p = os.path.join(ls['dir'], sub)
            return os.path.relpath(abs_p, cs_path).replace(os.sep, '/')

        def hy_path(abs_p):
            return os.path.relpath(abs_p, cs_path).replace(os.sep, '/')

    livestock_input_yaml = ''
    if ls:
        if ls['has_manure_management']:
            livestock_input_yaml += (
                f"  manure:\n"
                f"    management_systems: {ls_path('manure_management.RDS')}\n"
            )
        if ls['temperature_tif']:
            temp_sub = os.path.relpath(ls['temperature_tif'], ls['dir']).replace(os.sep, '/')
            livestock_input_yaml += (
                f"  temperature:\n"
                f"    year: {ls_path(temp_sub)}\n"
            )
        ls_subtree = ''
        if ls['has_animal_isoraster']:
            ls_subtree += f"    animal_isoraster: {ls_path('animal_isoraster.tif')}\n"
        if ls['has_production_systems']:
            ls_subtree += f"    production_systems: {ls_path('production_systems.RDS')}\n"
        if ls['has_manure_fractions']:
            ls_subtree += f"    manure_fractions: {ls_path('manure_fractions.RDS')}\n"
        if ls['animals']:
            ls_subtree += "    animals:\n"
            for animal, info in ls['animals'].items():
                if info['has_isodata'] and info['has_heads']:
                    if '_heads_fallback' in info:
                        heads_sub = os.path.relpath(
                            info['_heads_fallback'], ls['dir']
                        ).replace(os.sep, '/')
                    else:
                        heads_sub = f'animals/{animal}_heads.tif'
                    ls_subtree += (
                        f"      {animal}:\n"
                        f"        isodata: {ls_path(f'animals/isodata_{animal}.RDS')}\n"
                        f"        heads: {ls_path(heads_sub)}\n"
                    )
        if ls_subtree:
            livestock_input_yaml += f"  livestock:\n{ls_subtree}"

    hydrology_input_yaml = ''
    hydrology_routing_yaml = ''
    if hy:
        hy_subtree = ''
        if hy['runoff_dir']:
            hy_subtree += f"    runoff: {hy_path(hy['runoff_dir'])}\n"
        if hy['discharge_dir']:
            hy_subtree += f"    discharge: {hy_path(hy['discharge_dir'])}\n"
        if hy['river_temp_dir']:
            hy_subtree += f"    river_temperature: {hy_path(hy['river_temp_dir'])}\n"
        if hy['river_depth_dir']:
            hy_subtree += f"    river_depth: {hy_path(hy['river_depth_dir'])}\n"
        if hy['river_restime_dir']:
            hy_subtree += f"    river_restime: {hy_path(hy['river_restime_dir'])}\n"
        if hy['ssrd_dir']:
            hy_subtree += f"    ssrd: {hy_path(hy['ssrd_dir'])}\n"
        if hy['doc_file']:
            hy_subtree += f"    doc: {hy_path(hy['doc_file'])}\n"
        if hy_subtree:
            hydrology_input_yaml = f"  hydrology:\n{hy_subtree}"
        routing_subtree = ''
        if hy['flowdir_file']:
            routing_subtree += f"    flowdir: {hy_path(hy['flowdir_file'])}\n"
        if hy['flowacc_file']:
            routing_subtree += f"    flowacc: {hy_path(hy['flowacc_file'])}\n"
        if routing_subtree:
            hydrology_routing_yaml = f"  routing:\n{routing_subtree}"

    livestock_option_yaml = "livestock:\n  enabled: TRUE\n" if ls else ""
    hydrology_option_yaml = "hydrology:\n  enabled: TRUE\n  step: months\n" if hy else ""
    livestock_output_yaml = (
        f"    livestock:\n"
        f"      land: livestock_sources_land_{p}_{slug}.csv\n"
        f"      surface_water: livestock_sources_water_{p}_{slug}.csv\n"
    ) if ls else ""
    hydrology_output_yaml = (
        f"  hydrology:\n"
        f"    loads: stream_loads_{p}_{slug}.tif\n"
        f"    concentration: stream_concentration_{p}_{slug}.tif\n"
    ) if hy else ""

    return (
        f"logger:\n"
        f"  enabled: TRUE\n"
        f"  threshold: INFO\n"
        f"  file: {log_file}\n"
        f"  appender: TEE\n"
        f"input:\n"
        f"  isoraster: {inp_path('isoraster.tif')}\n"
        f"  isodata: {inp_path('isodata.RDS')}\n"
        + (f"  wwtp: {inp_path('treatment.RDS')}\n" if wwtp_mode == 'POINT' else "")
        + f"  population:\n"
        f"    urban: {inp_path('popurban.tif')}\n"
        f"    rural: {inp_path('poprural.tif')}\n"
        + livestock_input_yaml
        + hydrology_input_yaml
        + hydrology_routing_yaml
        + f"wwtp:\n"
        f"  treatment: {wwtp_mode}\n"
        + livestock_option_yaml
        + hydrology_option_yaml
        + f"population:\n"
        f"  correct: TRUE\n"
        f"pathogen: {p}\n"
        f"output:\n"
        f"  dir: {out_dir}\n"
        f"  sources:\n"
        f"    human:\n"
        f"      land: human_sources_land_{p}_{slug}.csv\n"
        f"      surface_water: human_sources_water_{p}_{slug}.csv\n"
        + livestock_output_yaml
        + f"  sinks:\n"
        f"    surface_water:\n"
        f"      table: surface_water_emissions_{p}_{slug}.csv\n"
        f"      grid: surface_water_emissions_{p}_{slug}.tif\n"
        f"    land:\n"
        f"      table: land_emissions_{p}_{slug}.csv\n"
        f"      grid: land_emissions_{p}_{slug}.tif\n"
        + hydrology_output_yaml
        + f"constants:\n"
        f"  runoff_fraction: 0.025\n"
        f"  threshold_discharge: 1\n"
    )


def _detect_wwtp_mode(cs_path, folder):
    """Return 'AREA' or 'POINT' based on treatment.csv / isodata.csv columns."""
    try:
        tr_path = _resolve_data_path(cs_path, folder, 'treatment.csv')
        if os.path.exists(tr_path):
            with open(tr_path, 'r', newline='', encoding='utf-8') as f:
                reader = csv.reader(f)
                headers = next(reader, [])
                has_data = next(reader, None) is not None
            if 'FractionPrimarytreatment' in headers:
                return 'AREA'
            if headers and 'lon' in headers and has_data:
                return 'POINT'
        iso_path = _resolve_data_path(cs_path, folder, 'isodata.csv')
        if os.path.exists(iso_path):
            with open(iso_path, 'r', newline='', encoding='utf-8') as f:
                headers = next(csv.reader(f), [])
            if 'FractionPrimarytreatment' in headers:
                return 'AREA'
    except Exception:
        pass
    return 'POINT'


# ──────────────────────────────────────────────────────────────────────────────
# R expression builders
# ──────────────────────────────────────────────────────────────────────────────

def _r_csv_to_rds_snippet(csv_path, rds_path):
    return (
        f"  csv <- '{csv_path}'; rds <- '{rds_path}'; "
        f"if (file.exists(csv) && (!file.exists(rds) || file.mtime(csv) > file.mtime(rds))) {{"
        f" message(paste('Converting', csv, 'to', rds)); "
        f" saveRDS(read.csv(csv, stringsAsFactors=FALSE), rds) "
        f"}}"
    )


def _r_iso_csv_to_rds_snippet(csv_path, rds_path, treatment_csv_path=None):
    tr_path_r = f"'{treatment_csv_path}'" if treatment_csv_path else "NULL"
    return (
        f"  local({{ "
        f"  csv <- '{csv_path}'; rds <- '{rds_path}'; "
        f"  if (file.exists(csv) && (!file.exists(rds) || file.mtime(csv) > file.mtime(rds))) {{ "
        f"    message(paste('Converting', csv, 'to', rds)); "
        f"    df <- read.csv(csv, stringsAsFactors=FALSE); "
        f"    if (!'fEmitted_inEffluent_after_treatment_virus' %in% names(df) && "
        f"        'FractionPrimarytreatment' %in% names(df)) {{ "
        f"      .fq1 <- if ('FractionQuaternarytreatment' %in% names(df)) df$FractionQuaternarytreatment else 0; "
        f"      df$fEmitted_inEffluent_after_treatment_virus <- "
        f"        df$FractionPrimarytreatment   * (0.97 - 0.97*0.75) + "
        f"        df$FractionSecondarytreatment * (0.50 - 0.50*0.95) + "
        f"        df$FractionTertiarytreatment  * (0.40 - 0.40*0.99) + "
        f"        .fq1                          * (0.40 - 0.40*0.9975); "
        f"      df$fEmitted_inEffluent_after_treatment_protozoa <- "
        f"        df$FractionPrimarytreatment   * (0.85 - 0.85*0.50) + "
        f"        df$FractionSecondarytreatment * (0.20 - 0.20*0.90) + "
        f"        df$FractionTertiarytreatment  * (0.25 - 0.25*0.92) + "
        f"        .fq1                          * (0.25 - 0.25*0.996); "
        f"    }}; "
        f"    if (!'fEmitted_inEffluent_after_treatment_virus' %in% names(df)) {{ "
        f"      .tr_path <- {tr_path_r}; "
        f"      if (!is.null(.tr_path) && file.exists(.tr_path)) {{ "
        f"        .tr <- read.csv(.tr_path, stringsAsFactors=FALSE); "
        f"        if ('FractionPrimarytreatment' %in% names(.tr)) {{ "
        f"          .fp <- mean(.tr$FractionPrimarytreatment,   na.rm=TRUE); "
        f"          .fs <- mean(.tr$FractionSecondarytreatment, na.rm=TRUE); "
        f"          .ft <- mean(.tr$FractionTertiarytreatment,  na.rm=TRUE); "
        f"          .fq <- if ('FractionQuaternarytreatment' %in% names(.tr)) mean(.tr$FractionQuaternarytreatment, na.rm=TRUE) else 0; "
        f"          message(paste('fEmitted from AREA treatment.csv: fp=', round(.fp,4), 'fs=', round(.fs,4), 'ft=', round(.ft,4))); "
        f"          df$fEmitted_inEffluent_after_treatment_virus    <- "
        f"            .fp*(0.97-0.97*0.75) + .fs*(0.50-0.50*0.95) + .ft*(0.40-0.40*0.99) + .fq*(0.40-0.40*0.9975); "
        f"          df$fEmitted_inEffluent_after_treatment_protozoa <- "
        f"            .fp*(0.85-0.85*0.50) + .fs*(0.20-0.20*0.90) + .ft*(0.25-0.25*0.92) + .fq*(0.25-0.25*0.996); "
        f"        }} else {{ "
        f"          .tot <- sum(.tr$capacity, na.rm=TRUE); "
        f"          if (isTRUE(.tot > 0)) {{ "
        f"            .fp <- sum(.tr$capacity[.tr$treatment_type=='Primary'],    na.rm=TRUE) / .tot; "
        f"            .fs <- sum(.tr$capacity[.tr$treatment_type=='Secondary'],  na.rm=TRUE) / .tot; "
        f"            .ft <- sum(.tr$capacity[.tr$treatment_type=='Tertiary'],   na.rm=TRUE) / .tot; "
        f"            .fq <- sum(.tr$capacity[.tr$treatment_type=='Quaternary'], na.rm=TRUE) / .tot; "
        f"          }} else {{ .fp <- 1; .fs <- 0; .ft <- 0; .fq <- 0 }}; "
        f"          .fem_v <- .fp*0.2425 + .fs*0.025 + .ft*0.004 + .fq*0.001; "
        f"          .fem_p <- .fp*0.425  + .fs*0.02  + .ft*0.02  + .fq*0.001; "
        f"          message(paste('fEmitted from POINT treatment.csv: virus=', round(.fem_v,4), 'protozoa=', round(.fem_p,4))); "
        f"          df$fEmitted_inEffluent_after_treatment_virus    <- .fem_v; "
        f"          df$fEmitted_inEffluent_after_treatment_protozoa <- .fem_p; "
        f"        }} "
        f"      }} else {{ "
        f"        message('fEmitted fallback: assuming all Primary treatment'); "
        f"        df$fEmitted_inEffluent_after_treatment_virus    <- 0.2425; "
        f"        df$fEmitted_inEffluent_after_treatment_protozoa <- 0.425; "
        f"      }} "
        f"    }}; "
        f"    saveRDS(df, rds) "
        f"  }} "
        f"}})"
    )


_R_PATHOGENFLOWS_CACHE = (
    "local({"
    " .pf_cache_dir <- '/tmp/pf_csv_cache'; dir.create(.pf_cache_dir, showWarnings=FALSE, recursive=TRUE);"
    " .pf_urls <- c("
    "  k2p='http://data.waterpathogens.org/dataset/eda3c64c-479e-4177-869c-93b3dc247a10/resource/f99291ab-d536-4536-a146-083a07ea49b9/download/k2p_persistence.csv',"
    "  jmp='http://data.waterpathogens.org/dataset/86741b90-62ab-4dc2-941c-60c85bfe7ffc/resource/9113d653-0e10-4b4d-9159-344c494f7fc7/download/jmp_assumptions.csv'"
    " );"
    " for (nm in names(.pf_urls)) {"
    "  dest <- file.path(.pf_cache_dir, paste0(nm, '.csv'));"
    "  if (!file.exists(dest) || file.size(dest) < 1000) {"
    "   for (att in 1:5) {"
    "    tryCatch(suppressWarnings(download.file(.pf_urls[[nm]], dest, quiet=TRUE)),"
    "     error=function(e) NULL);"
    "    if (file.exists(dest) && file.size(dest) > 1000) break;"
    "    if (file.exists(dest)) file.remove(dest)"
    "   }"
    "  }"
    " };"
    " .pf_map <- setNames(as.list(file.path(.pf_cache_dir, paste0(names(.pf_urls), '.csv'))), .pf_urls);"
    " .orig_read_csv <- utils::read.csv;"
    " .patched_read_csv <- function(file, ...) {"
    "  if (is.character(file) && !is.null(.pf_map[[file]]) && file.exists(.pf_map[[file]])) file <- .pf_map[[file]];"
    "  .orig_read_csv(file, ...)"
    " };"
    " env <- getNamespace('utils');"
    " base::unlockBinding('read.csv', env);"
    " assign('read.csv', .patched_read_csv, envir=env)"
    "}); "
)


def build_r_expr_exec(cs_folder_name, folder, yaml_filename, cs_path=None, wwtp_mode='POINT'):
    """R expression for docker exec mode."""
    if cs_path:
        def _rel(fname):
            full = _resolve_data_path(cs_path, folder, fname)
            return os.path.relpath(full, cs_path).replace(os.sep, '/')
        iso_csv = _rel('isodata.csv')
        iso_rds = _rel('isodata.RDS')
        tr_csv  = _rel('treatment.csv')
        tr_rds  = _rel('treatment.RDS')
    else:
        iso_csv = f'input/{folder}/isodata.csv'
        iso_rds = f'input/{folder}/isodata.RDS'
        tr_csv  = f'input/{folder}/treatment.csv'
        tr_rds  = f'input/{folder}/treatment.RDS'

    ls = _detect_livestock_module(cs_path, folder) if cs_path else None
    livestock_rds_snippets = []
    if ls:
        def _ls_rel(sub):
            return os.path.relpath(os.path.join(ls['dir'], sub), cs_path).replace(os.sep, '/')
        for fname in ('manure_management', 'production_systems', 'manure_fractions'):
            if os.path.exists(os.path.join(ls['dir'], f'{fname}.csv')):
                livestock_rds_snippets.append(
                    _r_csv_to_rds_snippet(_ls_rel(f'{fname}.csv'), _ls_rel(f'{fname}.RDS'))
                )
        for animal, info in ls['animals'].items():
            if info['has_isodata']:
                livestock_rds_snippets.append(
                    _r_csv_to_rds_snippet(
                        _ls_rel(f'animals/isodata_{animal}.csv'),
                        _ls_rel(f'animals/isodata_{animal}.RDS'),
                    )
                )
    livestock_rds_block = ('; '.join(livestock_rds_snippets) + '; ') if livestock_rds_snippets else ''

    return (
        f"setwd('/app/data/{cs_folder_name}'); "
        f"local({{"
        f"{_r_iso_csv_to_rds_snippet(iso_csv, iso_rds, tr_csv)}; "
        f"if (file.exists('{tr_csv}')) {{ {_r_csv_to_rds_snippet(tr_csv, tr_rds)} }}"
        + (f'; {livestock_rds_block}' if livestock_rds_block else '')
        + f"}}); "
        f"library(glowpa); "
        f"local({{p <- as.data.frame(glowpa:::pathogens); "
        f"p[is.na(p[,'storage_time']),'storage_time'] <- 274L; "
        f"p[is.na(p[,'storage_time_low']),'storage_time_low'] <- 30L; "
        f"p[p[,'name']=='rotavirus','Tcoeff_1'] <- -2.5586; "
        f"p[p[,'name']=='rotavirus','Tcoeff_2'] <- 119.63; "
        f"utils::assignInNamespace('pathogens', p, ns='glowpa')}}); "
        f"local({{"
        f".patch <- function(fn_name) {{"
        f"  env <- asNamespace('glowpa'); fn <- get(fn_name, envir=env); "
        f"  ne <- new.env(parent=environment(fn)); ne$sym <- rlang::sym; "
        f"  environment(fn) <- ne; "
        f"  base::unlockBinding(fn_name, env); "
        f"  assign(fn_name, fn, envir=env); "
        f"  base::lockBinding(fn_name, env)"
        f"}}; "
        f"for (.fn in c('pathways_land','output_table_livestock','output_table_human',"
        f"'animal_emission','livstock_manure_frac_to_grid','output_sink_table',"
        f"'pathways_humans_rast','prepare_livestock_vermeulen','routing',"
        f"'wwtp_area_emissions_to_grid')) {{"
        f"  tryCatch(.patch(.fn), error=function(e) NULL)"
        f"}}"
        f"}}); "
        f"glowpa_init('config/{yaml_filename}'); "
        f"glowpa_start()"
    )


def build_r_expr_run(yaml_filename, cs_path=None, folder=None, wwtp_mode='POINT'):
    """R expression for docker run mode."""
    if cs_path and folder:
        def _rel(fname):
            full = _resolve_data_path(cs_path, folder, fname)
            base = os.path.join(cs_path, 'input', folder)
            return os.path.relpath(full, base).replace(os.sep, '/')
        iso_csv = f'/app/input/{_rel("isodata.csv")}'
        iso_rds = f'/app/input/{_rel("isodata.RDS")}'
        tr_csv  = f'/app/input/{_rel("treatment.csv")}'
        tr_rds  = f'/app/input/{_rel("treatment.RDS")}'
    else:
        iso_csv = '/app/input/isodata.csv'
        iso_rds = '/app/input/isodata.RDS'
        tr_csv  = '/app/input/treatment.csv'
        tr_rds  = '/app/input/treatment.RDS'

    ls = _detect_livestock_module(cs_path, folder) if (cs_path and folder) else None
    livestock_rds_snippets = []
    if ls:
        def _ls_flat(sub):
            abs_p = os.path.join(ls['dir'], sub)
            base  = os.path.join(cs_path, 'input', folder)
            return '/app/input/' + os.path.relpath(abs_p, base).replace(os.sep, '/')
        for fname in ('manure_management', 'production_systems', 'manure_fractions'):
            if os.path.exists(os.path.join(ls['dir'], f'{fname}.csv')):
                livestock_rds_snippets.append(
                    _r_csv_to_rds_snippet(_ls_flat(f'{fname}.csv'), _ls_flat(f'{fname}.RDS'))
                )
        for animal, info in ls['animals'].items():
            if info['has_isodata']:
                livestock_rds_snippets.append(
                    _r_csv_to_rds_snippet(
                        _ls_flat(f'animals/isodata_{animal}.csv'),
                        _ls_flat(f'animals/isodata_{animal}.RDS'),
                    )
                )
    livestock_rds_block = ('; '.join(livestock_rds_snippets) + '; ') if livestock_rds_snippets else ''

    return (
        f"local({{"
        f"{_r_iso_csv_to_rds_snippet(iso_csv, iso_rds, tr_csv)}; "
        + (f"if (file.exists('{tr_csv}')) {{ {_r_csv_to_rds_snippet(tr_csv, tr_rds)} }}" if wwtp_mode == 'POINT' else "")
        + (f'; {livestock_rds_block}' if livestock_rds_block else '')
        + f"}}); "
        f"library(glowpa); "
        f"local({{p <- as.data.frame(glowpa:::pathogens); "
        f"p[is.na(p[,'storage_time']),'storage_time'] <- 274L; "
        f"p[is.na(p[,'storage_time_low']),'storage_time_low'] <- 30L; "
        f"p[p[,'name']=='rotavirus','Tcoeff_1'] <- -2.5586; "
        f"p[p[,'name']=='rotavirus','Tcoeff_2'] <- 119.63; "
        f"utils::assignInNamespace('pathogens', p, ns='glowpa')}}); "
        f"local({{"
        f".patch <- function(fn_name) {{"
        f"  env <- asNamespace('glowpa'); fn <- get(fn_name, envir=env); "
        f"  ne <- new.env(parent=environment(fn)); ne$sym <- rlang::sym; "
        f"  environment(fn) <- ne; "
        f"  base::unlockBinding(fn_name, env); "
        f"  assign(fn_name, fn, envir=env); "
        f"  base::lockBinding(fn_name, env)"
        f"}}; "
        f"for (.fn in c('pathways_land','output_table_livestock','output_table_human',"
        f"'animal_emission','livstock_manure_frac_to_grid','output_sink_table',"
        f"'pathways_humans_rast','prepare_livestock_vermeulen','routing',"
        f"'wwtp_area_emissions_to_grid')) {{"
        f"  tryCatch(.patch(.fn), error=function(e) NULL)"
        f"}}"
        f"}}); "
        f"glowpa_init('/app/config/{yaml_filename}'); "
        f"glowpa_start()"
    )


# Backwards-compat alias
build_prepare_and_run_r_expr = build_r_expr_exec


# ──────────────────────────────────────────────────────────────────────────────
# Docker helpers
# ──────────────────────────────────────────────────────────────────────────────

def _get_docker_client():
    """Return a docker.DockerClient connected via unix socket, or None on failure."""
    try:
        client = docker.DockerClient(base_url=DOCKER_SOCK)
        client.ping()
        return client
    except Exception:
        return None


def _glowpa_container_running():
    client = _get_docker_client()
    if client is None:
        return False
    try:
        container = client.containers.get('glowpa-container')
        return container.status == 'running'
    except Exception:
        return False


def build_model_cmd(cs_path, cs_folder_name, folder, yaml_filename, wwtp_mode='POINT'):
    """Return (params_dict, mode) for running the model."""
    if _glowpa_container_running():
        r_expr = build_r_expr_exec(cs_folder_name, folder, yaml_filename, cs_path=cs_path, wwtp_mode=wwtp_mode)
        script_host = os.path.join(cs_path, 'glowpa_run.R')
        script_cont = f'/app/data/{cs_folder_name}/glowpa_run.R'
        with open(script_host, 'w', encoding='utf-8') as _sf:
            _sf.write(r_expr + '\n')
        return {
            'type': 'exec',
            'container': 'glowpa-container',
            'command': ['Rscript', script_cont],
            'script_host': script_host,
        }, 'exec'
    else:
        input_path  = os.path.join(cs_path, 'input', folder)
        output_path = os.path.join(cs_path, 'output', folder)
        config_path = os.path.join(cs_path, 'config')
        r_expr = build_r_expr_run(yaml_filename, cs_path=cs_path, folder=folder, wwtp_mode=wwtp_mode)
        os.makedirs(output_path, exist_ok=True)
        script_host = os.path.join(output_path, 'glowpa_run.R')
        script_cont = '/app/output/glowpa_run.R'
        with open(script_host, 'w', encoding='utf-8') as _sf:
            _sf.write(r_expr + '\n')
        return {
            'type': 'run',
            'image': GLOWPA_IMAGE,
            'command': ['Rscript', script_cont],
            'volumes': {
                input_path:  {'bind': '/app/input',  'mode': 'rw'},
                output_path: {'bind': '/app/output', 'mode': 'rw'},
                config_path: {'bind': '/app/config', 'mode': 'ro'},
            },
            'script_host': script_host,
        }, 'run'


def _execute_model_run(run_id, params):
    """Background thread: run glowpa via Docker SDK and record output."""
    client = None
    try:
        model_runs[run_id]['status'] = 'running'
        client = _get_docker_client()
        if client is None:
            raise RuntimeError('Cannot connect to Docker socket at ' + DOCKER_SOCK)

        if params['type'] == 'exec':
            container = client.containers.get(params['container'])
            result = container.exec_run(
                params['command'],
                stdout=True, stderr=True, demux=True,
            )
            stdout_b, stderr_b = result.output if result.output else (b'', b'')
            stdout = (stdout_b or b'').decode('utf-8', errors='replace')
            stderr = (stderr_b or b'').decode('utf-8', errors='replace')
            exit_code = result.exit_code
        else:
            output_b = client.containers.run(
                params['image'],
                command=params['command'],
                volumes=params['volumes'],
                remove=True,
                stdout=True, stderr=True,
            )
            stdout = (output_b or b'').decode('utf-8', errors='replace')
            stderr = ''
            exit_code = 0

        model_runs[run_id]['stdout'] = stdout
        model_runs[run_id]['stderr'] = stderr
        model_runs[run_id]['return_code'] = exit_code

        cs_path = model_runs[run_id].get('cs_path', '')
        folder = model_runs[run_id].get('folder', '')
        log_file_content = ''
        if cs_path and folder:
            log_path = os.path.join(cs_path, 'output', folder, 'glowpa.log')
            try:
                with open(log_path, 'r', encoding='utf-8', errors='replace') as _lf:
                    log_file_content = _lf.read()
            except OSError:
                pass

        combined = stdout + '\n' + stderr + '\n' + log_file_content
        finished_simulation = 'Finished GloWPa simulation' in combined

        output_files = []
        if cs_path and folder:
            output_dir = os.path.join(cs_path, 'output', folder)
            if os.path.isdir(output_dir):
                output_files = sorted(
                    f for f in os.listdir(output_dir)
                    if not f.endswith('.log')
                )
        model_runs[run_id]['output_files'] = output_files

        finished_livestock = (
            'Finished livestock emissions' in combined
            and len(output_files) > 0
        )

        simulation_complete = finished_simulation or finished_livestock
        model_runs[run_id]['simulation_complete'] = simulation_complete
        model_runs[run_id]['status'] = 'success' if (exit_code == 0 and simulation_complete) else 'error'

        if model_runs[run_id]['status'] == 'success' and model_runs[run_id].get('include_risk'):
            from qmra import _trigger_qmra_run
            scenario_id = model_runs[run_id]['scenario_id']
            cs, scenario_folder = _locate_scenario(scenario_id)
            risk_run_id = _trigger_qmra_run(scenario_id, cs, scenario_folder)
            if risk_run_id:
                model_runs[run_id]['risk_run_id'] = risk_run_id
            else:
                model_runs[run_id]['risk_error'] = 'Risk estimation could not be started.'

        if cs_path and folder:
            exec_log = os.path.join(cs_path, 'output', folder, 'glowpa.log')
            if not os.path.exists(exec_log):
                run_log = os.path.join(cs_path, 'output', folder, 'glowpa.log')
                r_output = (stdout or '') + ('\n' + stderr if stderr else '')
                if r_output.strip():
                    try:
                        os.makedirs(os.path.dirname(run_log), exist_ok=True)
                        with open(run_log, 'w', encoding='utf-8') as _lf:
                            _lf.write('[R session output — GloWPa log not created; R crashed before glowpa_init]\n\n')
                            _lf.write(r_output)
                    except OSError:
                        pass
            elif not simulation_complete:
                r_crash = (stderr or '').strip()
                if not r_crash:
                    r_crash = '\n'.join(
                        line for line in (stdout or '').splitlines()
                        if line.startswith(('Error', 'Warning', 'Error in', 'Execution halted'))
                    ).strip()
                if r_crash:
                    try:
                        with open(exec_log, 'a', encoding='utf-8') as _lf:
                            _lf.write('\n[R process stderr — captured after unexpected exit]\n')
                            _lf.write(r_crash)
                            _lf.write('\n')
                    except OSError:
                        pass

        if not model_runs[run_id].get('debug_mode', False):
            _cleanup_rds_files(run_id)
    except docker.errors.ContainerError as exc:
        model_runs[run_id]['status'] = 'error'
        model_runs[run_id]['stderr'] = (exc.stderr or b'').decode('utf-8', errors='replace')
        model_runs[run_id]['return_code'] = exc.exit_status
    except Exception as exc:
        model_runs[run_id]['status'] = 'error'
        model_runs[run_id]['stderr'] = str(exc)
    finally:
        script_host = params.get('script_host')
        if script_host and os.path.exists(script_host):
            try:
                os.remove(script_host)
            except OSError:
                pass
        model_runs[run_id]['finished_at'] = datetime.now().isoformat()
        if client:
            try:
                client.close()
            except Exception:
                pass


def _cleanup_rds_files(run_id):
    """Delete .RDS files generated during a model run."""
    run = model_runs.get(run_id, {})
    cs_path = run.get('cs_path', '')
    folder = run.get('folder', '')
    if not (cs_path and folder):
        return

    def _del(path):
        if os.path.exists(path):
            try:
                os.remove(path)
                print(f'[model-run] Deleted {path}')
            except Exception as e:
                print(f'[model-run] Could not delete {path}: {e}')

    for rds_name in ['isodata.RDS', 'treatment.RDS']:
        _del(_resolve_data_path(cs_path, folder, rds_name))
    ls = _detect_livestock_module(cs_path, folder)
    if ls:
        for fname in ('manure_management.RDS', 'production_systems.RDS', 'manure_fractions.RDS'):
            _del(os.path.join(ls['dir'], fname))
        if os.path.isdir(ls['animals_dir']):
            for fname in os.listdir(ls['animals_dir']):
                if fname.lower().endswith('.rds'):
                    _del(os.path.join(ls['animals_dir'], fname))


# ──────────────────────────────────────────────────────────────────────────────
# Endpoint handlers
# ──────────────────────────────────────────────────────────────────────────────

def start_glowpa():
    try:
        data = request.get_json() or {}
        case_study_id = data.get('case_study_id')

        check_result = subprocess.run(['docker', 'ps', '--filter', 'name=glowpa-container', '--format', '{{.Status}}'],
                                      capture_output=True, text=True, timeout=10)

        if check_result.returncode == 0 and check_result.stdout.strip() and 'Up' in check_result.stdout:
            state.glowpa_running = True
            return jsonify({"status": "success", "message": "GloWPa container is already running"})

        result = subprocess.run(['docker', 'start', 'glowpa-container'],
                                capture_output=True, text=True, timeout=30)

        if result.returncode == 0:
            state.glowpa_running = True
            if case_study_id:
                cs = next((c for c in case_studies if c['id'] == case_study_id), None)
                if cs:
                    message = f"GloWPa started for case study: {cs['name']}"
                else:
                    message = "GloWPa started (case study not found)"
            else:
                message = "GloWPa container started successfully"
            return jsonify({"status": "success", "message": message})
        else:
            error_msg = result.stderr.strip() if result.stderr else "Failed to start container"
            return jsonify({"status": "error", "message": f"Failed to start GloWPa: {error_msg}"}), 500

    except subprocess.TimeoutExpired:
        return jsonify({"status": "error", "message": "Timeout while starting GloWPa container"}), 500
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


def stop_glowpa_frontend():
    """Frontend variant: actually stops the container."""
    try:
        result = subprocess.run(['docker', 'stop', 'glowpa-container'],
                                capture_output=True, text=True, timeout=30)
        if result.returncode == 0:
            state.glowpa_running = False
            return jsonify({"status": "success", "message": "GloWPa container stopped successfully"})
        else:
            error_msg = result.stderr.strip() if result.stderr else "Failed to stop container"
            return jsonify({"status": "error", "message": f"Failed to stop GloWPa: {error_msg}"}), 500
    except subprocess.TimeoutExpired:
        return jsonify({"status": "error", "message": "Timeout while stopping GloWPa container"}), 500
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


def stop_glowpa_main():
    """Main-app variant: logs the stop command (legacy behavior on port 5000)."""
    try:
        with open('/app/data/docker_commands.txt', 'a') as f:
            f.write(f"# Stop command requested at {datetime.now()}\n")
            f.write("docker stop glowpa-container\n\n")

        state.glowpa_running = False
        return jsonify({
            "status": "success",
            "message": "Stop command logged. Please run 'docker stop glowpa-container' manually to actually stop the container."
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


def glowpa_status():
    try:
        import socket
        socket.gethostbyname('glowpa-container')
        return jsonify({"glowpa_status": "connected", "message": "Container hostname resolves"})
    except Exception as e:
        if isinstance(e, __import__('socket').gaierror):
            return jsonify({"glowpa_status": "disconnected", "message": "Container hostname not found"})
        return jsonify({"glowpa_status": "disconnected", "error": str(e)})


def generate_yaml(scenario_id):
    """Generate and save the YAML config file for a scenario."""
    try:
        cs, folder = _locate_scenario(scenario_id)
        cs_path = cs['folder_path']
        pathogen = ''
        meta_path = os.path.join(cs_path, 'config', 'scenario_metadata.csv')
        with open(meta_path, 'r', newline='', encoding='utf-8') as f:
            for row in csv.DictReader(f):
                if row['scenario_id'] == scenario_id:
                    pathogen = row.get('pathogen', '')
                    break
        yaml_filename = f"{folder}_config.yaml"
        yaml_path = os.path.join(cs_path, 'config', yaml_filename)
        mode = 'exec' if _glowpa_container_running() else 'run'
        wwtp_mode = _detect_wwtp_mode(cs_path, folder)
        yaml_content = generate_yaml_content(folder, pathogen, flat=(mode == 'run'), cs_path=cs_path, wwtp_mode=wwtp_mode)
        os.makedirs(os.path.dirname(yaml_path), exist_ok=True)
        with open(yaml_path, 'w', encoding='utf-8') as f:
            f.write(yaml_content)
        return jsonify({
            'yaml_content': yaml_content,
            'yaml_path': yaml_path,
            'yaml_filename': yaml_filename,
            'mode': mode,
            'wwtp_mode': wwtp_mode,
        }), 200
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


def diagnose_scenario(scenario_id):
    """Return diagnostic info for a scenario."""
    try:
        cs, folder = _locate_scenario(scenario_id)
        cs_path = cs['folder_path']
        cs_folder_name = cs.get('folder_name', '')
        pathogen = ''
        meta_path = os.path.join(cs_path, 'config', 'scenario_metadata.csv')
        with open(meta_path, 'r', newline='', encoding='utf-8') as f:
            for row in csv.DictReader(f):
                if row['scenario_id'] == scenario_id:
                    pathogen = row.get('pathogen', '')
                    break
        yaml_filename = f"{folder}_config.yaml"
        mode = 'exec' if _glowpa_container_running() else 'run'
        wwtp_mode = _detect_wwtp_mode(cs_path, folder)
        yaml_content = generate_yaml_content(folder, pathogen, flat=(mode == 'run'), cs_path=cs_path, wwtp_mode=wwtp_mode)
        ls = _detect_livestock_module(cs_path, folder)
        hy = _detect_hydrology_module(cs_path, folder)
        if mode == 'exec':
            r_expr = build_r_expr_exec(cs_folder_name, folder, yaml_filename, cs_path=cs_path, wwtp_mode=wwtp_mode)
        else:
            r_expr = build_r_expr_run(yaml_filename, cs_path=cs_path, folder=folder, wwtp_mode=wwtp_mode)
        rds_files = {}
        for fname in ['isodata.RDS', 'treatment.RDS']:
            p = _resolve_data_path(cs_path, folder, fname)
            rds_files[fname] = {'exists': os.path.exists(p), 'path': p}
        log_path = os.path.join(cs_path, 'output', folder, 'glowpa.log')
        return jsonify({
            'mode': mode,
            'wwtp_mode': wwtp_mode,
            'pathogen': pathogen,
            'folder': folder,
            'yaml_content': yaml_content,
            'r_expression': r_expr,
            'livestock_detected': ls is not None,
            'livestock_animals': list(ls['animals'].keys()) if ls else [],
            'temperature_tif': ls['temperature_tif'] if ls else None,
            'hydrology_detected': hy is not None,
            'rds_files': rds_files,
            'log_exists': os.path.exists(log_path),
            'log_path': log_path,
        }), 200
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404
    except Exception as exc:
        return jsonify({'error': str(exc), 'traceback': traceback.format_exc()}), 500


def run_model(scenario_id):
    """Start the glowpa model for a scenario."""
    try:
        body = request.get_json(silent=True) or {}
        debug_mode = bool(body.get('debug_mode', False))
        include_risk = bool(body.get('include_risk', False))

        cs, folder = _locate_scenario(scenario_id)
        cs_path = cs['folder_path']
        cs_folder_name = cs.get('folder_name', '')
        pathogen = ''
        meta_path = os.path.join(cs_path, 'config', 'scenario_metadata.csv')
        with open(meta_path, 'r', newline='', encoding='utf-8') as f:
            for row in csv.DictReader(f):
                if row['scenario_id'] == scenario_id:
                    pathogen = row.get('pathogen', '')
                    break
        yaml_filename = f"{folder}_config.yaml"
        yaml_path = os.path.join(cs_path, 'config', yaml_filename)
        wwtp_mode = _detect_wwtp_mode(cs_path, folder)
        params, mode = build_model_cmd(cs_path, cs_folder_name, folder, yaml_filename, wwtp_mode=wwtp_mode)
        yaml_content = generate_yaml_content(folder, pathogen, flat=(mode == 'run'), cs_path=cs_path, wwtp_mode=wwtp_mode)
        os.makedirs(os.path.dirname(yaml_path), exist_ok=True)
        with open(yaml_path, 'w', encoding='utf-8') as f:
            f.write(yaml_content)
        os.makedirs(os.path.join(cs_path, 'output', folder), exist_ok=True)
        run_id = str(uuid.uuid4())
        model_runs[run_id] = {
            'status': 'pending',
            'mode': mode,
            'scenario_id': scenario_id,
            'cs_path': cs_path,
            'folder': folder,
            'debug_mode': debug_mode,
            'include_risk': include_risk,
            'risk_run_id': None,
            'risk_error': None,
            'started_at': datetime.now().isoformat(),
            'finished_at': None,
            'stdout': '',
            'stderr': '',
            'return_code': None,
            'simulation_complete': False,
            'output_files': [],
        }
        threading.Thread(target=_execute_model_run, args=(run_id, params), daemon=True).start()
        return jsonify({'status': 'started', 'run_id': run_id, 'mode': mode}), 202
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


def run_status(run_id):
    """Poll the status of a model run."""
    run = model_runs.get(run_id)
    if not run:
        return jsonify({'error': 'Run not found'}), 404
    response = dict(run)
    risk_run_id = run.get('risk_run_id')
    if risk_run_id:
        risk_run = model_runs.get(risk_run_id, {})
        response['risk_status'] = risk_run.get('status')
        if run.get('status') == 'success' and risk_run.get('status') in ('queued', 'running'):
            response['status'] = 'risk_running'
        elif risk_run.get('status') == 'error':
            response['status'] = 'error'
            response['stderr'] = risk_run.get('stderr') or 'Risk estimation failed.'
    elif run.get('status') == 'success' and run.get('include_risk') and not run.get('risk_error'):
        response['status'] = 'running'
    elif run.get('status') == 'success' and run.get('include_risk') and run.get('risk_error'):
        response['status'] = 'error'
        response['stderr'] = run['risk_error']
    return jsonify(response), 200


def get_glowpa_log(scenario_id):
    """Return the contents of glowpa.log for a scenario."""
    try:
        cs, folder = _locate_scenario(scenario_id)
        cs_path = cs['folder_path']
        tail = int(request.args.get('tail', 500))

        candidates = [
            os.path.join(cs_path, 'output', folder, 'glowpa.log'),
            os.path.join(cs_path, 'output', 'glowpa.log'),
        ]
        log_path = next((p for p in candidates if os.path.exists(p)), None)

        if log_path is None:
            return jsonify({
                'exists': False,
                'content': '',
                'path': candidates[0],
                'lines': 0,
            }), 200

        with open(log_path, 'r', encoding='utf-8', errors='replace') as fh:
            all_lines = fh.readlines()

        trimmed = all_lines[-tail:] if tail > 0 else all_lines
        return jsonify({
            'exists': True,
            'content': ''.join(trimmed),
            'path': log_path,
            'lines': len(all_lines),
        }), 200
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 404
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


def get_container_logs():
    """Return docker logs from the persistent glowpa-container via Docker SDK."""
    tail = int(request.args.get('tail', 200))
    client = None
    try:
        client = _get_docker_client()
        if client is None:
            return jsonify({'error': 'Cannot connect to Docker socket. Is /var/run/docker.sock mounted?'}), 500
        try:
            container = client.containers.get('glowpa-container')
        except docker.errors.NotFound:
            return jsonify({'error': 'glowpa-container not found'}), 404
        log_bytes = container.logs(stdout=True, stderr=True, tail=tail, timestamps=False)
        log_text = log_bytes.decode('utf-8', errors='replace') if isinstance(log_bytes, bytes) else log_bytes
        return jsonify({
            'stdout': log_text,
            'stderr': '',
            'combined': log_text,
            'return_code': 0,
        }), 200
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500
    finally:
        if client:
            try:
                client.close()
            except Exception:
                pass


# ──────────────────────────────────────────────────────────────────────────────
# Route registration
# ──────────────────────────────────────────────────────────────────────────────

def register_routes(app, frontend_app):
    # Status & start: same handler on both apps.
    for app_obj, prefix in ((app, 'main'), (frontend_app, 'frontend')):
        app_obj.add_url_rule('/api/glowpa-status',
                             endpoint=f'{prefix}_glowpa_status',
                             view_func=glowpa_status)
        app_obj.add_url_rule('/api/glowpa/start',
                             endpoint=f'{prefix}_start_glowpa',
                             view_func=start_glowpa, methods=['POST'])
        app_obj.add_url_rule('/api/scenarios/<scenario_id>/generate-yaml',
                             endpoint=f'{prefix}_generate_yaml',
                             view_func=generate_yaml, methods=['POST'])
        app_obj.add_url_rule('/api/scenarios/<scenario_id>/diagnose',
                             endpoint=f'{prefix}_diagnose_scenario',
                             view_func=diagnose_scenario, methods=['GET'])
        app_obj.add_url_rule('/api/scenarios/<scenario_id>/run-model',
                             endpoint=f'{prefix}_run_model',
                             view_func=run_model, methods=['POST'])
        app_obj.add_url_rule('/api/run-status/<run_id>',
                             endpoint=f'{prefix}_run_status',
                             view_func=run_status)
        app_obj.add_url_rule('/api/scenarios/<scenario_id>/glowpa-log',
                             endpoint=f'{prefix}_get_glowpa_log',
                             view_func=get_glowpa_log)
        app_obj.add_url_rule('/api/glowpa/container-logs',
                             endpoint=f'{prefix}_get_container_logs',
                             view_func=get_container_logs)

    # Stop differs between the two apps (legacy behaviour preserved).
    frontend_app.add_url_rule('/api/glowpa/stop',
                              endpoint='frontend_stop_glowpa',
                              view_func=stop_glowpa_frontend, methods=['POST'])
    app.add_url_rule('/api/glowpa/stop',
                     endpoint='main_stop_glowpa',
                     view_func=stop_glowpa_main, methods=['POST'])

    # Pathogens config endpoint mirrored on both apps.
    for app_obj, prefix in ((app, 'main'), (frontend_app, 'frontend')):
        app_obj.add_url_rule('/api/config/pathogens',
                             endpoint=f'{prefix}_get_pathogens',
                             view_func=get_pathogens, methods=['GET'])


# ──────────────────────────────────────────────────────────────────────────────
# Pathogens config (fetched from glowpa source repo / installed extdata)
# ──────────────────────────────────────────────────────────────────────────────

def _exec_glowpa(cmd):
    """Run a shell command inside glowpa-container. Returns stdout string or raises."""
    if state.docker_client:
        try:
            container = state.docker_client.containers.get('glowpa-container')
            exit_code, output = container.exec_run(cmd)
            if exit_code == 0:
                return output.decode('utf-8')
            raise RuntimeError(output.decode('utf-8', errors='replace'))
        except RuntimeError:
            raise  # command ran but returned non-zero — don't mask with CLI fallback
        except Exception as sdk_err:
            print(f'[config] Docker SDK exec failed, falling back to CLI: {sdk_err}')
    result = subprocess.run(
        ['docker', 'exec', 'glowpa-container'] + cmd.split(),
        capture_output=True, text=True, timeout=15
    )
    if result.returncode != 0:
        raise RuntimeError(f'docker exec failed: {result.stderr.strip()}')
    return result.stdout


def _parse_description(text):
    """Parse key: value pairs from an R DESCRIPTION file (handles line continuations)."""
    fields = {}
    current_key = None
    for line in text.splitlines():
        if line and line[0] != ' ' and ':' in line:
            key, _, val = line.partition(':')
            current_key = key.strip()
            fields[current_key] = val.strip()
        elif current_key and line.startswith(' '):
            fields[current_key] = (fields[current_key] + ' ' + line.strip()).strip()
    return fields


def _fetch_dataraw_pathogens():
    """Try to download data-raw/pathogens.csv from the glowpa GitLab source repo.

    Reads RemoteUrl and RemoteSha from the installed DESCRIPTION file so the
    fetched file always matches the installed package version.
    Returns CSV text, or None if the fetch fails.
    """
    try:
        desc_text = _exec_glowpa(f'cat {GLOWPA_DESCRIPTION_PATH}')
        fields = _parse_description(desc_text)
        remote_url = fields.get('RemoteUrl', '').rstrip('/')
        remote_sha = fields.get('RemoteSha', '')
        if not remote_url or not remote_sha:
            print('[config] RemoteUrl/RemoteSha not found in DESCRIPTION')
            return None
        # GitLab raw URL: <repo>/-/raw/<sha>/<path>
        raw_url = f"{remote_url.removesuffix('.git')}/-/raw/{remote_sha}/{GLOWPA_DATARAW_PATHOGENS}"
        print(f'[config] Fetching pathogens from {raw_url}')
        resp = requests.get(raw_url, timeout=15)
        resp.raise_for_status()
        print('[config] Successfully fetched data-raw/pathogens.csv from source repo')
        return resp.text
    except Exception as e:
        print(f'[config] Source-repo fetch failed: {e}')
        return None


def _read_pathogens():
    """Return the pathogens list, fetching/caching on first call.

    Priority:
      1. data-raw/pathogens.csv from the glowpa GitLab source repo (HTTP fetch)
      2. extdata/kla/pathogen_inputs.csv from the installed package (docker exec)
    """
    if state._pathogens_cache is not None:
        return state._pathogens_cache

    # 1. Try source repo
    csv_text = _fetch_dataraw_pathogens()

    # 2. Fall back to installed extdata file
    if csv_text is None:
        print(f'[config] Falling back to installed extdata: {GLOWPA_EXTDATA_PATHOGENS}')
        csv_text = _exec_glowpa(f'cat {GLOWPA_EXTDATA_PATHOGENS}')

    reader = csv.DictReader(io.StringIO(csv_text))
    pathogens = [dict(row) for row in reader]
    state._pathogens_cache = pathogens
    print(f'[config] Loaded {len(pathogens)} pathogen(s)')
    return pathogens


def get_pathogens():
    try:
        pathogens = _read_pathogens()
        return jsonify({'pathogens': pathogens})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


def _prefetch_pathogens():
    """Pre-warm the pathogens cache so the first UI request is instant."""
    try:
        _read_pathogens()
    except Exception as e:
        print(f'[config] Background pathogens prefetch failed (will retry on first request): {e}')
