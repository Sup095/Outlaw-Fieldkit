# FieldKit lens :: fk-warp — Cloudflare WARP with a SOCKS5 door for lens.
# Debian's own WireGuard tools and our two files; nothing fetched from
# anywhere else. lens/setup.sh builds and runs it:
#   docker build -t fieldkit-warp:1 -f lens/warp/Dockerfile .
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends wireguard-tools iproute2 curl ca-certificates jq \
 && rm -rf /var/lib/apt/lists/*
COPY lens/warp/start.sh lens/warp/socks.js /opt/fieldkit/lens/warp/
RUN chmod -R a+rX /opt/fieldkit && chmod 755 /opt/fieldkit/lens/warp/start.sh
EXPOSE 1080
CMD ["/opt/fieldkit/lens/warp/start.sh"]
