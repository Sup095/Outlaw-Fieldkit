# FieldKit runnerd :: the daemon's own image
#
# runnerd is the trusted half of RUNNER. It starts the job containers,
# so it is given the host's Docker socket, and anything holding that
# socket is as powerful as root on the machine. That is why runnerd is
# small, has no dependencies, and never executes anything a user sent:
# it only tells Docker to. The jobs themselves get none of this.
#
# Built from the bundle's root, so that it can take the relay's
# WebSocket file as well:   docker compose build
FROM docker:27-cli AS dockercli

FROM node:22-slim
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY relay/ws.js relay/guard.js /app/relay/
COPY runnerd/server.js runnerd/ticket.js runnerd/limits.js runnerd/sandbox.js runnerd/store.js runnerd/admin.js runnerd/save.js runnerd/egress.js runnerd/power.js runnerd/access.js runnerd/zip.js /app/runnerd/
ENV NODE_ENV=production FK_RUNNER_CONFIG=/etc/fieldkit/runnerd.json
EXPOSE 25580
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:25580/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "/app/runnerd/server.js"]
