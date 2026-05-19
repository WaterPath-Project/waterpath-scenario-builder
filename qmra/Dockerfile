# QMRA container — wraps the GloWPaQMRA R package
#
# Built on the same upstream image as the GloWPa container so that all
# geospatial dependencies (terra, dplyr, MASS, ...) are already present.
# Adds the QMRA-specific R packages and installs the GloWPaQMRA package
# from GitHub (https://github.com/microstijn/GloWPaQMRA).
FROM docker-registry.wur.nl/glowpa/glowpa-r/glowpa-main:0.2.1

# CRAN mirror used for any extra packages.
ENV R_REPOS=https://cloud.r-project.org

# System deps required to build QMRA's transitive R dependencies:
#   - cmake: needed by `nloptr` (pulled in by rockchalk -> lme4 -> nloptr)
RUN apt-get update \
 && apt-get install -y --no-install-recommends cmake \
 && rm -rf /var/lib/apt/lists/*

# Install QMRA dependencies that aren't already in the GloWPa base image.
RUN Rscript -e 'install.packages(c("EnvStats", "matrixStats", "rockchalk", "remotes"), repos=Sys.getenv("R_REPOS"))'

# Install the GloWPaQMRA package from GitHub.  The package exports
# `qmra_ras_batch_fast()` which is the main user-facing function used by
# the Flask backend (webapp/backend/qmra.py).
#
# NOTE: The upstream repo ships `R/qmra_run.R` as a runnable example with
# top-level `setwd("your wd")`, which executes at install time and aborts
# package loading.  We download the source, drop that example file, and
# install from the cleaned-up directory.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git clone --depth 1 https://github.com/microstijn/GloWPaQMRA.git /tmp/GloWPaQMRA \
 && rm -f /tmp/GloWPaQMRA/R/qmra_run.R \
 && Rscript -e 'remotes::install_local("/tmp/GloWPaQMRA", upgrade = "never")' \
 && Rscript -e 'stopifnot(requireNamespace("GloWPaQMRA", quietly = TRUE))' \
 && rm -rf /tmp/GloWPaQMRA

# Working dir matches the bind mount used by docker-compose: /app/data
WORKDIR /app/data

# Keep the container alive for `docker exec` invocations from the backend.
CMD ["tail", "-f", "/dev/null"]
