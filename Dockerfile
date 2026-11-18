# Shared runtime image for the Limecraft monorepo.
#
# Nothing from the repo is baked into the image. docker-compose mounts the
# whole checkout at /repo and each service runs its entry point from there,
# using the node_modules installed on the HOST at the monorepo root. That way
# module resolution inside the container is identical to the host: no
# node_modules bind-mount tricks, no per-package mount gymnastics.
#
# This image only supplies the runtime the code needs:
#   - Node 26 (runs TypeScript directly via native type stripping)
#   - Chromium + swiftshader for headless WebGL screenshots
#   - libcairo/libpango/etc. for the canvas native module

FROM node:26-trixie

RUN apt-get update && apt-get install -y --no-install-recommends chromium \
    libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libjpeg62-turbo libgif7 librsvg2-2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# Default entry point; compose overrides `command` per service.
CMD ["node", "packages/bot/src/index.ts"]
