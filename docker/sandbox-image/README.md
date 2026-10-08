# Session sandbox image

Reference container image for `docker` sandbox sessions, published to
`ghcr.io/sandbaseai/sandbase-harness-sandbox` by the
`publish-sandbox-image.yml` workflow on release (or manually via workflow
dispatch, which moves only the `latest` tag).

The contents approximate the published cloud sandbox specification at mid
size so agent sessions get the toolchain that spec promises: Ubuntu 24.04,
`bash` at `/bin/bash`, Python 3.12 (pip, venv), Node.js 22, git (with ssh
transport), jq, ripgrep, vim/nano, diff/patch, tar/zip/unzip, tmux,
make/gcc/g++, ffmpeg, ImageMagick, and SQLite plus PostgreSQL and Redis
servers (installed, not started — sessions launch them on demand).

Deliberately excluded to keep the image near 1–2 GB: TeX Live, LibreOffice,
Playwright/Chromium, PHP/Ruby/Java toolchains, and side-by-side interpreter
versions. A `full` variant can be added later if real workloads need it.

The image is a plain command host: the docker sandbox provider overrides the
entrypoint with `sleep infinity` and execs into the container, so the image
ships no entrypoint and no runtime configuration of its own.

Build locally:

```bash
docker build -t sandbase-harness-sandbox docker/sandbox-image
```
