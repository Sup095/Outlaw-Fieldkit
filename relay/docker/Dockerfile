# =============================================================
# FieldKit relay — container image with a real browser in it
#
# The streamed browser (§14.11) needs a Chromium that the relay can
# launch. The container has no shell you can type into and no root,
# so Chromium cannot be installed at runtime — it has to be in the
# image. That is what this file is for.
#
#   node tools/make-deploy.js          (assembles deploy/bastion1/)
#   docker build -t fieldkit-relay:1 deploy/bastion1
#
# Built ON Bastion 1, where Pterodactyl runs, so no registry is
# needed: Wings tries to pull fieldkit-relay:1, fails, finds the local
# image with that tag and uses it. See BROWSER.md.
#
# WHY NOT A PUPPETEER IMAGE. They exist and they are large, because
# they carry a Node toolchain, a bundled Chromium and the whole
# node_modules tree that drives it. The relay has no dependencies
# and speaks CDP itself, so what is actually needed is Node, a
# system Chromium, and fonts.
#
# FONTS ARE NOT OPTIONAL. A headless Chromium with no fonts renders
# every page as boxes, which looks exactly like a broken screencast
# and is the first thing to check if the stream comes back blank.
# =============================================================

FROM ghcr.io/parkervcp/yolks:nodejs_22

USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      # Chromium's own library closure. The metapackage usually pulls
      # these, but naming them means a missing one fails the BUILD
      # rather than showing up as "chromium exited during startup" on
      # a server somebody else is waiting on.
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
      libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
      libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
      libatspi2.0-0 libx11-6 libxcb1 libxext6 \
      # Fonts. Without these every page is a grid of empty boxes.
      fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
      fonts-noto-cjk \
      ca-certificates \
      # The browser as video (video-encoder.js). The base image has it
      # today; named here so that never quietly changes.
      ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# Where browser-engine.js looks first. The Debian package installs
# to /usr/bin/chromium already; the symlink covers images that put
# it elsewhere so config.json rarely needs the path spelled out.
RUN ln -sf "$(command -v chromium || command -v chromium-browser)" /usr/bin/chromium || true

# /dev/shm is 64 MB in a default container and Chromium will try to
# put compositor surfaces in it. The relay already passes
# --disable-dev-shm-usage, which sends them to /tmp instead, so /tmp
# is where the space needs to be.
ENV TMPDIR=/tmp

# Copied and cleaned as root, BEFORE dropping to the container user.
# The sed strips carriage returns: this file is edited on Windows, and
# one CRLF checkout turns every line into a "command not found" and the
# server into one that will not start. .gitattributes pins it to LF as
# well; this is the copy of that rule that cannot be forgotten.
COPY ./entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod 0755 /entrypoint.sh

# THE RELAY ITSELF, baked in (2026-10-26). Before this, every update
# meant uploading a dozen files through the panel. Now the code lives
# here, read-only, and the server folder holds only what belongs to
# this deployment: config.json, and the data/ the relay writes.
# Updating is rebuilding this image and pressing Restart.
#
# Built from deploy/bastion1/ (node tools/make-deploy.js), which holds
# this file, entrypoint.sh, and the relay's code without config.json.
COPY relay/ /opt/fieldkit/relay/
RUN find /opt/fieldkit/relay -name '*.js' -exec sed -i 's/\r$//' {} + \
 && cd /opt/fieldkit/relay \
 && node fetch-cloudflared.js \
 && node fetch-tailscale.js \
 && chmod 0755 cloudflared-bin/* tailscale-bin/* \
 && rm -f config.json config.local.json release-key.json \
 && chown -R root:root /opt/fieldkit && chmod -R a+rX /opt/fieldkit
ENV FK_CONFIG=/home/container/config.json

USER container
ENV USER=container HOME=/home/container
WORKDIR /home/container

CMD ["/bin/bash", "/entrypoint.sh"]
