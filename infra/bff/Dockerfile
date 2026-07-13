# poisonflix-bff — zero-dependency Node service. No `npm install`, no network at
# build time: the entire app is a single ESM file that uses only Node built-ins.
FROM node:22-alpine
WORKDIR /app
COPY server.mjs ./
USER node
EXPOSE 8787
CMD ["node", "server.mjs"]
