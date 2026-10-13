FROM rust:1.85-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends clang cmake librocksdb-dev && rm -rf /var/lib/apt/lists/*
ARG REV=3c812c618230d967f32b3358f6e0615ff123a9aa
RUN git clone https://github.com/jasonsopko/electrs /src && cd /src && git checkout "$REV"
WORKDIR /src
ENV ROCKSDB_INCLUDE_DIR=/usr/include
RUN ROCKSDB_LIB_DIR=/usr/lib/$(gcc -dumpmachine) cargo build --locked --release
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends librocksdb7.8 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/electrs /usr/local/bin/
COPY electrs.toml /etc/electrs.toml
ENTRYPOINT ["electrs", "--network=regtest", "--conf=/etc/electrs.toml", "--wait-duration-secs=1", "--electrum-rpc-addr=0.0.0.0:50001", "--db-dir=/data", "--daemon-dir=/tmp", "--log-filters=INFO"]
