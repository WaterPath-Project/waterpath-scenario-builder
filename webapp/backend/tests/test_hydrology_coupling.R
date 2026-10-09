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

cat("Conservative coupling tests passed.\n")
