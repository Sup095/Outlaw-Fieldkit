# FieldKit RUNNER :: the box for Windows programs (.exe)
#
# The same box as runnerd/image with Wine added, kept separate because
# Wine is most of a gigabyte and most jobs are scripts. Console
# programs only at this stage: there is no display in here, so a
# program that opens a window prints an error instead. Windows with
# pictures arrive with the GPU and video phase.
FROM debian:trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends wine wine64 ca-certificates python3-minimal libpython3-stdlib \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Wine writes a "prefix" (a fake C: drive) on first run, about 30 s of
# work. Doing it once here, as the user jobs run as, means a job starts
# in a second instead. It is copied into the job's own /work at start,
# because the image itself is read-only when a job runs.
ENV WINEDEBUG=-all WINEARCH=win64
RUN mkdir -p /opt/wineprefix && chown 65534:65534 /opt/wineprefix
USER 65534:65534
RUN HOME=/tmp WINEPREFIX=/opt/wineprefix wineboot --init >/dev/null 2>&1; \
    HOME=/tmp WINEPREFIX=/opt/wineprefix wineserver -w; true

USER root
COPY run-exe.sh /usr/local/bin/wine-run
RUN sed -i 's/\r$//' /usr/local/bin/wine-run && chmod 0755 /usr/local/bin/wine-run
USER 65534:65534
WORKDIR /work
