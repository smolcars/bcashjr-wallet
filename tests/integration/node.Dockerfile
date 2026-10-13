FROM debian:bookworm-slim
ARG TARGETARCH
ARG NODE=core
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$NODE/$TARGETARCH" in \
      core/amd64) arch=x86_64; checksum=a681e4f6ce524c338a105f214613605bac6c33d58c31dc5135bbc02bc458bb6c ;; \
      core/arm64) arch=aarch64; checksum=7922ac99363dd28f79e57ef7098581fd48ebd1119b412b07e73b1fd19fd0443f ;; \
      knots/amd64) arch=x86_64; checksum=0d0b435ae67dd38d150c048a388be821ad0ca8b46d6dcace5c34d4ba2977801b ;; \
      knots/arm64) arch=aarch64; checksum=1dd4b71eb4fdfb3900e0d944baea18e407267f6a31c13518d63fbc17902deff5 ;; \
      *) exit 1 ;; \
    esac; \
    if [ "$NODE" = core ]; then version=29.0; base=https://bitcoincore.org/bin/bitcoin-core-29.0; \
    else version=29.4.1.knots20260508; base=https://bitcoinknots.org/files/29.x/29.4.1.knots20260508; fi; \
    curl -fL "$base/bitcoin-$version-$arch-linux-gnu.tar.gz" -o /tmp/node.tar.gz; \
    echo "$checksum  /tmp/node.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/node.tar.gz -C /tmp; \
    install /tmp/bitcoin-*/bin/bitcoind /tmp/bitcoin-*/bin/bitcoin-cli /usr/local/bin/; \
    rm -rf /tmp/bitcoin-* /tmp/node.tar.gz
RUN mkdir /data
ENTRYPOINT ["bitcoind", "-datadir=/data", "-regtest", "-server", "-mocktime=1791820800", "-txindex", "-listen=1", "-connect=0", "-dnsseed=0", "-discover=0", "-rpcbind=0.0.0.0", "-rpcallowip=0.0.0.0/0", "-rpcuser=regtest", "-rpcpassword=regtest", "-fallbackfee=0.00001", "-acceptnonstdtxn=0"]
