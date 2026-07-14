# poisonflix-bff — zero-dependency Node service. No `npm install`, no network at
# build time: a few ESM files that use only Node built-ins (server.mjs entrypoint
# + invites.mjs / identity.mjs for self-service registration).
FROM node:22-alpine
WORKDIR /app
COPY *.mjs ./
USER node
EXPOSE 8787
CMD ["node", "server.mjs"]
