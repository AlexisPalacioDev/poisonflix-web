# poisonflix-cast-bridge — zero-dependency Node service, same shape as ../bff:
# no `npm install` and no network at build time, just ESM files that use nothing
# but Node built-ins (server.mjs entrypoint + discovery.mjs + one adapter per
# protocol under adapters/). The tests stay out of the image via .dockerignore.
FROM node:22-alpine
WORKDIR /app
COPY *.mjs ./
COPY adapters/ ./adapters/
# The webOS client-key lands in CAST_DATA_DIR. Creating and chowning it here
# makes the image correct on its own, but it does NOT save a bind mount: Docker
# creates a missing host directory as root:root and that ownership wins over
# this line. The startup probe in server.mjs is what catches that case, because
# the symptom otherwise is only "the television asks for permission every time".
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8791
CMD ["node", "server.mjs"]
