# syntax=docker/dockerfile:1

# Reference session-sandbox image.
#
# Approximates the published cloud sandbox specification (Ubuntu 24.04 base,
# bash at /bin/bash, mainstream language toolchains, archive/text/media
# utilities, databases installed but not running) at mid size: TeX Live,
# LibreOffice, Playwright/Chromium, PHP/Ruby/Java, and multi-version
# interpreters are deliberately left out. The image is a plain command host —
# the docker sandbox provider overrides the entrypoint with `sleep infinity`
# and execs into the container — so it ships no entrypoint of its own.

FROM ubuntu:24.04

ARG NODE_VERSION=22.14.0

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    # Shell and base system utilities
    bash ca-certificates curl wget unzip xz-utils \
    # Version control (ssh transport for private clones)
    git openssh-client \
    # JSON/YAML and fast search
    jq ripgrep \
    # Text and file comparison
    vim nano diffutils patch \
    # Terminal multiplexer and build tools
    tmux make gcc g++ \
    # Archive handling
    tar zip \
    # Media processing
    ffmpeg imagemagick \
    # Python 3.12 (Ubuntu 24.04 default) with pip and venv
    python3 python3-pip python3-venv \
    # Databases: installed, not running — sessions start them on demand
    sqlite3 postgresql redis-server \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22 LTS from the official tarball, checksum-verified against the
# release's own SHASUMS256.txt rather than a hardcoded digest.
RUN ARCH=$(dpkg --print-architecture) \
    && case "$ARCH" in amd64) NODE_ARCH=x64 ;; arm64) NODE_ARCH=arm64 ;; *) echo "unsupported arch: $ARCH" >&2; exit 1 ;; esac \
    && cd /tmp \
    && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
    && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
    && grep "node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" SHASUMS256.txt | sha256sum -c - \
    && tar -xJf "node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" -C /usr/local --strip-components=1 \
    && rm -f node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz SHASUMS256.txt

WORKDIR /workspace
VOLUME /workspace

LABEL org.opencontainers.image.title="SandBase Harness session sandbox" \
      org.opencontainers.image.description="Reference tool-execution environment for sandboxed agent sessions, aligned with the published cloud sandbox specification at mid size" \
      org.opencontainers.image.source="https://github.com/sandbaseai/sandbase-harness" \
      org.opencontainers.image.licenses="Apache-2.0"
