# postgis/postgis publishes amd64 only, so PostGIS is installed onto the official
# postgres image instead of pulling a prebuilt one. Native on arm64 and amd64 both.
FROM postgres:16-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        postgresql-16-postgis-3 \
        postgresql-16-postgis-3-scripts \
    && rm -rf /var/lib/apt/lists/*
