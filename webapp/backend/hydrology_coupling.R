# Cell totals are distributed by overlap, not interpolated or averaged.
wp_axis_weights <- function(source_edges, target_edges, latitude = FALSE) {
  measure <- if (latitude) function(x) sin(x * pi / 180) else identity
  entries <- lapply(seq_len(length(source_edges) - 1L), function(i) {
    lo <- source_edges[i]
    hi <- source_edges[i + 1L]
    first <- max(1L, findInterval(lo, target_edges))
    last <- min(length(target_edges) - 1L, findInterval(hi, target_edges))
    if (first > last) return(NULL)
    j <- seq.int(first, last)
    lower <- pmax(lo, target_edges[j])
    upper <- pmin(hi, target_edges[j + 1L])
    keep <- upper > lower
    # A cell touching the target's west/south edge from outside has zero overlap;
    # cbind would drop the empty columns and break the rbind below.
    if (!any(keep)) return(NULL)
    cbind(target = j[keep], source = i,
          weight = (measure(upper[keep]) - measure(lower[keep])) /
            (measure(hi) - measure(lo)))
  })
  entries <- do.call(rbind, entries)
  if (is.null(entries)) stop("Emissions and hydrology grids do not overlap.")
  Matrix::sparseMatrix(i = entries[, "target"], j = entries[, "source"],
                      x = entries[, "weight"],
                      dims = c(length(target_edges) - 1L, length(source_edges) - 1L))
}

wp_grid_weights <- function(source, target) {
  if (!terra::same.crs(source, target)) {
    stop("Coupling requires a shared CRS; input rasters were not modified.")
  }
  x_weights <- wp_axis_weights(
    seq(terra::xmin(source), terra::xmax(source), length.out = terra::ncol(source) + 1L),
    seq(terra::xmin(target), terra::xmax(target), length.out = terra::ncol(target) + 1L))
  y_weights <- wp_axis_weights(
    seq(terra::ymin(source), terra::ymax(source), length.out = terra::nrow(source) + 1L),
    seq(terra::ymin(target), terra::ymax(target), length.out = terra::nrow(target) + 1L),
    latitude = terra::is.lonlat(source))
  # Raster rows are north-to-south; overlap matrices use ascending coordinates.
  y_weights <- y_weights[terra::nrow(target):1L, terra::nrow(source):1L, drop = FALSE]
  list(x = x_weights, y = y_weights)
}

wp_sum_to_grid <- function(source, target, label) {
  if (terra::nlyr(source) != 1L) stop(label, ": expected one annual-total band.")
  weights <- wp_grid_weights(source, target)
  totals <- matrix(0, terra::nrow(target), terra::ncol(target))
  source_total <- 0
  terra::readStart(source)
  on.exit(terra::readStop(source))
  for (first in seq.int(1L, terra::nrow(source), by = 256L)) {
    nrows <- min(256L, terra::nrow(source) - first + 1L)
    values <- terra::readValues(source, row = first, nrows = nrows)
    if (any(is.infinite(values)) || any(values < 0, na.rm = TRUE)) {
      stop(label, ": loads must be finite and non-negative (NoData is allowed).")
    }
    values[is.na(values)] <- 0
    source_total <- source_total + sum(values)
    block <- matrix(values, nrow = nrows, byrow = TRUE)
    rows <- seq.int(first, length.out = nrows)
    totals <- totals + as.matrix(weights$y[, rows, drop = FALSE] %*%
                                  block %*% Matrix::t(weights$x))
  }
  target_total <- sum(totals)
  tolerance <- max(1e-8, abs(source_total) * 1e-9)
  if (abs(target_total - source_total) > tolerance) {
    stop(sprintf("%s: load conservation failed (input %.17g, transferred %.17g); check hydrology coverage.",
                 label, source_total, target_total))
  }
  result <- terra::rast(target, vals = as.vector(t(totals)))
  names(result) <- label
  attr(result, "conservation") <- c(source_total = source_total, target_total = target_total)
  result
}

wp_fraction_to_grid <- function(fraction, target) {
  if (terra::nlyr(fraction) != 1L) stop("Expected one annual runoff fraction band.")
  weights <- wp_grid_weights(target, fraction)
  values <- terra::as.matrix(fraction, wide = TRUE)
  if (any(is.infinite(values)) || any(values < 0 | values > 1, na.rm = TRUE)) {
    stop("Runoff fractions must be finite and between zero and one.")
  }
  valid <- !is.na(values)
  values[!valid] <- 0
  # This is the transpose of load transfer: each fine cell gets its
  # overlap-weighted factor, never a redistributed coarse emission total.
  coverage <- as.matrix(Matrix::t(weights$y) %*% (valid * 1) %*% weights$x)
  result <- as.matrix(Matrix::t(weights$y) %*% values %*% weights$x)
  result[coverage < 1 - 1e-9] <- NA
  terra::rast(target, vals = as.vector(t(result)))
}

wp_monthly_files <- function(directory, variable) {
  if (is.null(directory) || !dir.exists(directory)) {
    stop("Missing hydrology directory: ", variable)
  }
  files <- list.files(directory, pattern = "[.]tif$", full.names = TRUE)
  months <- suppressWarnings(as.integer(sub(".*m([0-9]{1,2})[.]tif$", "\\1", basename(files))))
  if (length(files) != 12L || anyNA(months) || !identical(sort(months), 1:12)) {
    stop(variable, ": expected exactly one raster for each month m01 through m12.")
  }
  files[order(months)]
}

wp_hydrology_grid <- function(settings) {
  hydro <- settings$input$hydrology
  monthly <- c("runoff", "discharge", "river_temperature", "river_depth",
               "river_restime", "ssrd")
  paths <- lapply(monthly, function(variable) {
    wp_monthly_files(hydro[[variable]], variable)
  })
  names(paths) <- monthly
  static <- c(hydro$doc, settings$input$routing$flowdir, settings$input$routing$flowacc)
  if (length(static) != 3L || !all(file.exists(static))) {
    stop("Hydrology coupling requires DOC, flowdir and flowacc rasters.")
  }
  reference <- terra::rast(paths$discharge[1L])
  if (!nzchar(terra::crs(reference))) stop("Hydrology grid has no CRS.")
  for (path in c(unlist(paths), static)) {
    raster <- terra::rast(path)
    if (terra::nlyr(raster) != 1L ||
        !terra::compareGeom(reference, raster, stopOnError = FALSE)) {
      stop("Hydrology inputs must share one native grid: ", path)
    }
  }
  reference
}

wp_fine_emissions <- function(annual_fraction) {
  run <- get("run", envir = asNamespace("glowpa"))
  humans <- glowpa:::human_emissions()
  glowpa:::pathways_humans(humans)
  glowpa:::pathways_humans_rast(humans)
  to_land <- terra::sds(run$emissions$pathways$rast$humans2land)
  names(to_land) <- "humans2land"
  if (run$settings$livestock$enabled) {
    livestock <- glowpa:::livestock_emissions()
    glowpa:::pathways_livestock(livestock)
    glowpa:::pathways_livestock_df(livestock)
    to_land <- c(to_land, terra::sds(livestock[c("livestock2land", "storage2land")]))
  }
  land_to_water <- lapply(to_land, function(pathway) {
    missing <- terra::global((sum(pathway, na.rm = TRUE) > 0) &
                              is.na(annual_fraction), "sum", na.rm = TRUE)[1, 1]
    if (missing > 0) stop("Monthly runoff has incomplete coverage of fine land emissions.")
    layers <- lapply(seq_len(terra::nlyr(pathway)), function(i) {
      result <- pathway[[i]] * annual_fraction
      terra::time(result, tstep = "years") <- 1
      result
    })
    names(layers) <- names(pathway)
    terra::sds(layers)
  })
  names(land_to_water) <- names(to_land)
  glowpa:::pathways_land(land_to_water)
  glowpa:::output_set_meta()
  glowpa:::output_write(run$emissions, run$settings$output)
}

wp_phase <- function(output_dir, phase) {
  writeLines(phase, file.path(output_dir, ".glowpa_phase"))
  message("WaterPath stage: ", phase)
}

wp_run_model <- function(config_path) {
  settings <- yaml::read_yaml(config_path)
  output_dir <- settings$output$dir
  dir.create(output_dir, recursive = TRUE, showWarnings = FALSE)
  wp_phase(output_dir, "running")
  # A failed/new run must not advertise population intermediates from an older run.
  complete_path <- file.path(output_dir, "hydrology", "coupling", "complete.json")
  if (file.exists(complete_path)) unlink(complete_path)
  if (!isTRUE(settings$hydrology$enabled)) {
    glowpa::glowpa_init(config_path)
    glowpa::glowpa_start()
    return(invisible(NULL))
  }

  hydrology_grid <- wp_hydrology_grid(settings)
  fine_grid <- terra::rast(settings$input$isoraster)
  if (terra::compareGeom(fine_grid, hydrology_grid, stopOnError = FALSE)) {
    glowpa::glowpa_init(config_path)
    glowpa::glowpa_start()
    return(invisible(NULL))
  }
  if (!terra::same.crs(fine_grid, hydrology_grid)) {
    stop("Mixed-grid coupling requires emissions and hydrology in the same CRS.")
  }

  emissions_settings <- settings
  emissions_settings$hydrology$enabled <- FALSE
  emissions_settings$output$hydrology <- NULL
  emissions_config <- tempfile(fileext = ".yaml")
  on.exit(unlink(emissions_config), add = TRUE)
  yaml::write_yaml(emissions_settings, emissions_config)
  glowpa::glowpa_init(emissions_config)
  run <- get("run", envir = asNamespace("glowpa"))
  run$timing <- list(start = Sys.time())
  # Read native runoff without input_read_rast(), which crops to the fine domain.
  runoff <- terra::rast(wp_monthly_files(settings$input$hydrology$runoff, "runoff"))
  fraction <- glowpa:::runoff_fraction(runoff, run$pathogen$retention_lower,
                                      run$pathogen$retention_upper)
  annual_fraction <- terra::app(fraction, "mean", na.rm = FALSE)
  wp_fine_emissions(wp_fraction_to_grid(annual_fraction, run$domain))

  wp_phase(output_dir, "coupling")
  surface <- terra::rast(file.path(output_dir, settings$output$sinks$surface_water$grid))
  land <- terra::rast(file.path(output_dir, settings$output$sinks$land$grid))
  if (!terra::compareGeom(surface, fine_grid, stopOnError = FALSE) ||
      !terra::compareGeom(land, fine_grid, stopOnError = FALSE)) {
    stop("Emission output geometry differs from the original emissions grid.")
  }
  direct <- sum(run$emissions$pathways$rast$humans2water,
                run$emissions$pathways$rast$wwtp2water, na.rm = TRUE)
  coarse_direct <- wp_sum_to_grid(direct, hydrology_grid, "direct_water")
  coarse_land <- wp_sum_to_grid(land, hydrology_grid, "land")
  fine_runoff_total <- terra::global(run$emissions$pathways$rast$land2water,
                                     "sum", na.rm = TRUE)[1, 1]
  coarse_runoff_total <- terra::global(coarse_land * annual_fraction,
                                       "sum", na.rm = TRUE)[1, 1]
  if (!is.finite(coarse_runoff_total) ||
      abs(fine_runoff_total - coarse_runoff_total) >
      max(1e-8, abs(fine_runoff_total) * 1e-9)) {
    stop("Fine emission outputs and coarse hydrological runoff totals disagree.")
  }
  coarse_rural <- wp_sum_to_grid(terra::rast(settings$input$population$rural),
                                hydrology_grid, "poprural")
  coarse_urban <- wp_sum_to_grid(terra::rast(settings$input$population$urban),
                                hydrology_grid, "popurban")
  coupling_dir <- file.path(output_dir, "hydrology", "coupling")
  dir.create(coupling_dir, recursive = TRUE, showWarnings = FALSE)
  intermediates <- list(direct_water = coarse_direct, land = coarse_land,
                        poprural = coarse_rural, popurban = coarse_urban)
  balance <- lapply(intermediates, function(r) as.list(attr(r, "conservation")))
  for (name in names(intermediates)) {
    terra::writeRaster(intermediates[[name]], file.path(coupling_dir, paste0(name, ".tif")),
                       overwrite = TRUE, datatype = "FLT8S")
  }

  wp_phase(output_dir, "hydrology_running")
  run$settings$hydrology <- settings$hydrology
  run$settings$output <- settings$output
  flowacc <- terra::rast(settings$input$routing$flowacc)
  flowdir <- terra::rast(settings$input$routing$flowdir)
  # Preserve the native routing network, including cells outside the fine domain.
  run$domain <- terra::ifel(!is.na(flowacc) & !is.na(flowdir), 1, NA)
  names(run$domain) <- "isoraster"
  supported_load <- terra::global(terra::mask(coarse_direct + coarse_land, run$domain),
                                 "sum", na.rm = TRUE)[1, 1]
  total_load <- sum(unlist(balance$direct_water["target_total"]),
                    unlist(balance$land["target_total"]))
  if (!is.finite(supported_load) ||
      abs(supported_load - total_load) > max(1e-8, total_load * 1e-9)) {
    stop("Routing network has NoData cells containing aggregated emissions.")
  }
  glowpa:::validate_hydrology_input(settings$input$hydrology)
  glowpa:::validate_routing_input(settings$input$routing)
  missing_runoff <- terra::global((coarse_land > 0) & is.na(fraction), "sum", na.rm = TRUE)
  if (any(missing_runoff[, 1] > 0)) {
    stop("Monthly runoff has NoData in cells containing land emissions.")
  }
  inflow <- sum(coarse_direct / 12, coarse_land / 12 * fraction, na.rm = TRUE)
  terra::time(inflow, tstep = "months") <- 1:12
  survival <- glowpa:::river_survival()
  loads <- glowpa:::routing(inflow, survival, flowdir, flowacc)
  terra::time(loads, tstep = "months") <- 1:12
  terra::units(loads) <- "particles"
  names(loads) <- month.abb
  glowpa:::output_hydrology(list(loads = loads), settings$output$hydrology)
  jsonlite::write_json(list(conservation = balance, grid = list(
    nrow = terra::nrow(hydrology_grid), ncol = terra::ncol(hydrology_grid),
    resolution = terra::res(hydrology_grid)), runoff = list(
      fine_total = fine_runoff_total, coarse_total = coarse_runoff_total)),
    complete_path, auto_unbox = TRUE, pretty = TRUE, digits = 17)
  run$timing$end <- Sys.time()
  message("Finished WaterPath coupled simulation")
}
