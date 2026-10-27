#!/bin/bash
# FieldKit relay entrypoint for Pterodactyl.
#
# Deliberately thin. Everything that has to happen before the relay
# serves — setting the executable bit on the tunnel binaries, reading
# config.json, deciding whether to start cloudflared — already happens
# in start.js, which is where it can be tested. Duplicating any of it
# here would be a second place to keep in step.

cd /home/container || exit 1

# Pterodactyl substitutes the startup command from the egg. Without
# this line the panel's Startup field does nothing, which is a
# confusing half hour for whoever inherits the server.
MODIFIED_STARTUP=$(echo -e "${STARTUP}" | sed -e 's/{{/${/g' -e 's/}}/}/g')
echo ":/home/container$ ${MODIFIED_STARTUP}"

# One line that saves a support round trip. If the streamed browser
# is switched on and there is no browser in the image, the relay logs
# it too — but by then it looks like a relay problem rather than an
# image problem.
if command -v chromium >/dev/null 2>&1; then
  echo "[entrypoint] chromium: $(chromium --version 2>/dev/null || echo present)"
else
  echo "[entrypoint] chromium: NOT PRESENT — the streamed browser will fall back to the proxy."
fi

# shellcheck disable=SC2086
eval ${MODIFIED_STARTUP}
