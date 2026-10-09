# Skills

Skills are reusable instruction packages that agents can reference by id. A
skill package contains a `SKILL.md` file with YAML frontmatter and Markdown
instructions, plus optional supporting files.

## Package Structure

A skill upload must contain one top-level directory. `SKILL.md` must be at the
root of that directory.

```text
code-review-assistant/
+-- SKILL.md
+-- references/
    +-- checklist.md
```

Valid upload formats:

- A `.zip` file containing the top-level directory
- A `.skill` file with the same zip structure
- A directory upload from the Dashboard
- A JSON or multipart API upload where all paths share the same top-level
  directory

The total upload size limit is 8 MB.

## SKILL.md

`SKILL.md` must start with YAML frontmatter. `name` and `description` are
required. The optional standard `compatibility` field describes concrete host,
system-package, network, or runtime requirements and is limited to 500
characters.

```markdown
---
name: code-review-assistant
description: Reviews code changes for correctness, security, and maintainability.
compatibility: Requires git and access to the source repository.
---

# Code Review Assistant

Use this skill when reviewing source code, pull requests, or patches.

Focus on:

- Runtime correctness
- Security risks
- Data loss risks
- Missing tests
- API compatibility
- Operational behavior

Return findings first, ordered by severity. Include file and line references
when available.
```

The frontmatter `name` is the stable skill name. The upload API creates a
random public id with the `skill_` prefix. `display_title` is an optional human
label and is not injected into the model prompt.

## Create A Skill Package

```bash
mkdir -p code-review-assistant/references
cat > code-review-assistant/SKILL.md <<'EOF'
---
name: code-review-assistant
description: Reviews code changes for correctness, security, and maintainability.
---

# Code Review Assistant

Review code changes and report actionable findings first.
EOF

zip -r code-review-assistant.zip code-review-assistant
```

The archive must include the directory name. Do not zip only the files inside
the directory.

## Upload Through The Dashboard

1. Open `http://127.0.0.1:3000/dashboard`.
2. Go to `Skills`.
3. Click `Create skill`.
4. Drop a `.zip`, `.skill`, or directory.
5. Click `Continue`.

If validation succeeds, the skill is created and the list is refreshed. If
validation fails, the Dashboard shows the first package error.

## Upload Through The API

Multipart upload:

```bash
curl -X POST http://127.0.0.1:3000/v1/skills \
  -F "files=@code-review-assistant.zip"
```

Optional display title:

```bash
curl -X POST http://127.0.0.1:3000/v1/skills \
  -F "display_title=Code Review Assistant" \
  -F "files=@code-review-assistant.zip"
```

JSON upload:

```bash
curl -X POST http://127.0.0.1:3000/v1/skills \
  -H "Content-Type: application/json" \
  -d '{
    "files": [
      {
        "path": "code-review-assistant/SKILL.md",
        "content": "---\nname: code-review-assistant\ndescription: Reviews code changes.\n---\n\n# Instructions\n\nReview code carefully."
      }
    ]
  }'
```

Response:

```json
{
  "id": "skill_b7dVwlt3PrkqThW8cS-AQ9pS",
  "created_at": "2026-07-12T00:00:00.000Z",
  "display_title": "code-review-assistant",
  "latest_version": "skv_Zx9Qp2mRtVw7kBnLcYsA4dEf",
  "latest_version_id": "skv_Zx9Qp2mRtVw7kBnLcYsA4dEf",
  "source": "custom",
  "type": "skill",
  "updated_at": "2026-07-12T00:00:00.000Z",
  "name": "code-review-assistant",
  "description": "Reviews code changes.",
  "compatibility": "Requires git and access to the source repository."
}
```

The API and Console expose `compatibility` before an operator assigns the Skill
to an agent. SandBase Harness treats this field as untrusted descriptive text;
it does not install packages, grant permissions, or enable network access from
its contents.

## List And Retrieve Skills

```bash
curl http://127.0.0.1:3000/v1/skills
curl http://127.0.0.1:3000/v1/skills?source=custom
curl http://127.0.0.1:3000/v1/skills/SKILL_ID
```

Skill sources:

- `custom`: uploaded by the workspace user
- `anthropic`: built-in catalog entry

## Use A Skill In An Agent

Add the generated `skill_...` id to the agent YAML:

```yaml
name: assistant
model: gpt-4o
system: |
  You are a helpful assistant.
skills:
  - type: custom
    skill_id: skill_b7dVwlt3PrkqThW8cS-AQ9pS
```

Restart or reload the runtime:

```bash
managed-agents reload
```

When the agent runs, the runtime injects the referenced skill instructions into
the system context.

An agent reference may pin a specific version:

```yaml
skills:
  - type: custom
    skill_id: skill_b7dVwlt3PrkqThW8cS-AQ9pS
    version: skv_Zx9Qp2mRtVw7kBnLcYsA4dEf
```

Without `version` (or with `version: latest`) the newest uploaded package is
mounted. A pinned reference mounts that version's stored package; a pin that
names a deleted or unknown version mounts no skill files at all.

When a session sandbox is provisioned, the assigned skill packages are also
written into it under `skills/<name>/` relative to the session workdir —
`/workspace/skills/<name>/` inside a docker container. Packaged scripts keep
their execute bit where the backend supports it, so a skill that ships a
`scripts/` directory can be run with the shell tool. The system prompt names
these roots so the agent knows the files exist beyond the inlined
instructions. A self-hosted worker materializes the same layout under its own
workdir.

## Skill Versions

Every upload that creates a skill also creates its first version, and each
`POST /v1/skills/{skill_id}/versions` adds another with a fresh `skv_...` id.
The skill's `latest_version` (and its `latest_version_id` alias) always points
at the newest version.

```bash
# Upload a new version (same package format as POST /v1/skills)
curl -X POST http://127.0.0.1:3000/v1/skills/SKILL_ID/versions \
  -F "files=@code-review-assistant-v2.zip"

# List versions, newest first
curl http://127.0.0.1:3000/v1/skills/SKILL_ID/versions

# Retrieve one version's metadata
curl http://127.0.0.1:3000/v1/skills/SKILL_ID/versions/VERSION_ID

# Download one version's package as a zip archive (`latest` addresses the
# current version without naming its id)
curl -OJ http://127.0.0.1:3000/v1/skills/SKILL_ID/versions/VERSION_ID/content

# Delete one version
curl -X DELETE http://127.0.0.1:3000/v1/skills/SKILL_ID/versions/VERSION_ID
```

Rules:

- A version upload must keep the skill's frontmatter `name`; a package naming
  a different skill is refused with `409`.
- Deleting the latest version repoints `latest` at the newest survivor.
- Deleting the only remaining version is refused with `409`; a skill always
  keeps at least one version.
- Deletion returns `{id, type: "skill_version_deleted"}` and removes the
  version's stored package.
- Built-in `anthropic` skills expose their version metadata read-only;
  uploads, deletions, and content downloads are refused.
- The content route accepts the literal `latest` in place of a version id and
  serves the version `latest_version` currently points at — the spelling a
  caller holding an unpinned reference (a self-hosted worker downloading the
  session's packages) uses. A session work token may download only the skill
  versions its session's agent assigns; every other skill or version is
  refused.

## Delete A Skill

Custom skills can be deleted:

```bash
curl -X DELETE http://127.0.0.1:3000/v1/skills/SKILL_ID
```

Built-in catalog skills cannot be deleted.

## Validation Rules

Uploads are rejected when:

- The package is larger than 8 MB.
- Files are not under one top-level directory.
- The top-level directory name contains unsupported characters.
- `SKILL.md` is missing from the top-level directory root.
- `SKILL.md` does not start with YAML frontmatter.
- Frontmatter is missing `name` or `description`.
- A custom skill with the same frontmatter `name` already exists.
- A package directory with the same top-level folder already exists.

Ignored archive entries:

- `__MACOSX/`
- `.DS_Store`

## Recommended Practices

- Keep each skill focused on one repeatable capability.
- Put detailed examples or checklists in supporting files.
- Keep the `description` short and trigger-oriented.
- Avoid secrets, API keys, or private data in skill packages.
- Version skill packages through source control before uploading.
