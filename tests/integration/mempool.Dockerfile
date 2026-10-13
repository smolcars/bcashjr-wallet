FROM node:24-bookworm AS node
FROM rust:1.84-bookworm AS build
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
ARG REV=4878106c1df7975f9fa14e6d3dd5db956b49e4fb
RUN git clone https://github.com/Retropex/mempool /src && cd /src && git checkout "$REV"
WORKDIR /src/backend
RUN npm ci && npm run build
FROM node:24-bookworm-slim
WORKDIR /backend
COPY --from=build /src/backend/dist ./dist
COPY --from=build /src/backend/node_modules ./node_modules
COPY --from=build /src/backend/rust-gbt ./rust-gbt
COPY mempool-start.cjs /backend/start.cjs
CMD ["node", "start.cjs"]
