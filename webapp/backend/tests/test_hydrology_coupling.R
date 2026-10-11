source(file.path("..", "hydrology_coupling.R"))

expect_error <- function(expr, pattern) {
  error <- tryCatch({ force(expr); NULL }, error = identity)
  stopifnot(inherits(error, "error"), grepl(pattern, conditionMessage(error)))
}

fine <- terra::rast(nrows = 4, ncols = 4, xmin = 0, xmax = 4,
                    ymin = 0, ymax = 4, crs = "EPSG:3857", vals = 1:16)
coarse <- terra::rast(nrows = 2, ncols = 2, xmin = 0, xmax = 4,
                      ymin = 0, ymax = 4, crs = "EPSG:3857")
result <- wp_sum_to_grid(fine, coarse, "aligned")
stopifnot(identical(as.numeric(terra::values(result)), c(14, 22, 46, 54)),
          terra::compareGeom(result, coarse),
          sum(terra::values(result)) == sum(terra::values(fine)))

shifted <- terra::rast(nrows = 3, ncols = 5, xmin = 0.2, xmax = 5.2,
                       ymin = 0.1, ymax = 3.1, crs = "EPSG:4326", vals = 1:15)
target <- terra::rast(nrows = 2, ncols = 3, xmin = 0, xmax = 6,
                      ymin = 0, ymax = 4, crs = "EPSG:4326")
transferred <- wp_sum_to_grid(shifted, target, "shifted")
stopifnot(abs(sum(terra::values(transferred)) - 120) < 1e-9)

# A source cell straddling a boundary shares its count, rather than duplicating it.
straddling <- terra::rast(nrows = 1, ncols = 1, xmin = 0.5, xmax = 1.5,
                          ymin = 0, ymax = 1, crs = "EPSG:3857", vals = 100)
split_grid <- terra::rast(nrows = 1, ncols = 2, xmin = 0, xmax = 2,
                          ymin = 0, ymax = 1, crs = "EPSG:3857")
stopifnot(identical(as.numeric(terra::values(wp_sum_to_grid(straddling, split_grid, "split"))),
                    c(50, 50)))

factors <- terra::rast(split_grid, vals = c(0.01, 0.03))
fine_factor <- wp_fraction_to_grid(factors, straddling)
stopifnot(abs(terra::values(fine_factor)[1] - 0.02) < 1e-12,
          abs(sum(terra::values(straddling * fine_factor)) -
                sum(terra::values(wp_sum_to_grid(straddling, split_grid, "split") *
                                   factors))) < 1e-12)
geo_factors <- terra::rast(target, vals = seq(0.01, 0.06, by = 0.01))
stopifnot(abs(sum(terra::values(shifted * wp_fraction_to_grid(geo_factors, shifted))) -
                sum(terra::values(transferred * geo_factors))) < 1e-10)
terra::values(factors) <- c(NA, 0.03)
stopifnot(is.na(terra::values(wp_fraction_to_grid(factors, straddling))[1]))
terra::values(factors) <- c(0.01, 1.1)
expect_error(wp_fraction_to_grid(factors, straddling), "between zero and one")
terra::values(factors) <- c(0.01, Inf)
expect_error(wp_fraction_to_grid(factors, straddling), "finite")
stopifnot(is.na(terra::values(wp_fraction_to_grid(
  terra::crop(terra::rast(split_grid, vals = 0.01), terra::ext(0, 1, 0, 1)),
  straddling))[1]))

terra::values(fine) <- c(NA, rep(0, 15))
stopifnot(all(terra::values(wp_sum_to_grid(fine, coarse, "nodata")) == 0))
terra::values(fine) <- -1
expect_error(wp_sum_to_grid(fine, coarse, "negative"), "non-negative")
terra::values(fine) <- Inf
expect_error(wp_sum_to_grid(fine, coarse, "infinite"), "finite")
terra::values(fine) <- 1
cropped <- terra::crop(coarse, terra::ext(0, 2, 0, 4))
expect_error(wp_sum_to_grid(fine, cropped, "coverage"), "conservation failed")
expect_error(wp_sum_to_grid(shifted, coarse, "crs"), "shared CRS")

# Empty padding cells that only touch the hydrology's west/south edge are skipped.
padded <- terra::rast(nrows = 5, ncols = 5, xmin = -1, xmax = 4,
                      ymin = -1, ymax = 4, crs = "EPSG:3857", vals = 0)
padded[1:4, 2:5] <- 1:16
padded_result <- wp_sum_to_grid(padded, coarse, "padded")
stopifnot(identical(as.numeric(terra::values(padded_result)), c(14, 22, 46, 54)))

# Large row counts exercise the block-wise accumulator.
tall <- terra::rast(nrows = 600, ncols = 2, xmin = 0, xmax = 4,
                    ymin = 0, ymax = 4, crs = "EPSG:3857", vals = 1)
stopifnot(abs(sum(terra::values(wp_sum_to_grid(tall, coarse, "blocks"))) - 1200) < 1e-9)

# Monthly inflows outside the routing mask move to the nearest valid cell
# without changing any layer total.
routing_grid <- terra::rast(nrows = 3, ncols = 3, xmin = 0, xmax = 3,
                            ymin = 0, ymax = 3, crs = "EPSG:3857")
routing_domain <- terra::rast(routing_grid, vals = c(NA, 1, NA, NA, 1, NA, NA, 1, NA))
routing_loads <- c(terra::rast(routing_grid, vals = c(4, 1, rep(0, 7))),
                   terra::rast(routing_grid, vals = c(rep(0, 8), 7)))
relocated <- wp_relocate_to_domain(routing_loads, routing_domain)
relocated_values <- terra::values(relocated$loads, mat = TRUE)
stopifnot(relocated$cells == 2L,
          identical(as.numeric(colSums(relocated_values)), c(5, 7)),
          all(relocated_values[c(1, 9), ] == 0),
          relocated_values[2, 1] == 5,
          relocated_values[8, 2] == 7,
          identical(as.numeric(relocated$layer_totals), c(4, 7)),
          relocated$maximum_distance == 1)
unchanged <- wp_relocate_to_domain(relocated$loads, routing_domain)
stopifnot(unchanged$cells == 0L,
          identical(as.numeric(terra::values(unchanged$loads)),
                    as.numeric(relocated_values)))
expect_error(wp_relocate_to_domain(routing_loads, terra::rast(fine)),
             "same grid")

local({
  root <- tempfile("hydrology-grid-test-")
  dir.create(root)
  on.exit(unlink(root, recursive = TRUE))
  hydro <- list()
  for (variable in c("runoff", "discharge", "river_temperature", "river_depth",
                     "river_restime", "ssrd")) {
    directory <- file.path(root, variable)
    dir.create(directory)
    hydro[[variable]] <- directory
    for (month in 1:12) {
      terra::writeRaster(terra::rast(coarse, vals = 1),
                         file.path(directory, sprintf("%s_m%02d.tif", variable, month)))
    }
  }
  for (variable in c("doc", "flowdir", "flowacc")) {
    terra::writeRaster(terra::rast(coarse, vals = 1), file.path(root, paste0(variable, ".tif")))
  }
  hydro$doc <- file.path(root, "doc.tif")
  settings <- list(input = list(hydrology = hydro, routing = list(
    flowdir = file.path(root, "flowdir.tif"), flowacc = file.path(root, "flowacc.tif"))))
  before <- tools::md5sum(list.files(root, recursive = TRUE, full.names = TRUE))
  stopifnot(terra::compareGeom(wp_hydrology_grid(settings), coarse))
  stopifnot(identical(before, tools::md5sum(names(before))))
  terra::writeRaster(fine, file.path(hydro$runoff, "runoff_m01.tif"), overwrite = TRUE)
  expect_error(wp_hydrology_grid(settings), "share one native grid")
  unlink(file.path(hydro$runoff, "runoff_m01.tif"))
  expect_error(wp_hydrology_grid(settings), "exactly one raster for each month")
})

local({
  grid <- terra::rast(nrows = 1, ncols = 5, xmin = 0, xmax = 5,
                      ymin = 0, ymax = 1, crs = "EPSG:3857")
  monthly <- do.call(c, lapply(1:12, function(month) {
    terra::rast(grid, vals = c(month, NA, month + 100, NA, 0))
  }))
  # One loaded cell has only one missing month: copy a whole donor series.
  values <- terra::values(monthly, mat = TRUE)
  values[2, 2:12] <- 999
  monthly <- terra::setValues(monthly, values)
  land <- terra::rast(grid, vals = c(1, 10, 1, 0, 1))
  original <- terra::values(monthly, mat = TRUE)
  filled <- wp_fill_runoff(monthly, land)
  result <- terra::values(filled$runoff, mat = TRUE)
  stopifnot(filled$cells == 1L, filled$maximum_distance == 1,
            filled$report$cell == 2L, filled$report$missing_months == 1L,
            filled$report$source_cell %in% c(1L, 3L),
            identical(result[2, ], original[filled$report$source_cell, ]),
            identical(result[-2, ], original[-2, ]),
            identical(terra::values(monthly, mat = TRUE), original))
  unchanged <- wp_fill_runoff(filled$runoff, land)
  stopifnot(unchanged$cells == 0L, nrow(unchanged$report) == 0L,
            identical(terra::values(unchanged$runoff, mat = TRUE), result))

  # Zero runoff is valid; a partial series is never a donor.
  values[1, 1] <- NA
  values[3, 1] <- NA
  monthly <- terra::setValues(monthly, values)
  filled <- wp_fill_runoff(monthly, terra::rast(grid, vals = c(0, 1, 0, 1, 0)))
  stopifnot(all(filled$report$source_cell == 5L),
            all(terra::values(filled$runoff, mat = TRUE)[4, ] == 0))
  expect_error(wp_fill_runoff(monthly[[1]], land), "12 months")
  expect_error(wp_fill_runoff(monthly, fine), "hydrology grid")
  empty <- terra::setValues(monthly, NA)
  expect_error(wp_fill_runoff(empty, land), "complete valid 12-month series")
  stopifnot(wp_fill_runoff(empty, terra::rast(grid, vals = 0))$cells == 0L)
  values[3, 1] <- -1
  monthly <- terra::setValues(monthly, values)
  expect_error(wp_fill_runoff(monthly, land), "finite and non-negative")
  values[3, 1] <- Inf
  monthly <- terra::setValues(monthly, values)
  expect_error(wp_fill_runoff(monthly, land), "finite and non-negative")
})

# Filling all coarse cells receiving fine loads keeps annual and monthly
# conversions consistent, including a fine cell crossing a NoData boundary.
local({
  monthly <- do.call(c, lapply(1:12, function(month) {
    terra::rast(split_grid, vals = c(month / 100, NA))
  }))
  land <- wp_sum_to_grid(straddling, split_grid, "land")
  filled <- wp_fill_runoff(monthly, land)
  annual <- terra::app(filled$runoff, "mean", na.rm = FALSE)
  fine_total <- terra::global(
    straddling * wp_fraction_to_grid(annual, straddling), "sum")[1, 1]
  monthly_total <- sum(terra::global(land / 12 * filled$runoff, "sum")[, 1])
  stopifnot(filled$cells == 1L, abs(fine_total - monthly_total) < 1e-12)
})

cat("Conservative coupling tests passed.\n")
