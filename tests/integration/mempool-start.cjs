// Real mempool backend, with electrs address indexing and node RPC validation.
const fs = require("node:fs");
fs.writeFileSync(
  "/backend/mempool-config.json",
  JSON.stringify({
    MEMPOOL: {
      NETWORK: "regtest",
      BACKEND: "electrum",
      HTTP_PORT: 8999,
      API_URL_PREFIX: "/api/v1/",
      POLL_RATE_MS: 500,
      CACHE_ENABLED: false,
      INDEXING_BLOCKS_AMOUNT: 0,
      AUTOMATIC_POOLS_UPDATE: false,
      // Skip the initial pool metadata download as well as recurring updates.
      POOLS_UPDATE_DELAY: Number.MAX_SAFE_INTEGER,
      RUST_GBT: false,
      EXTERNAL_ASSETS: [],
      PRICE_UPDATES_PER_HOUR: 0,
    },
    CORE_RPC: {
      HOST: process.env.NODE_HOST,
      PORT: 18443,
      USERNAME: "regtest",
      PASSWORD: "regtest",
    },
    ELECTRUM: { HOST: process.env.ELECTRS_HOST, PORT: 50001, TLS_ENABLED: false },
    DATABASE: { ENABLED: false },
    REDIS: { ENABLED: false },
    STATISTICS: { ENABLED: false },
    LIGHTNING: { ENABLED: false },
    FIAT_PRICE: { ENABLED: false },
    MAXMIND: { ENABLED: false },
  }),
);
process.env.MEMPOOL_CONFIG_FILE = "/backend/mempool-config.json";
require("./dist/index.js");
