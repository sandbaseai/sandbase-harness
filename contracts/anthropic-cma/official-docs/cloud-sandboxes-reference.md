---
title: Cloud sandbox reference
url: https://platform.claude.com/docs/en/managed-agents/cloud-sandboxes-reference
description: Pre-installed packages, databases, and utilities available in cloud sandboxes.
featureMetadata:
  topic:
    title: Managed Agents
    url: https://platform.claude.com/docs/en/managed-agents/overview
  betaHeader: managed-agents-2026-04-01
  zdr:
    eligibility: not-eligible
    note: Sessions are stateful resources; transcripts persist until you delete them. Applies to all Managed Agents sub-features, including Self-hosted sandboxes.
  supportedModels:
    - claude-fable-5-1
    - claude-mythos-5-1
    - claude-fable-5
    - claude-mythos-5
    - claude-mythos-preview
    - claude-opus-5-5
    - claude-opus-5
    - claude-sonnet-5-5
    - claude-sonnet-5
    - claude-haiku-5-5
    - claude-haiku-4-5-20251001
    - claude-opus-4-8
    - claude-opus-4-7
    - claude-opus-4-6
    - claude-sonnet-4-6
    - claude-opus-4-5-20251101
    - claude-sonnet-4-5-20250929
---

Cloud sandboxes run as isolated Linux containers on Anthropic-managed infrastructure. They come pre-installed with a comprehensive set of programming languages, databases, and utilities. The agent can use these immediately without any installation steps.

These specifications apply to `cloud` environments. Self-hosted sandboxes run on your infrastructure with whatever your worker provides.

## Programming languages

| Language | Version                     | Package manager      |
| -------- | --------------------------- | -------------------- |
| Python   | 3.10, 3.11, 3.12, and 3.13  | pip, uv, poetry      |
| Node.js  | 20, 21, and 22 (default)    | npm, yarn, pnpm, bun |
| Go       | 1.24 (default) and 1.25     | Go modules           |
| Rust     | Stable toolchain (rustup)   | cargo                |
| Java     | OpenJDK 21                  | maven, gradle        |
| Ruby     | 3.1, 3.2, and 3.3 (default) | bundler, gem         |
| PHP      | 8.3                         | composer             |
| C/C++    | GCC 13 and Clang            | make, cmake, ninja   |

Common Python data and document libraries, including NumPy, pandas, Matplotlib, openpyxl, python-docx, python-pptx, and pypdf, are installed for the `python3` interpreter.

## Databases

| Database      | Description                                                                   |
| ------------- | ----------------------------------------------------------------------------- |
| PostgreSQL 16 | Server and `psql` client are installed. The server is not running by default. |
| Redis 7       | Server and `redis-cli` are installed. The server is not running by default.   |
| SQLite        | Available through language bindings, such as Python’s `sqlite3` module.       |

## Utilities

### System tools

* `git` - Version control
* `curl`, `wget` - HTTP clients
* `jq`, `yq` - JSON and YAML processing
* `tar`, `zip`, `unzip` - Archive tools
* `tmux` - Terminal multiplexer

### Development tools

* `make`, `cmake` - Build systems
* `docker` - Container management (limited availability)
* `ripgrep` (`rg`) - Fast file search

### Text processing

* `sed`, `awk`, `grep` - Stream editors
* `vim`, `nano` - Text editors
* `diff`, `patch` - File comparison

### Document and media processing

* `ffmpeg` - Audio and video processing
* ImageMagick (`convert`, `identify`) - Image manipulation
* `pandoc` - Document conversion
* LibreOffice (headless) - Office document conversion
* Poppler utilities (`pdftotext`, `pdftoppm`) and `qpdf` - PDF processing
* `tesseract` - Optical character recognition (English language data)
* TeX Live (`pdflatex`, `xelatex`, `latexmk`) - Typesetting

### Browser automation

* Playwright (Python and Node.js) - Browser automation library
* Chromium (`/opt/pw-browsers/chromium`) - Browser used by Playwright, not on `PATH`

The sandbox sets `PLAYWRIGHT_BROWSERS_PATH` to `/opt/pw-browsers`, so the pre-installed Playwright packages find Chromium there without configuration. The Python package is installed for the `python3` interpreter. Use the pre-installed packages rather than installing another Playwright version, which would look for a browser build that is not present. Firefox and WebKit are not installed.

## Sandbox specifications

| Property         | Value                                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operating system | Ubuntu 24.04 LTS                                                                                                                                                                                              |
| Architecture     | x86\_64 (amd64)                                                                                                                                                                                               |
| Memory           | Up to 8 GB                                                                                                                                                                                                    |
| Disk space       | Up to 10 GB                                                                                                                                                                                                   |
| Network          | API-created environments default to [`unrestricted` networking](https://platform.claude.com/docs/en/managed-agents/environments#networking); sandboxes provisioned through Claude Studio default to `limited` |
