# FieldKit lens: the image that runs on the rented server.
# Built from deploy/lens/ (tools/make-lens.js stages relay/ and lens/ there):
#   docker build -t fieldkit-lens:1 .
#
# Two stages. The first fetches the client's files at the exact versions
# in lens/vendor/package-lock.json (npm ci refuses a hash that does not
# match); the second is node, our code and those files, nothing else.

FROM node:22-bookworm-slim AS vendor
WORKDIR /v
COPY lens/vendor/package.json lens/vendor/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM node:22-bookworm-slim
WORKDIR /opt/fieldkit
COPY relay/ relay/
COPY lens/ lens/
# The block list fixed at build (StevenBlack, MIT), so a lens server that
# has not yet fetched the live lists still blocks (relay/blocklist.js).
RUN cd relay && node fetch-adblock.js && cd .. && chown -R root:root /opt/fieldkit && chmod -R a+rX /opt/fieldkit
COPY --from=vendor /v/node_modules/@mercuryworkshop/scramjet/dist/ lens/client/v/scramjet-1.1.0-fk1/
COPY --from=vendor /v/node_modules/@mercuryworkshop/bare-mux/dist/ lens/client/v/bare-mux-2.1.9/
COPY --from=vendor /v/node_modules/@mercuryworkshop/libcurl-transport/dist/ lens/client/v/libcurl-transport-1.5.2/
# One fix to Scramjet, or pages whose scripts set a cookie stay white
# (lens/patch-scramjet.js says why). The build stops if it does not fit.
# Hence "-fk1" in its folder: browsers keep v/ for 30 days, so a changed
# file needs a new name; the next fix is -fk2.
RUN node lens/patch-scramjet.js lens/client/v/scramjet-1.1.0-fk1/scramjet.all.js
ENV NODE_ENV=production FK_LENS_CONFIG=/etc/lens/config.json
USER node
EXPOSE 8080
CMD ["node", "/opt/fieldkit/lens/server.js"]
