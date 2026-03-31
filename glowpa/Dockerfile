FROM docker-registry.wur.nl/glowpa/glowpa-r/glowpa-main:0.2.1

RUN Rscript -e 'install.packages("renv", repos="https://cloud.r-project.org")' \
 && Rscript -e 'renv::install("git::https://git.wur.nl/glowpa/pathogenflows.git")'
