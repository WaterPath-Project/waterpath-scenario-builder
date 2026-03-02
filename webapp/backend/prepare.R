#' Prepare data
#'
#' @param datasources path to pre-defined data sources
#' @param out_dir target directory to store model input or NA for using tempory
#'   directory.
#' @param res spatial resolution in degrees
#' @param country ISO-3 alpha code for country or NA for global dataset
#' @param level GADM level; 0 (country), 1 (states/provinces),
#' 2 (municipalities)
#'
#' @return directory containing the input files. Equal to `out_dir` if
#'   specified. Else returning path to temporary directory
#' @export
prepare_data <- function(datasources,
                         out_dir = NA,
                         res = .5,
                         country = NA,
                         level = 0,
                         modules = list(
                           human = TRUE,
                           wwtp = TRUE,
                           livestock = TRUE,
                           hydrology = TRUE
                         )) {
  if (is.na(out_dir)) {
    out_root <- tempdir()
    out_dir <- file.path(out_root, "glowpa_data")
    dir.create(out_dir, showWarnings = FALSE)
  }
  if (!dir.exists(out_dir)) {
    stop("output directory does not exist")
  }
  options(glowpa.datasources = datasources)
  tmp_dir <- tempdir()

  if (!all(is.na(country))) {
    vect_country <-
      geodata::gadm(
        country = country,
        level = 0,
        path = tmp_dir,
        version = "4.1"
      )
  } else {
    vect_country <- geodata::world(level = 0, path = tmp_dir, resolution = 1)
  }

  vect_country <- prepare_country_groupings(vect_country)


  vect_domain <- prepare_domain(level, country, tmp_dir)
  # small countries might disappear by converting from vector to raster to low
  # resolution
  rast_domain <-
    prepare_isoraster(
      vect_domain,
      res = res,
      level = level,
      country = country,
      path = tmp_dir
    )

  df_domain <- terra::unique(rast_domain)
  # update the vect country
  vect_country <- vect_country[vect_country$GID_0 %in% df_domain$iso_country]
  # save for plotting purposes
  dir.create(file.path(out_dir, "gadm"), showWarnings = FALSE)
  terra::writeVector(vect_domain,
    file.path(out_dir, "gadm", "gadm.shp"),
    overwrite = TRUE
  )
  dir.create(file.path(out_dir, "countries"), showWarnings = FALSE)
  terra::writeVector(vect_country,
    file.path(out_dir, "countries", "countries.shp"),
    overwrite = TRUE
  )
  rast_pop <- prepare_pop_gridded(rast_domain, vect_domain)
  df_pop_country <- prepare_pop_country()

  # join and remove missing data rows
  df_isodata <- df_domain %>%
    dplyr::left_join(df_pop_country, by = "iso_country") %>%
    na.omit()
  # switch to gridded population data in isodata file
  if (level > 0) {
    # compute zonal statistics
    df_zonal_pop <-
      terra::zonal(rast_pop, rast_domain$isoraster, "sum", na.rm = TRUE)
    df_isodata <-
      df_isodata %>% dplyr::left_join(df_zonal_pop, by = "isoraster")
    # normalize the zonal population by country totals
    population <- population_country <- pop_country_grid <- NULL
    df_country_grid_pop <- df_isodata %>%
      dplyr::group_by("iso_country") %>%
      dplyr::summarise(pop_country_grid = sum(population, na.rm = TRUE))
    df_isodata <-
      df_isodata %>% dplyr::left_join(df_country_grid_pop, by = "iso_country")
    df_isodata <- df_isodata %>%
      dplyr::mutate(
        population = population * (population_country / pop_country_grid)
      ) %>%
      dplyr::select(!pop_country_grid)
  } else {
    df_isodata$population <- df_isodata$population_country
  }

  rast_furban <-
    terra::subst(
      rast_domain$isoraster,
      df_isodata$isoraster,
      df_isodata$fraction_urban_pop,
      others = NA
    )
  rast_pop_urban <- rast_furban * rast_pop
  rast_pop_rural <- (1 - rast_furban) * rast_pop

  dir.create(file.path(out_dir, "human"), showWarnings = FALSE)
  out_path <- file.path(out_dir, "human", "pop_urban.tif")
  terra::writeRaster(rast_pop_urban, out_path, overwrite = TRUE)
  out_path <- file.path(out_dir, "human", "pop_rural.tif")
  terra::writeRaster(rast_pop_rural, out_path, overwrite = TRUE)

  df_hdi <- prepare_hdi() %>% dplyr::rename(name_country = country)
  # check for missing hdi values
  df_isodata <- df_isodata %>% dplyr::left_join(df_hdi, by = "name_country")
  hdi <- NULL
  if (sum(is.na(df_isodata$hdi)) > 0) {
    df_isna_hdi <- df_isodata %>% dplyr::filter(is.na(hdi))
    # get 9 nearby countries
    df_nearby_countries <- terra::nearby(vect_country, k = 9)
    df_country <- as.data.frame(vect_country)
    for (i in seq_len(nrow(df_isna_hdi))) {
      row <- df_isna_hdi[i, ]
      j <- which(df_country$GID_0 == row$iso_country)
      nearby_iso_countries <- df_nearby_countries[j, 2:10]
      isoraster <- NULL
      df_pop_nearby_hdi <- df_isodata %>%
        dplyr::filter(isoraster %in% nearby_iso_countries) %>%
        # order from k1 to k9 to have most nearest country on top
        dplyr::arrange(factor(isoraster, levels = nearby_iso_countries)) %>%
        # clean all na values and select first occurrence
        na.omit() %>%
        dplyr::first() %>%
        dplyr::select(hdi) %>%
        dplyr::pull()
      df_isna_hdi$hdi[i] <- df_pop_nearby_hdi
    }
    # update the hdi rows in df_pop_country
    df_isodata <-
      df_isodata %>% dplyr::rows_update(df_isna_hdi, by = "isoraster")
  }

  hdi_boundary <- 0.8
  name <- NULL

  # set incidence for rotavirus
  df_isodata <- df_isodata %>% dplyr::mutate(
    incidence_urban_under5_virus = dplyr::case_when(
      hdi < hdi_boundary ~ 0.24,
      hdi >= hdi_boundary ~ 0.08
    ),
    incidence_urban_5plus_virus = dplyr::case_when(
      hdi < hdi_boundary ~ 0.01,
      hdi >= hdi_boundary ~ 0.01
    ),
    incidence_rural_under5_virus = dplyr::case_when(
      hdi < hdi_boundary ~ 0.24,
      hdi >= hdi_boundary ~ 0.08
    ),
    incidence_rural_5plus_virus = dplyr::case_when(
      hdi < hdi_boundary ~ 0.01,
      hdi >= hdi_boundary ~ 0.01
    )
  )

  # set incidence crypto
  df_isodata <- df_isodata %>% dplyr::mutate(
    incidence_urban_under5_protozoa = dplyr::case_when(
      hdi < hdi_boundary ~ 0.1,
      hdi >= hdi_boundary ~ 0.05
    ),
    incidence_urban_5plus_protozoa = dplyr::case_when(
      hdi < hdi_boundary ~ 0.1,
      hdi >= hdi_boundary ~ 0.05
    ),
    incidence_rural_under5_protozoa = dplyr::case_when(
      hdi < hdi_boundary ~ 0.1,
      hdi >= hdi_boundary ~ 0.05
    ),
    incidence_rural_5plus_protozoa = dplyr::case_when(
      hdi < hdi_boundary ~ 0.1,
      hdi >= hdi_boundary ~ 0.05
    )
  )

  df_isodata <- df_isodata %>% dplyr::rename(iso = "isoraster")
  #df_isodata <- prepare_sanitation(df_isodata)
  if(modules$human){
    df_isodata <- prepare_sanitation_2025(df_isodata)
  }
  if(!modules$wwtp){
    # add country level wwtp treatment
    df_isodata <- prepare_treatment(df_isodata)
  }

  terra::writeRaster(rast_domain$isoraster,
    file.path(out_dir, "isoraster.tif"),
    overwrite = TRUE
  )
  # add shedding rate and duration
  pathogen_type <- shedding_rate <- shedding_duration <- NULL
  df_isodata$sheddingRate_virus <- 1e10
  df_isodata$sheddingRate_protozoa <- 1e9
  df_isodata$shedding_duration_virus <- 7
  df_isodata$shedding_duration_protozoa <- 7
  saveRDS(df_isodata, file.path(out_dir, "isodata.RDS"))

  # WASTE WATER
  if(modules$wwtp){
    df_wwtp <- prepare_hydrowaste(vect_domain)
    saveRDS(df_wwtp, file.path(out_dir, "wwtp.RDS"))
  }

  # LIVESTOCK DATA
  if(modules$livestock){
    animal_dir <- file.path(out_dir, "animals")
    dir.create(animal_dir, showWarnings = FALSE)

    rast_animal_heads <- prepare_animals_gridded_glw4(rast_domain, vect_country)
    animal_names <- names(rast_animal_heads)
    # write rasters
    for (animal in animal_names) {
      fpath <- file.path(animal_dir, paste0(animal, ".tif"))
      terra::writeRaster(rast_animal_heads[[animal]], fpath, overwrite = TRUE)
    }

    df_animal_isodata <- prepare_livestock_isodata()
    # animal isodata is aggregated by ipcc region. rasterize this field
    rast_ippc_regions <-
      terra::rasterize(vect_country, rast_domain, field = "ipcc_region")
    ipcc_levels <- terra::levels(rast_ippc_regions)[[1]]
    ipcc_levels$ID <- ipcc_levels$ID + 1
    rast_animal_isoraster <-
      terra::subst(
        rast_ippc_regions,
        from = ipcc_levels$ipcc_region,
        to = ipcc_levels$ID,
        others = NA
      )

    terra::writeRaster(
      as.numeric(rast_animal_isoraster),
      file.path(out_dir, "animal_isoraster.tif"),
      overwrite = TRUE
    )

    df_animal_isodata_by_animal <- df_animal_isodata %>%
      dplyr::left_join(ipcc_levels, by = "ipcc_region") %>%
      dplyr::rename(iso = "ID") %>%
      dplyr::group_by(animal)

    df_animal_isodata_by_animal %>%
      dplyr::group_walk(~ saveRDS(.x, file = file.path(
        animal_dir, paste0("isodata_", .y, ".RDS")
      )))


    # LIVESTOCK SYSTEMS
    dir.create(file.path(out_dir, "livestock"), showWarnings = FALSE)

    list_farming <- prepare_livestock_vermeulen(rast_domain)
    df_production_systems <- list_farming$production_systems
    iso <- iso_code <- NULL
    df_production_systems <-
      df_production_systems %>%
      dplyr::left_join(
        df_domain %>%
          dplyr::select(isoraster, iso_code),
        by = dplyr::join_by(iso == isoraster)
      )

    out_path <- file.path(out_dir, "livestock", "production_systems.RDS")
    saveRDS(df_production_systems, out_path)

    df_manure_fractions <- list_farming$manure_fractions
    df_manure_fractions <- df_manure_fractions %>%
      dplyr::left_join(
        df_domain %>%
          dplyr::select(isoraster, iso_code),
        by = dplyr::join_by(iso == isoraster)
      )

    out_path <- file.path(out_dir, "livestock", "manure_fractions.RDS")
    saveRDS(df_manure_fractions, out_path)

    # MANURE
    dir.create(file.path(out_dir, "manure"), showWarnings = FALSE)

    df_manure_storage <- list_farming$manure_storage
    df_manure_storage <-
      df_manure_storage %>%
      dplyr::left_join(
        df_domain %>%
          dplyr::select(isoraster, iso_code),
        by = dplyr::join_by(iso == isoraster)
      )

    out_path <- file.path(out_dir, "manure", "manure_management.RDS")
    saveRDS(df_manure_storage, out_path)

    # AIR TEMP
    dir.create(file.path(out_dir, "temperature"), showWarnings = FALSE)
    readme <- file.path(out_dir, "temperature", "README.txt")
    if (res < .5) {
      # use higher resolution worldclim data
      rast_airtemp <- prepare_worldclim(rast_domain)
      writeLines("Source: WorldClim v2.1", readme)
    } else {
      rast_airtemp <- prepare_vic_watch(rast_domain)
      writeLines("Source: VIC_WATCH", readme)
    }
    out_path <- file.path(out_dir, "temperature", "tair_1970_2000.tif")
    terra::writeRaster(rast_airtemp, out_path, overwrite = TRUE)
  }


  return(out_dir)
}

prepare_domain <- function(level = 0, country = NA, path = tempdir()) {
  if (!all(is.na(country))) {
    vect_domain <-
      geodata::gadm(
        country = country,
        level = level,
        path = path,
        version = "4.1"
      )
    vect_domain$NAME_0 <- vect_domain$COUNTRY
  } else if (level == 0) {
    vect_domain <- geodata::world(level = level, path = path, resolution = 1)
  } else {
    stop("For level 1 and higher you must specify an ISO3 country or vector of ISO3 countries")
  }
  vect_domain$isoraster <- seq(1, nrow(vect_domain))
  return(vect_domain)
}

prepare_isoraster <- function(
    vect_domain, res = .5, level = 0, country = NA, path = tempdir()) {
  rast_domain <- terra::rast(resolution = res)
  padding <- 0
  if (!all(is.na(country))) {
    padding <- 1
  }

  field <- paste0("GID_", level)
  rast_code <-
    terra::rasterize(vect_domain,
      rast_domain,
      field = field,
      touches = TRUE
    )
  names(rast_code) <- c("iso_code")

  rast_country <-
    terra::rasterize(vect_domain,
      rast_domain,
      field = "GID_0",
      touches = TRUE
    )
  names(rast_country) <- c("iso_country")

  rast_country_name <-
    terra::rasterize(vect_domain,
      rast_domain,
      field = "NAME_0",
      touches = TRUE
    )
  names(rast_country_name) <- c("name_country")

  rast_iso <-
    terra::rasterize(vect_domain,
      rast_domain,
      field = "isoraster",
      touches = TRUE
    )
  names(rast_iso) <- c("isoraster")

  rast_name <-
    terra::rasterize(vect_domain,
      rast_domain,
      field = paste0("NAME_", level),
      touches = TRUE
    )
  names(rast_name) <- c("name")

  r <- c(rast_iso, rast_code, rast_name, rast_country, rast_country_name)
  r <- terra::trim(r, padding = padding)
  if (is.na(country)) {
    r <- terra::extend(r, terra::ext(-180, 180, -90, 90))
  }
  return(r)
}

prepare_pop_gridded <- function(
    rast_domain,
    vect_domain,
    source = "worldpop_2018",
    year = 2020,
    path = tempdir()) {
  # determine resolution for download. We assume the domain to be a regular
  # latlon grid
  if (source == "gpw") {
    # get resolution in degrees
    res_domain <- terra::res(rast_domain)[1]
    res_minutes <- 60 * res_domain
    download_res <- 10
    if (res_minutes < 2.5) {
      download_res <- .5
    } else if (res_minutes < 5) {
      download_res <- 2.5
    } else if (res_minutes < 10) {
      download_res <- 5
    }
    # download hi-res population (population per grid cell)
    rast_pop <-
      geodata::population(year = year, path = path, res = download_res)
    if (all(terra::res(rast_pop) < terra::res(rast_domain))) {
      # aggregate
      rast_pop_domain <- terra::resample(rast_pop, rast_domain, method = "sum")
    } else if (all(terra::res(rast_pop) > terra::res(rast_domain))) {
      # disagg
      # calculate population density
      rast_pop_density <- rast_pop / terra::cellSize(rast_pop)
      rast_pop_domain <-
        terra::resample(rast_pop_density, rast_domain, method = "near") *
          terra::cellSize(rast_domain$isoraster)
    } else {
      rast_pop_domain <- rast_pop
    }
  } else if (source == "worldpop_2018") {
    fpath <-
      file.path(
        getOption("glowpa.datasources"),
        "worldpop_2018/ppp_2018_1km_Aggregated.tif"
      )
    rast_worldpop <- terra::rast(fpath)
    if (!terra::compareGeom(rast_domain,
      rast_worldpop,
      ext = TRUE,
      stopOnError = FALSE
    )) {
      rast_worldpop <- terra::crop(rast_worldpop, rast_domain)
    }
    if (all(terra::res(rast_domain) >= terra::res(rast_worldpop))) {
      # resample the population density per km
      rast_cellsize <- terra::cellSize(rast_worldpop, unit = "km")
      rast_worldpop_dens <- rast_worldpop / rast_cellsize
      rast_pop_dens_domain <-
        terra::mask(
          terra::resample(rast_worldpop_dens, rast_domain, method = "bilinear"),
          rast_domain$isoraster
        )
      rast_pop_domain <-
        rast_pop_dens_domain * terra::cellSize(rast_domain, unit = "km")
    } else {
      stop("resolution of domain must be 1km or bigger")
    }
  }
  names(rast_pop_domain) <- c("population")
  return(rast_pop_domain)
}

prepare_pop_country <- function() {
  `Alpha-code` <- NULL
  fpath <-
    file.path(
      getOption("glowpa.datasources"),
      "wup_2018/WUP2018-F00-Locations.xlsx"
    )
  wup_locations <- readxl::read_xlsx(fpath, sheet = "Location", skip = 16)
  # filter only country level information
  wup_countries <- wup_locations %>%
    dplyr::filter(!is.na(`Alpha-code`)) %>%
    dplyr::rename(iso_country = "Alpha-code") %>%
    dplyr::select(c("iso_country", "code"))
  fpath <-
    file.path(
      getOption("glowpa.datasources"),
      "wup_2018/WUP2018-F01-Total_Urban_Rural.xls"
    )
  wup_data <-
    readxl::read_xls(fpath, sheet = "Data", skip = 16) %>%
    dplyr::rename(code = "Country
code")
  percentage_urban <-
    Total <-
    `ISO3 Alpha-code` <-
    iso_country <- population_country <- fraction_urban_pop <- NULL
  wup_data_countries <- wup_countries %>%
    dplyr::left_join(wup_data, by = "code") %>%
    dplyr::rename(percentage_urban = "Percentage urban") %>%
    dplyr::mutate(
      # convert percentage to fraction
      fraction_urban_pop = percentage_urban / 100,
      # convert population presented in thousands to actual population.
      population_country = Total * 1e3
    ) %>%
    dplyr::select(iso_country, population_country, fraction_urban_pop)

  fpath <-
    file.path(
      getOption("glowpa.datasources"),
      "wpp_2019/WPP2019_F01_LOCATIONS.XLSX"
    )
  wpp_locations <- readxl::read_xlsx(fpath, sheet = "Location", skip = 16)
  wpp_countries <- wpp_locations %>%
    dplyr::filter(!is.na(`ISO3 Alpha-code`)) %>%
    dplyr::rename(iso_country = "ISO3 Alpha-code", code = "Location code") %>%
    dplyr::select(c("iso_country", "code"))

  fpath <-
    file.path(
      getOption("glowpa.datasources"),
      "wpp_2019/WPP2019_POP_F07_1_POPULATION_BY_AGE_BOTH_SEXES.xlsx"
    )
  wpp_data <- readxl::read_xlsx(fpath, sheet = "ESTIMATES", skip = 16) %>%
    dplyr::rename(code = "Country code")

  `Reference date (as of 1 July)` <- `0-4` <- total <- NULL
  wpp_data_countries <- wpp_countries %>%
    dplyr::left_join(wpp_data, by = dplyr::join_by("code")) %>%
    dplyr::select(
      "code",
      "iso_country",
      "Reference date (as of 1 July)",
      dplyr::matches("[[:digit:]]-[[:digit:]]")
    ) %>%
    dplyr::filter(`Reference date (as of 1 July)` == 2020) %>%
    dplyr::mutate_at(dplyr::vars(dplyr::matches("[[:digit:]]-[[:digit:]]")), as.double) %>%
    dplyr::mutate(
      total = rowSums(dplyr::across(
        dplyr::matches("[[:digit:]]-[[:digit:]]")
      )),
      fraction_pop_under5 = `0-4` / total
    ) %>%
    dplyr::select("code", "iso_country", "fraction_pop_under5")

  # why full join? we will end up with missing data
  pop_data_countries <-
    dplyr::full_join(
      wup_data_countries, wpp_data_countries,
      by = "iso_country"
    ) %>%
    dplyr::select(
      "iso_country",
      "population_country",
      "fraction_urban_pop",
      "fraction_pop_under5"
    )

  return(pop_data_countries)
}

prepare_hdi <- function() {
  fpath <-
    file.path(
      getOption("glowpa.datasources"),
      "undp_hdr/HDR23-24_Statistical_Annex_HDI_Table.xlsx"
    )
  df_hdi <-
    readxl::read_xlsx(fpath,
      range = "B9:C204",
      col_names = c("country", "hdi")
    )
  country <- NULL
  # rename some country names
  df_hdi <- df_hdi %>% dplyr::mutate(country = dplyr::case_when(
    country == "Hong Kong, China (SAR)" ~ "Hong Kong",
    country == "Korea (Republic of)" ~ "South Korea",
    country == "Iran (Islamic Republic of)" ~ "Iran",
    country == "Moldova (Republic of)" ~ "Moldova",
    country == "Venezuela (Bolivarian Republic of)" ~ "Venezuela",
    country == "Bolivia (Plurinational State of)" ~ "Bolivia",
    country == "Micronesia (Federated States of)" ~ "Micronesia",
    country == "Lao People's Democratic Republic" ~ "Laos",
    country == "Eswatini (Kingdom of)" ~ "Eswatini",
    country == "Syrian Arab Republic" ~ "Syria",
    country ==
      "Congo (Democratic Republic of the)" ~ "Democratic Republic of the Congo",
    country == "Türkiye" ~ "Turkey",
    country == "Czechia" ~ "Czech Republic",
    country == "Russian Federation" ~ "Russia",
    country == "North Macedonia" ~ "Macedonia",
    country == "Sao Tome and Principe" ~ "São Tomé and Príncipe",
    country == "Brunei Darussalam" ~ "Brunei",
    country == "Timor-Leste" ~ "East Timor",
    country == "Viet Nam" ~ "Vietnam",
    country == "Palestine, State of" ~ "Palestine",
    country == "Tanzania (United Republic of)" ~ "Tanzania",
    .default = country
  ))

  return(df_hdi)
}

prepare_sanitation <- function(df_isodata) {
  sel_cols <-
    c(
      "region",
      "iso3",
      "flushSewer",
      "flushSeptic",
      "flushPit",
      "flushOpen",
      "flushUnknown",
      "pitSlab",
      "pitNoSlab",
      "compostingToilet",
      "bucketLatrine",
      "containerBased",
      "hangingToilet",
      "openDefecation",
      "other",
      "onsiteDumpedLand",
      "coverBury",
      "sewageTreated",
      "fecalSludgeTreated",
      "isWatertight",
      "hasLeach",
      "emptyFrequency",
      "pitAdditive",
      "twinPits",
      "urine"
    )

  fpath <-
    file.path(
      getOption("glowpa.datasources"),
      "vanPuijenbroek_2019/input_file_world_country_20200729.csv"
    )
  df_human <- read.csv(fpath, sep = ";")
  df_human_sanitation <- df_human %>%
    dplyr::select(dplyr::starts_with(sel_cols)) %>%
    dplyr::rename(iso_country = "iso3")

  iso_country <- NULL

  df_rural_country <-
    df_human_sanitation %>% dplyr::select(iso_country, dplyr::ends_with("rur"))
  df_urban_country <-
    df_human_sanitation %>% dplyr::select(iso_country, dplyr::ends_with("urb"))

  df_isodata <- df_isodata %>%
    dplyr::inner_join(df_rural_country, by = "iso_country") %>%
    dplyr::inner_join(df_urban_country, by = "iso_country")

  df_isodata <- validate_sanitation(df_isodata)
  return(df_isodata)
}

prepare_sanitation_2025 <- function(df_isodata){
  fpath <-
    file.path(
      getOption("glowpa.datasources"),
      "jmp_waterpath_2025/glowpa_jmp_frac_level0_global.csv"
    )
  df_jmp_frac <- read.csv(fpath, sep = ",")

  df_isodata <- df_isodata %>%
    dplyr::inner_join(df_jmp_frac, dplyr::join_by(iso_country == iso3))
  return(df_isodata)
}

prepare_treatment <- function(df_isodata) {
  subarea <- NULL
  # read treatment data
  fpath <-
    file.path(
      getOption("glowpa.datasources"),
      "vanPuijenbroek_2019/treatment_puijenbroek_2019.csv"
    )
  # Netherlands Antilles should be used for Mauriritus etc
  # Yugoslavia should be used for Serbia, Kosovo
  # Sudan should be used for South Sudan
  # For Palestine use Egypt
  df_treatment <- read.csv(fpath, sep = ",") %>% dplyr::rename(subarea = "X")
  # Sudan
  south_sudan <- df_treatment %>%
    dplyr::filter(subarea == "Sudan") %>%
    dplyr::mutate(subarea = "South Sudan")
  # Palestine
  palestine <- df_treatment %>%
    dplyr::filter(subarea == "Egypt") %>%
    dplyr::mutate(subarea = "Palestine")
  # Yugoslavia
  serbia <- df_treatment %>%
    dplyr::filter(subarea == "Yugoslavia") %>%
    dplyr::mutate(subarea = "Serbia")
  kosovo <- df_treatment %>%
    dplyr::filter(subarea == "Yugoslavia") %>%
    dplyr::mutate(subarea = "Kosovo")
  montenegro <- df_treatment %>%
    dplyr::filter(subarea == "Yugoslavia") %>%
    dplyr::mutate(subarea = "Montenegro")
  # Antilles
  curacao <- df_treatment %>%
    dplyr::filter(subarea == "Netherlands Antilles") %>%
    dplyr::mutate(subarea = "Curacao")
  bes <- df_treatment %>%
    dplyr::filter(subarea == "Netherlands Antilles") %>%
    dplyr::mutate(subarea = "Bonaire, Saint Eustatius and Saba")
  sintmaarten <- df_treatment %>%
    dplyr::filter(subarea == "Netherlands Antilles") %>%
    dplyr::mutate(subarea = "Sint Maarten")

  df_treatment <-
    rbind(
      df_treatment,
      south_sudan,
      palestine,
      serbia,
      kosovo,
      montenegro,
      curacao,
      bes,
      sintmaarten
    )


  # try to match
  NAME <- ISO3 <- name_country <- subarea <- NULL
  df_country_codes <- geodata::country_codes() %>%
    dplyr::mutate(
      name_country = stringi::stri_trans_general(NAME, id = "Latin-ASCII")
    ) %>%
    dplyr::select(ISO3, name_country)

  df_treatment_codes <- df_treatment %>%
    dplyr::select("subarea") %>%
    dplyr::left_join(df_country_codes, by = dplyr::join_by(subarea == name_country))

  # some manual edits
  df_treatment_codes <- df_treatment_codes %>% dplyr::mutate(
    ISO3 = dplyr::case_when(
      subarea == "Brunei Darussalam" ~ "BRN",
      subarea == "Burkina" ~ "BFA",
      subarea == "Cape Verde" ~ "CPV",
      subarea == "Congo. Dem. Republic" ~ "COD",
      subarea == "Falklands Isl. (Malvinas)" ~ "FLK",
      subarea == "Guinea Buissau" ~ "GNB",
      subarea == "Kazakstan" ~ "KAZ",
      subarea == "Korea. Dem. People's Rep." ~ "PRK",
      subarea == "Korea. Rep. of" ~ "KOR",
      subarea == "Lao. People's Dem. Rep." ~ "LAO",
      subarea == "Libyan Arab Jamahiriya" ~ "LBY",
      subarea == "Russian Federation" ~ "RUS",
      subarea == "Saint Pierre. Miquelon" ~ "SPM",
      subarea == "Saint Vincent Grenadines" ~ "VCT",
      subarea == "Swaziland" ~ "SWZ",
      subarea == "Syrian Arab Republic" ~ "SYR",
      subarea == "Taiwan. Province of China" ~ "TWN",
      subarea == "Turks and Caicos Isl." ~ "TCA",
      subarea == "Viet Nam" ~ "VNM",
      subarea == "Virgin Islands. U.S." ~ "VIR",
      .default = ISO3
    )
  )

  df_treatment_merged <-
    df_treatment_codes %>% dplyr::left_join(df_treatment, by = "subarea")
  iso_country <- NA
  df_treatment_iso <- df_isodata %>%
    dplyr::select(iso_country) %>%
    unique() %>%
    dplyr::left_join(df_treatment_merged, by = dplyr::join_by(iso_country == ISO3)) %>%
    na.omit()
  primary2010 <- secondary2010 <- tertiary2010 <- NULL
  df_treatment_iso <- df_treatment_iso %>%
    dplyr::mutate(
      FractionPrimarytreatment = primary2010 * 1 /
        (primary2010 + secondary2010 + tertiary2010),
      FractionSecondarytreatment = secondary2010 * 1 /
        (primary2010 + secondary2010 + tertiary2010),
      FractionTertiarytreatment = tertiary2010 * 1 /
        (primary2010 + secondary2010 + tertiary2010)
    )

  df_treatment_iso$FractionQuaternarytreatment <- NA
  df_treatment_iso$FractionPonds <- NA

  # Category	  Description	        Group	  Log10 Reduction	Percent Reduction	Percent in Liquid Effluent	Percent in Sludge/ Biosolids
  # Category 1	Primary Treatment	  Viruses	  0.6	75%	97%	3%
  # Category 2	Secondary Treatment	Viruses	  1.3	95%	50%	50%
  # Category 3	Tertiary Treatment	Viruses	  2.0	99%	40%	60%
  # Category 1	Primary Treatment	  Bacteria	0.6	75%	99%	1%
  # Category 2	Secondary Treatment	Bacteria	2.0	99%	95%	5%
  # Category 3	Tertiary Treatment	Bacteria	2.3	99.5%	95%	5%
  # Category 1	Primary Treatment	  Protozoa	0.3	50%	85%	15%
  # Category 2	Secondary Treatment	Protozoa	1.0	90%	20%	80%
  # Category 3	Tertiary Treatment	Protozoa	1.1	92%	25%	75%
  # Category 1	Primary Treatment	  Helminth	1.3	95%	20%	80%
  # Category 2	Secondary Treatment	Helminth	1.4	96%	1%	99%
  # Category 3	Tertiary Treatment	Helminth	1.5	97%	1%	99%

  primary_viruses <- 0.75
  primary_viruses_liquid <- 0.97
  secondary_viruses <- 0.95
  secondary_viruses_liquid <- 0.50
  tertiary_viruses <- 0.99
  tertiary_viruses_liquid <- 0.40

  primary_protozoa <- 0.5
  primary_protozoa_liquid <- 0.85
  secondary_protozoa <- 0.90
  secondary_protozoa_liquid <- 0.20
  tertiary_protozoa <- 0.92
  tertiary_protozoa_liquid <- 0.25

  # virus
  primary_viruses_femmited <-
    primary_viruses_liquid - primary_viruses_liquid * primary_viruses
  secondary_viruses_femitted <-
    secondary_viruses_liquid - secondary_viruses_liquid * secondary_viruses
  tertiary_viruses_femitted <-
    tertiary_viruses_liquid - tertiary_viruses_liquid * tertiary_viruses

  # protozoa
  primary_protozoa_femitted <-
    primary_protozoa_liquid - primary_protozoa_liquid * primary_protozoa
  secondary_protozoa_femitted <-
    secondary_protozoa_liquid - secondary_protozoa_liquid * secondary_protozoa
  tertiary_protozoa_femitted <-
    tertiary_protozoa_liquid - tertiary_protozoa_liquid * tertiary_protozoa

  FractionPrimarytreatment <-
    FractionSecondarytreatment <- FractionTertiarytreatment <- NULL
  df_treatment_iso <- df_treatment_iso %>%
    dplyr::mutate(
      fRemoval_treatment_virus = FractionPrimarytreatment * primary_viruses +
        FractionSecondarytreatment * secondary_viruses +
        FractionTertiarytreatment * tertiary_viruses,
      fRemoval_treatment_protozoa = FractionPrimarytreatment * primary_protozoa +
        FractionSecondarytreatment * secondary_protozoa +
        FractionTertiarytreatment * tertiary_protozoa,
      fEmitted_inEffluent_after_treatment_virus =
        FractionPrimarytreatment * primary_viruses_femmited +
          FractionSecondarytreatment * secondary_viruses_femitted +
          FractionTertiarytreatment * tertiary_viruses_femitted,
      fEmitted_inEffluent_after_treatment_protozoa =
        FractionPrimarytreatment * primary_protozoa_femitted +
          FractionSecondarytreatment * secondary_protozoa_femitted +
          FractionTertiarytreatment * tertiary_protozoa_femitted
    )

  fEmitted_inEffluent_after_treatment_virus <-
    fEmitted_inEffluent_after_treatment_protozoa <- NULL
  # currently only these fractions are used.
  df_treatment_iso_cleaned <- df_treatment_iso %>% dplyr::select(
    iso_country,
    fEmitted_inEffluent_after_treatment_virus,
    fEmitted_inEffluent_after_treatment_protozoa
  )

  df_isodata <-
    df_isodata %>%
    dplyr::inner_join(df_treatment_iso_cleaned, by = "iso_country")
  return(df_isodata)
}

prepare_animals_gridded_glw <- function(rast_domain) {
  Value <- cattle <- ISO3 <- Item <- NULL
  # heads per square km (density) for reference year 2005
  rast_chickens <-
    terra::rast(
      file.path(
        getOption("glowpa.datasources"),
        "livestockgeowiki_2006/chickens/Glb_chkAD_2006_paper.tif"
      )
    )
  rast_cattle <-
    terra::rast(file.path(
      getOption("glowpa.datasources"),
      "livestockgeowiki_2006/cattle/Glb_Cattle_CC2006_AD.tif"
    ))
  rast_ducks <-
    terra::rast(file.path(
      getOption(
        "glowpa.datasources"
      ),
      "livestockgeowiki_2006/ducks/GLb_Ducks_CC2006_AD.tif"
    ))
  rast_goats <-
    terra::rast(file.path(
      getOption("glowpa.datasources"),
      "livestockgeowiki_2006/goats/Glb_GTAD_2006.tif"
    ))
  rast_pigs <-
    terra::rast(file.path(
      getOption("glowpa.datasources"),
      "livestockgeowiki_2006/pigs/Glb_Pigs_CC2006_AD.tif"
    ))
  rast_sheep <-
    terra::rast(file.path(
      getOption("glowpa.datasources"),
      "livestockgeowiki_2006/sheep/Glb_SHAD_2006.tif"
    ))
  rast_animals <-
    terra::rast(
      list(
        chickens = rast_chickens,
        cattle = rast_cattle,
        ducks = rast_ducks,
        goats = rast_goats,
        pigs = rast_pigs,
        sheep = rast_sheep
      )
    )
  rast_animals_domain <-
    terra::mask(
      terra::resample(rast_animals, rast_domain, method = "average"),
      rast_domain
    )
  rast_animal_heads <-
    rast_animals_domain * terra::cellSize(rast_domain$isoraster, unit = "km")

  rast_zero <-
    terra::mask(
      terra::rast(rast_domain$iso_country, vals = 0),
      rast_domain$iso_country
    )

  # FAOSTAT DATA

  df_livestock <- prepare_faostat(2005)
  # BUFFALOES
  df_buffaloes <- df_livestock %>% dplyr::filter(Item == "Buffalo")
  # calculate zonal sums
  df_cattle_by_country <-
    terra::zonal(
      rast_animal_heads$cattle,
      rast_domain$iso_country,
      fun = "sum",
      na.rm = TRUE
    )
  df_buffaloes <- df_buffaloes %>%
    dplyr::inner_join(df_cattle_by_country, by = dplyr::join_by(ISO3 == iso_country)) %>%
    dplyr::mutate(ratio = Value / cattle) %>%
    dplyr::select(!c("cattle"))

  if (nrow(df_buffaloes) > 0) {
    rast_ratio <-
      terra::subst(
        rast_domain$iso_country,
        from = df_buffaloes$ISO3,
        to = df_buffaloes$ratio,
        others = 0
      )
    rast_buffaloes <- rast_animal_heads$cattle * rast_ratio
  } else {
    rast_buffaloes <- rast_zero
  }

  # HORSES, MULES, ASSES and CAMELS
  Value <- sheep <- Item <- ISO3 <- iso_country <- NULL
  rast_sheepgoat <-
    sum(rast_animal_heads$sheep, rast_animal_heads$goats, na.rm = TRUE)
  df_sheepgoat_by_country <-
    terra::zonal(
      rast_sheepgoat,
      rast_domain$iso_country,
      fun = "sum",
      na.rm = TRUE
    )
  df_others <-
    df_livestock %>%
    dplyr::filter(Item %in% c("Asses", "Camels", "Horses", "Mules and hinnies"))
  df_others <- df_others %>%
    dplyr::inner_join(df_sheepgoat_by_country, by = dplyr::join_by(ISO3 == iso_country)) %>%
    dplyr::mutate(ratio = Value / sheep) %>%
    dplyr::select(!c("sheep"))

  df_asses <- df_others %>% dplyr::filter(Item == "Asses")
  df_camels <- df_others %>% dplyr::filter(Item == "Camels")
  df_horses <- df_others %>% dplyr::filter(Item == "Horses")
  df_mules <- df_others %>% dplyr::filter(Item == "Mules and hinnies")

  if (nrow(df_asses) > 0) {
    rast_asses_ratio <-
      terra::subst(
        rast_domain$iso_country,
        from = df_asses$ISO3,
        to = df_asses$ratio,
        others = 0
      )
    rast_asses <- rast_sheepgoat * rast_asses_ratio
  } else {
    rast_asses <- rast_zero
  }

  if (nrow(df_camels) > 0) {
    rast_ratio <-
      terra::subst(
        rast_domain$iso_country,
        from = df_camels$ISO3,
        to = df_camels$ratio,
        others = 0
      )
    rast_camels <- rast_sheepgoat * rast_ratio
  } else {
    rast_camels <- rast_zero
  }

  if (nrow(df_horses) > 0) {
    rast_ratio <-
      terra::subst(
        rast_domain$iso_country,
        from = df_horses$ISO3,
        to = df_horses$ratio,
        others = 0
      )
    rast_horses <- rast_sheepgoat * rast_ratio
  } else {
    rast_horses <- rast_zero
  }

  if (nrow(df_mules) > 0) {
    rast_ratio <-
      terra::subst(
        rast_domain$iso_country,
        from = df_mules$ISO3,
        to = df_mules$ratio,
        others = 0
      )
    rast_mules <- rast_sheepgoat * rast_ratio
  } else {
    rast_mules <- rast_zero
  }

  rast_others <-
    terra::rast(
      list(
        buffaloes = rast_buffaloes,
        asses = rast_asses,
        camels = rast_camels,
        horses = rast_horses,
        mules = rast_mules
      )
    )
  rast_animal_heads <- round(c(rast_animal_heads, rast_others))

  return(rast_animal_heads)
}

prepare_animals_gridded_glw4 <- function(rast_domain, vect_country) {
  Item <-
    sheep <-
    Value <- ISO3 <- iso_country <- value_2015 <- value_2020 <- NULL
  # read the livestock animal density per km2
  fpaths <-
    list.files(file.path(getOption("glowpa.datasources"), "glw4_2020"),
      pattern = ".tif$",
      full.names = TRUE
    )
  rast_animal_density <- terra::rast(fpaths)

  rast_animal_density_domain <-
    terra::resample(rast_animal_density, rast_domain, method = "average")
  names(rast_animal_density_domain) <-
    c("buffaloes", "chickens", "cattle", "goats", "pigs", "sheep")

  rast_animal_heads <-
    rast_animal_density_domain * terra::cellSize(rast_domain, unit = "km")

  # FOASTAT data
  df_faostat <- prepare_faostat(2020)
  df_ducks_2020 <- df_faostat %>%
    dplyr::filter(Item == "Ducks") %>%
    dplyr::rename(value_2020 = "Value") %>%
    dplyr::select(ISO3, value_2020)
  df_ducks_2015 <- prepare_faostat(2015) %>%
    dplyr::filter(Item == "Ducks") %>%
    dplyr::rename(value_2015 = "Value") %>%
    dplyr::select(ISO3, value_2015)

  country_codes <- unique(vect_country$GID_0)
  df_ducks <- data.frame(ISO3 = country_codes)
  # calculate the fraction of duck heads in 2020 compared to 2015 by country
  df_ducks <- df_ducks %>%
    dplyr::left_join(df_ducks_2020, by = "ISO3") %>%
    dplyr::left_join(df_ducks_2015, by = "ISO3") %>%
    dplyr::mutate(frac = dplyr::case_when(
      !is.na(value_2020) & !is.na(value_2015) ~ value_2020 / value_2015,
      !is.na(value_2020) ~ 1,
      !is.na(value_2015) ~ 1,
      .default = NA
    ))

  rast_ducks_frac <-
    terra::catalyze(
      terra::subst(
        rast_domain$iso_country,
        from = df_ducks$ISO3,
        to = df_ducks$frac,
        others = 0
      )
    )

  # for spatial distribution we use the 2015 reference data. load density per
  # km2
  rast_ducks_2015 <-
    terra::rast(file.path(
      getOption("glowpa.datasources"),
      "glw4_2015/5_Dk_2015_Da.tif"
    ))
  rast_duck_heads_2015 <-
    terra::resample(rast_ducks_2015, rast_domain, method = "average") * terra::cellSize(rast_domain, unit = "km")
  rast_ducks <- rast_duck_heads_2015 * rast_ducks_frac

  rast_zero <-
    terra::mask(
      terra::rast(rast_domain$iso_country, vals = 0),
      rast_domain$iso_country
    )

  # HORSES, MULES, ASSES and CAMELS
  rast_sheepgoat <-
    sum(rast_animal_heads$sheep + rast_animal_heads$goats, na.rm = TRUE)
  names(rast_sheepgoat) <- c("sheep")

  df_sheepgoat_by_country <-
    terra::zonal(
      rast_sheepgoat,
      rast_domain$iso_country,
      fun = "sum",
      na.rm = TRUE
    )
  df_others <-
    df_faostat %>% dplyr::filter(Item %in% c("Asses", "Camels", "Horses", "Mules and hinnies"))
  df_others <- df_others %>%
    dplyr::inner_join(df_sheepgoat_by_country, by = dplyr::join_by(ISO3 == iso_country)) %>%
    dplyr::mutate(ratio = Value / sheep) %>%
    dplyr::select(!c("sheep"))

  df_asses <- df_others %>% dplyr::filter(Item == "Asses")
  df_camels <- df_others %>% dplyr::filter(Item == "Camels")
  df_horses <- df_others %>% dplyr::filter(Item == "Horses")
  df_mules <- df_others %>% dplyr::filter(Item == "Mules and hinnies")

  if (nrow(df_asses) > 0) {
    rast_asses_ratio <-
      terra::subst(
        rast_domain$iso_country,
        from = df_asses$ISO3,
        to = df_asses$ratio,
        others = 0
      )
    rast_asses <- rast_sheepgoat * rast_asses_ratio
  } else {
    rast_asses <- rast_zero
  }

  if (nrow(df_camels) > 0) {
    rast_ratio <-
      terra::subst(
        rast_domain$iso_country,
        from = df_camels$ISO3,
        to = df_camels$ratio,
        others = 0
      )
    rast_camels <- rast_sheepgoat * rast_ratio
  } else {
    rast_camels <- rast_zero
  }

  if (nrow(df_horses) > 0) {
    rast_ratio <-
      terra::subst(
        rast_domain$iso_country,
        from = df_horses$ISO3,
        to = df_horses$ratio,
        others = 0
      )
    rast_horses <- rast_sheepgoat * rast_ratio
  } else {
    rast_horses <- rast_zero
  }

  if (nrow(df_mules) > 0) {
    rast_ratio <-
      terra::subst(
        rast_domain$iso_country,
        from = df_mules$ISO3,
        to = df_mules$ratio,
        others = 0
      )
    rast_mules <- rast_sheepgoat * rast_ratio
  } else {
    rast_mules <- rast_zero
  }

  rast_others <-
    terra::rast(
      list(
        ducks = rast_ducks,
        asses = rast_asses,
        camels = rast_camels,
        horses = rast_horses,
        mules = rast_mules
      )
    )

  rast_animal_heads <- round(c(rast_animal_heads, rast_others))
  return(rast_animal_heads)
}

download_glw4_2020 <- function() {
  # GLW4 for reference year 2020. Note that FAOSTAT data of 2020 should be used
  # to create other grids
  buffaloes_url <-
    "https://storage.googleapis.com/fao-gismgr-glw4-2020-data/DATA/GLW4-2020/MAPSET/D-DA/GLW4-2020.D-DA.BFL.tif"
  chickens_url <-
    "https://storage.googleapis.com/fao-gismgr-glw4-2020-data/DATA/GLW4-2020/MAPSET/D-DA/GLW4-2020.D-DA.CHK.tif"
  cattle_url <-
    "https://storage.googleapis.com/fao-gismgr-glw4-2020-data/DATA/GLW4-2020/MAPSET/D-DA/GLW4-2020.D-DA.CTL.tif"
  goats_url <-
    "https://storage.googleapis.com/fao-gismgr-glw4-2020-data/DATA/GLW4-2020/MAPSET/D-DA/GLW4-2020.D-DA.GTS.tif"
  pigs_url <-
    "https://storage.googleapis.com/fao-gismgr-glw4-2020-data/DATA/GLW4-2020/MAPSET/D-DA/GLW4-2020.D-DA.PGS.tif"
  sheep_url <-
    "https://storage.googleapis.com/fao-gismgr-glw4-2020-data/DATA/GLW4-2020/MAPSET/D-DA/GLW4-2020.D-DA.SHP.tif"

  urls <- c(buffaloes_url, chickens_url, cattle_url, goats_url, pigs_url, sheep_url)

  for (url in urls) {
    rast_animal <- terra::rast(url)
    fpath <-
      file.path(
        getOption("glowpa.datasources"),
        "glw4_2020",
        paste0(names(rast_animal)[1], ".tif")
      )
    terra::writeRaster(rast_animal, fpath, overwrite = TRUE)
  }
}

prepare_livestock_isodata <- function() {
  excr_adult <- excr_young <- NULL
  # Read datasets related to the study of Vermeulen 2017. Please read the
  # supplementary materials of the paper.
  fpath <-
    file.path(
      getOption("glowpa.datasources"),
      "vermeulen_2017/animals.csv"
    )
  df_animals <- read.csv(fpath, sep = ",")
  fpath <-
    file.path(
      getOption("glowpa.datasources"),
      "vermeulen_2017/ippc_region_animal.csv"
    )
  df_region_animal <- read.csv(fpath, sep = ",")

  df_region_animal <- df_region_animal %>%
    dplyr::left_join(df_animals, by = "animal") %>%
    dplyr::select(
      c(
        "ipcc_region",
        "animal",
        "mass_adult",
        "prev_adult",
        "prev_young",
        "excr_adult",
        "excr_young",
        "excr_day",
        "birth_weight",
        "manure_per_mass",
        "frac_lt_3m" # fraction animals younger than 3 months
      )
    ) %>%
    dplyr::rename(mass_young = "birth_weight", frac_young = "frac_lt_3m") %>%
    dplyr::mutate(
      excr_young = round(excr_young),
      excr_adult = round(excr_adult)
    )

  return(df_region_animal)
}

prepare_country_groupings <- function(vect_country) {
  ipcc_region <- NULL
  fpath <- file.path(getOption("glowpa.datasources"), "unsd/UNSD_countries.csv")
  df_unsd_countries <- read.csv(fpath, sep = ";")

  df_unsd_countries <- df_unsd_countries %>%
    dplyr::mutate(
      ipcc_region = dplyr::case_when(
        Sub.region.Code %in% c(202) ~ "Africa",
        Sub.region.Code %in% c(30, 34, 35, 143) ~ "Asia",
        Sub.region.Code %in% c(39, 151, 154, 155) ~ "Europe",
        Sub.region.Code %in% c(419) ~ "Latin America",
        Sub.region.Code %in% c(145, 15) ~ "NENA",
        Sub.region.Code %in% c(21) ~ "North America",
        Sub.region.Code %in% c(53, 54, 57, 61) ~ "Oceania",
        .default = NA
      ),
      sdg_region = dplyr::case_when(
        Sub.region.Code == 202 ~ "Sub-Saharan Africa",
        Sub.region.Code %in% c(145, 15) ~ "Northern Africa and Western Asia",
        Sub.region.Code %in% c(34, 143) ~ "Central and Southern Asia",
        Sub.region.Code %in% c(30, 35) ~ "Eastern and South-Easternn Asia",
        Sub.region.Code == 419 ~ "Latin America and the Caribbean",
        Sub.region.Code == 53 ~ "Australia and New Zealand",
        Sub.region.Code %in% c(54, 57, 61) ~ "Oceania",
        Sub.region.Code %in% c(21, 39, 151, 154, 155) ~ "Europe and Northern America",
        .default = NA
      )
    ) %>%
    # Move Russia from Europe to Asia
    dplyr::mutate(
      ipcc_region = dplyr::case_when(
        ISO.alpha3.Code == "RUS" ~ "Asia",
        .default = ipcc_region
      )
    ) %>%
    dplyr::rename(
      least_developed_countries =
        "Least.Developed.Countries..LDC.",
      land_locked_developing_countries =
        "Land.Locked.Developing.Countries..LLDC.",
      small_island_developing_states =
        "Small.Island.Developing.States..SIDS."
    ) %>%
    dplyr::mutate(
      least_developed_countries = dplyr::case_when(least_developed_countries == "x" ~ 1,
        .default = 0
      ),
      land_locked_developing_countries = dplyr::case_when(land_locked_developing_countries == "x" ~ 1,
        .default = 0
      ),
      small_island_developing_states = dplyr::case_when(small_island_developing_states == "x" ~ 1,
        .default = 0
      )
    )
  # keep all entries from vect_country because these are the gadm countries
  vect_un_countries <-
    terra::merge(
      vect_country,
      df_unsd_countries,
      by.x = "GID_0",
      by.y = "ISO.alpha3.Code",
      all.x = TRUE
    )
  return(vect_un_countries)
}

prepare_faostat <- function(year) {
  ISO3 <- Year <- Value <- Item <- Unit <- NULL
  fpath <-
    file.path(
      getOption("glowpa.datasources"),
      "faostat_2024/FAOSTAT_data_en_8-13-2024.csv"
    )
  df_faostat <-
    read.csv(fpath, sep = ",") %>% dplyr::rename(ISO3 = "Area.Code..ISO3.")
  df_livestock <- df_faostat %>%
    dplyr::filter(Year == year) %>%
    dplyr::select(ISO3, Value, Item, Unit)
  df_livestock <- df_livestock %>%
    dplyr::mutate(Value = dplyr::case_when(
      Unit == "1000 An" ~ Value * 1e3,
      .default = Value
    )) %>%
    dplyr::select(!Unit)
  return(df_livestock)
}

prepare_livestock_vermeulen <- function(rast_domain) {
  fpath <-
    file.path(
      getOption("glowpa.datasources"),
      "vermeulen_2017/nutdata_2000_iso.tif"
    )
  # Uses level 0 country boundaries except for USA and China
  rast_nutdata_regions <- terra::rast(fpath)
  # crop regions to domain
  if (!terra::compareGeom(rast_nutdata_regions, rast_domain,
    stopOnError = FALSE
  )) {
    rast_nutdata_regions <-
      terra::resample(rast_nutdata_regions, rast_domain, method = "near")
  }

  fpath <-
    file.path(
      getOption("glowpa.datasources"),
      "vermeulen_2017/nutdata_2000_intensive_extensive.csv"
    )
  df_livestock_systems <- read.csv(fpath, sep = ",")

  livestock_names <-
    c(
      "meat",
      "dairy",
      "buffaloes",
      "pigs",
      "poultry",
      "sheep",
      "goats",
      "horses",
      "asses",
      "mules",
      "camels"
    )


  df_livestock_systems_domain <- data.frame()
  for (livestock in livestock_names) {
    for (system_abbr in c("i", "e")) {
      var_name <- paste0(livestock, "_", system_abbr)
      vals <- df_livestock_systems[[var_name]]
      rast_system <-
        terra::subst(
          rast_nutdata_regions,
          from = df_livestock_systems$iso,
          to = vals,
          others = NA
        )
      names(rast_system) <- c("frac")
      df_system <-
        terra::zonal(rast_system,
          rast_domain$isoraster,
          fun = "mean",
          na.rm = TRUE
        )
      df_system$livestock <- livestock
      df_system$system <- system_abbr
      df_livestock_systems_domain <-
        rbind(df_livestock_systems_domain, df_system)
    }
  }

  df_livestock_systems_domain$frac <- round(df_livestock_systems_domain$frac, 2)

  df_livestock_systems_domain <- df_livestock_systems_domain %>%
    dplyr::group_by(livestock, system) %>%
    dplyr::group_map(~ dplyr::rename(.x, !!paste0(.y[1], "_", .y[2]) := "frac")) %>%
    purrr::reduce(dplyr::left_join, by = "isoraster") %>%
    dplyr::rename(iso = "isoraster")

  fpath <-
    file.path(
      getOption("glowpa.datasources"),
      "vermeulen_2017/nutdata_2000_fractions_mm.csv"
    )
  df_livestock_manure <- read.csv(fpath, sep = ",")

  df_livestock_manure_domain <- data.frame()
  for (livestock in livestock_names) {
    for (sink in c("g", "o")) {
      for (system_abbr in c("i", "e")) {
        var_name <- paste0(livestock, "_f", sink, system_abbr)
        vals <- df_livestock_manure[[var_name]]
        rast_system <-
          terra::subst(
            rast_nutdata_regions,
            from = df_livestock_manure$iso,
            to = vals,
            others = NA
          )
        names(rast_system) <- c("frac")
        df_system <-
          terra::zonal(rast_system,
            rast_domain$isoraster,
            fun = "mean",
            na.rm = TRUE
          )
        df_system$livestock <- livestock
        df_system$system <- system_abbr
        df_system$sink <- sink
        df_livestock_manure_domain <-
          rbind(df_livestock_manure_domain, df_system)
      }
    }
  }

  df_livestock_manure_domain$frac <- round(df_livestock_manure_domain$frac, 2)

  df_livestock_manure_domain <- df_livestock_manure_domain %>%
    dplyr::group_by(livestock, sink, system) %>%
    dplyr::group_map(~ dplyr::rename(.x, !!paste0(.y[1], "_f", .y[2], .y[3]) := "frac")) %>%
    purrr::reduce(dplyr::left_join, by = "isoraster") %>%
    dplyr::rename(iso = "isoraster")

  # Storage systems
  fpath <-
    file.path(
      getOption("glowpa.datasources"),
      "vermeulen_2017",
      "manure_management_systems.csv"
    )
  df_manure_storage <- read.csv(fpath, sep = ",")

  ISO3 <- ISO3.Code <- M49.Code <- NULL
  storage_systems <- c("PP", "DS", "SS", "DL", "LS", "UAL", "AD", "BF", "O")
  # get country codes
  df_countries <- geodata::country_codes()
  # get the un code classification (m49)
  df_fao_countries <-
    read.csv(file.path(
      getOption("glowpa.datasources"),
      "faostat_2024",
      "FAOSTAT_country_groups_2024.csv"
    )) %>%
    dplyr::filter(ISO3.Code %in% df_countries$ISO3) %>%
    dplyr::select(ISO3.Code, M49.Code) %>%
    unique()
  # join both data.frames to map iso 3 codes to un codes
  df_countries <- df_countries %>%
    dplyr::left_join(df_fao_countries, by = dplyr::join_by(ISO3 == ISO3.Code))
  iso <- NULL
  # FIX SUDAN (Sudan split into Sudan and South Sudan in the year 2011) to meet
  # updated gadm data
  df_manure_sudan <- df_manure_storage %>% dplyr::filter(iso == 736)
  df_manure_sudan_new <- df_manure_sudan %>% dplyr::mutate(iso = 729)
  df_manure_south_sudan <- df_manure_sudan %>% dplyr::mutate(iso = 728)
  df_manure_storage <-
    rbind(
      df_manure_storage,
      df_manure_sudan_new,
      df_manure_south_sudan
    )

  # rasterize the FAO/UN Codes used in the manure management data
  rast_fao_codes <-
    terra::subst(
      rast_domain$iso_country,
      from = df_countries$ISO3,
      to = df_countries$M49.Code,
      others = NA
    )

  df_manure_storage_domain <- data.frame()
  for (livestock in livestock_names) {
    for (ss in storage_systems) {
      var_name <- paste0(ss, "_", livestock)
      vals <- df_manure_storage[[var_name]]
      if (!is.null(vals)) {
        rast_system <-
          terra::subst(rast_fao_codes,
            from = df_manure_storage$iso,
            to = vals,
            others = NA
          )
        names(rast_system) <- "frac"
        df_system <- terra::zonal(rast_system,
          rast_domain$isoraster,
          fun = "mean",
          na.rm = TRUE
        )
        df_system$livestock <- livestock
        df_system$system <- ss
        df_manure_storage_domain <- rbind(df_manure_storage_domain, df_system)
      }
    }
  }

  df_manure_storage_domain$frac <- round(df_manure_storage_domain$frac, 2)

  df_manure_storage_domain <- df_manure_storage_domain %>%
    dplyr::group_by(system, livestock) %>%
    dplyr::group_map(~ dplyr::rename(.x, !!paste0(.y[1], "_", .y[2]) := "frac")) %>%
    purrr::reduce(dplyr::left_join, by = "isoraster") %>%
    dplyr::rename(iso = "isoraster")

  return(
    list(
      production_systems = df_livestock_systems_domain,
      manure_fractions = df_livestock_manure_domain,
      manure_storage = df_manure_storage_domain
    )
  )
}

prepare_vic_watch <- function(rast_domain) {
  fpath <-
    file.path(
      getOption("glowpa.datasources"),
      "vic_watch",
      "1970_2000_Tair_year.asc"
    )
  rast_airtemp <- terra::rast(fpath)
  if (!terra::compareGeom(rast_airtemp, rast_domain)) {
    rast_airtemp <-
      terra::resample(rast_airtemp, rast_domain, method = "bilinear")
  }
  terra::metags(rast_airtemp) <- c(source = "VIC-WATCH")
  return(rast_airtemp)
}

prepare_worldclim <- function(rast_domain) {
  res_degrees <- terra::res(rast_domain)[1]
  res_minutes <- round(res_degrees * 60, 2)
  rast_airtemp_month <-
    geodata::worldclim_global("tavg",
      res = res_minutes,
      path = tempdir(),
      version = "2.1"
    )
  rast_airtemp_year <- terra::app(rast_airtemp_month, fun = "mean")
  terra::metags(rast_airtemp_year) <- c(source = "WorldClim_v2.1")
  return(rast_airtemp_year)
}

prepare_hydrowaste <- function(vect_domain) {
  treatment_type <-
    LAT_WWTP <- LON_WWTP <- POP_SERVED <- LEVEL <- STATUS <- NULL
  fpath <-
    file.path(
      getOption("glowpa.datasources"),
      "hydrowaste_2022",
      "HydroWASTE_v10.csv"
    )
  df_waste <- read.csv(fpath, sep = ",")
  df_waste <- df_waste %>%
    dplyr::filter(STATUS %in% c("Not Reported", "Operational")) %>%
    dplyr::select(LAT_WWTP, LON_WWTP, POP_SERVED, LEVEL) %>%
    dplyr::rename(
      lat = "LAT_WWTP",
      lon = "LON_WWTP",
      capacity = "POP_SERVED",
      treatment_type = "LEVEL"
    ) %>%
    dplyr::mutate(
      treatment_type =
        dplyr::case_when(treatment_type == "Advanced" ~ "Tertiary",
          .default = treatment_type
        )
    )
  # convert to vector and crop using modelling domain
  vect_waste <- terra::vect(df_waste, geom = c("lon", "lat"))
  vect_waste_domain <- terra::intersect(vect_waste, vect_domain)
  df_wwtp <- terra::as.data.frame(vect_waste_domain, geom = "XY") %>%
    dplyr::select(c("capacity", "treatment_type", "x", "y")) %>%
    dplyr::rename(lat = "y", lon = "x")
  return(df_wwtp)
}