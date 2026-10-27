# FieldKit RUNNER :: the box a job runs in (RUNNER_PLAN.md §6)
#
# Deliberately small and deliberately boring. It holds the interpreters
# RUNNER offers and nothing a job could use to do anything else: no
# compiler, no package manager cache, no network tools, no sudo.
#
# The image is NOT the sandbox. The sandbox is the list of flags in
# runnerd/sandbox.js (no network, read-only, no capabilities, an
# unprivileged user, hard limits) plus gVisor on Bastion 2. This is
# only what is inside it.
FROM debian:trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3-minimal libpython3-stdlib nodejs bash coreutils ca-certificates \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* \
 && rm -f /usr/bin/apt* /usr/bin/dpkg* 2>/dev/null || true

# Jobs run as 65534 ("nobody"), set by runnerd, never as root. This is
# the default as well, so running the image by hand is not root either.
USER 65534:65534
WORKDIR /work
CMD ["bash", "-c", "echo 'this image is run by runnerd, not by hand'"]
