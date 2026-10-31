---
title: Memory stores in self-hosted sandboxes
url: https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-memory
description: "Attach memory stores to Claude Managed Agents sessions that run in self-hosted sandboxes: prepare the host, configure sync, and handle read-only stores and conflicts."
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

Sessions on a self-hosted environment attach [memory stores](https://platform.claude.com/docs/en/managed-agents/memory) exactly as sessions on cloud environments do. List them in `resources` (csharp, go: `Resources`) when you create the session, as shown in [Attach a memory store to a session](https://platform.claude.com/docs/en/managed-agents/memory#attach-a-memory-store-to-a-session). A session accepts up to 8 memory stores.

The difference is who materializes the store. On a self-hosted environment your worker, rather than Anthropic’s infrastructure, downloads each store into the sandbox and syncs the agent’s changes back.

## Requirements

* **A worker that mounts memory stores:** Use `ant` CLI 1.33.0 or later, or `EnvironmentWorker` from the Python, TypeScript, or Go SDK.
* **A POSIX filesystem:** Windows hosts are not supported, because the worker requires `O_NOFOLLOW` when it opens memory files. A case-sensitive filesystem is recommended, so that memory paths that differ only in case do not collide. macOS volumes are case-insensitive by default, so such paths collide there.
* **A writable `/mnt/memory` directory:** See [Prepare the host](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-memory#prepare-the-host). On macOS, see [Prepare a macOS host](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-memory#prepare-a-macos-host).
* **The work item’s secret:** If your own code launches the worker, [forward the work item’s secret](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-workers#forward-the-work-items-secret) to it.

<Note>
  Memory stores cannot be attached to sessions on self-hosted environments on [Claude Platform on AWS](https://platform.claude.com/docs/en/build-with-claude/claude-platform-on-aws).

  On [Claude Models on Google Cloud (Anthropic managed)](https://platform.claude.com/docs/en/build-with-claude/claude-models-on-google-cloud/anthropic-managed), memory stores aren’t supported for sessions on self-hosted environments.
</Note>

## Prepare the host

On macOS, skip the next command and follow [Prepare a macOS host](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-memory#prepare-a-macos-host) instead.

Before you start the worker, create the parent directory and make it writable by the user the worker runs as:

```bash
sudo mkdir -p /mnt/memory && sudo chown "$USER" /mnt/memory
```

Do not create the per-store directories yourself. The worker creates each store’s `mount_path` (java, php: `mountPath`; csharp, go: `MountPath`) directory (for example, `/mnt/memory/user-preferences`) when a session starts and removes it when the session ends. If something already exists at that path, the worker refuses to start the session’s work.

In the [sandbox-per-session pattern](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-workers#run-one-sandbox-per-session), the sandbox image needs a writable `/mnt/memory`. You don’t need to bind-mount the memory directories to the host, because the worker uploads their contents to the store before the sandbox exits.

### Prepare a macOS host

On macOS, the root volume is read-only, so `mkdir` can’t create `/mnt`. Instead, create `/System/Volumes/Data/mnt/memory` on the data volume, which is writable. Then add a line to `/etc/synthetic.conf`, so that macOS creates `/mnt` as a symbolic link to `/System/Volumes/Data/mnt`. These steps need administrator rights.

Without this setup, the worker can’t create a store’s directory, so it fails the work item. The session then stays idle with no error event. See [Memory stores fail to mount](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-operations#memory-stores-fail-to-mount).

<Steps>
  <Step title="Create the directory on the data volume">
    Create the `memory` directory and make the worker’s user its owner. `$USER` is your own username. If the worker runs as another user, replace `"$USER"` with that user’s name.

    ```bash
    sudo mkdir -p /System/Volumes/Data/mnt/memory && sudo chown "$USER" /System/Volumes/Data/mnt/memory
    ```

    This location is only one option. If you use another, change the path in the `synthetic.conf` line to match. Anthropic has tested only `/System/Volumes/Data/mnt`.
  </Step>

  <Step title="Add a line to synthetic.conf">
    Run `cat -et /etc/synthetic.conf`, which shows each tab as `^I` and each line end as `$`.

    * If a line reads `mnt^ISystem/Volumes/Data/mnt$`, this step is already done. Go to the next step.
    * If another line starts with `mnt`, stop. Something else on this Mac already defines `/mnt`.
    * If the last line doesn’t end with `$`, run `echo | sudo tee -a /etc/synthetic.conf` to end it.
    * If it prints nothing or reports `No such file or directory`, continue. The `printf` command creates the file if it’s missing.

    Then add the line, unless one of the first two cases applies. Run this command only once, because each run appends another line.

    ```bash
    printf 'mnt\tSystem/Volumes/Data/mnt\n' | sudo tee -a /etc/synthetic.conf
    ```

    The command prints the line that it adds. The line maps the name `mnt` to the directory that holds `memory`. The file needs a tab between the two columns, which `\t` writes.
  </Step>

  <Step title="Create the link">
    Run `apfs.util` with the `-t` option. It creates the link from the line you added, without a restart.

    ```bash
    sudo /System/Library/Filesystems/apfs.fs/Contents/Resources/apfs.util -t
    ```
  </Step>

  <Step title="Check the result">
    List `/mnt` and `/mnt/memory`.

    ```bash
    ls -ld /mnt /mnt/memory
    ```

    The first line ends with `/mnt -> System/Volumes/Data/mnt`. The second line shows the worker’s user as the owner of `/mnt/memory`. You can now start the worker.
  </Step>
</Steps>

Anthropic has tested this setup on macOS 26.7.1 with the `ant` CLI worker.

### Isolate sessions that share a store

Two sessions cannot mount the same store on one host at the same time, because both need the same path. If your sessions attach the same store, run one session for each filesystem. Giving each session [its own sandbox](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-workers#run-one-sandbox-per-session) satisfies this rule.

## How the worker handles memory

When the worker claims a work item whose session has memory stores attached, it:

1. **Downloads each store to its `mount_path` (java, php: `mountPath`; csharp, go: `MountPath`).** This is the same directory under `/mnt/memory/` that cloud sessions use, and the session’s system prompt describes it to the agent. For example, a store named “User Preferences” lands at `/mnt/memory/user-preferences/`.
2. **Opens those directories to the file tools.** The agent works on memories with the same file tools it uses in the working directory.
3. **Reconciles changes after tool calls,** at most once per sync interval (15 seconds by default). Memories that changed in the store are written to disk, and files the agent changed are uploaded to the store.
4. **Runs a final sync when the session ends.** It flushes any uploads still pending for up to 30 seconds, then removes the directories it created.

The memory store on Anthropic’s side remains the source of truth. [Memory versions](https://platform.claude.com/docs/en/managed-agents/memory#audit-memory-changes), redaction, and viewing or editing memories in the Claude Console work as they do for cloud sessions. The agent’s memory reads and writes appear in the [event stream](https://platform.claude.com/docs/en/managed-agents/events-and-streaming) as ordinary tool events.

Because each worker syncs on an interval, a change written in one session becomes visible to another running session only after both have synced. That is typically well under a minute at the default interval. Sessions on cloud sandboxes see each other’s changes almost immediately.

Each store directory contains a marker file named `.anthropic-memory-store` that ties the directory to its store. Leave it in place: the worker does not sync a directory whose marker is missing or altered.

<Warning>
  A worker that is killed rather than stopped runs no teardown, so unsynced edits are lost and the store directories stay behind. See [Stop workers gracefully](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-operations#stop-workers-gracefully).
</Warning>

## Configure sync

Two `EnvironmentWorker` options control memory behavior. Set them wherever you construct the worker, including in a webhook handler. The `ant` CLI worker always uses the defaults.

### Sync interval

`memory_sync_interval` (typescript: `memorySyncIntervalMs`; go: `MemorySyncInterval`) sets how often attached stores reconcile with the server while the session runs.

| Setting                | Value                                               |
| ---------------------- | --------------------------------------------------- |
| Default                | 15 seconds                                          |
| Minimum                | 5 seconds                                           |
| Example (10 seconds)   | `10` (typescript: `10_000`; go: `10 * time.Second`) |
| Disable memory support | `None` (typescript: `null`; go: `-1`)               |

A shorter interval narrows the window in which another session sees stale memories, at the cost of more memory store requests.

Disable memory support only on workers whose sessions attach no memory stores. A disabled worker neither downloads nor syncs stores, so a session with stores attached runs without them even though its system prompt still describes them.

While memory support is enabled, a work item that arrives without a `secret` (csharp, go: `Secret`) for a session with attached stores fails rather than running without memory. See [Memory stores fail to mount](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-operations#memory-stores-fail-to-mount).

### Deletions

`memory_sync_deletions` (typescript: `memorySyncDeletions`; go: `MemorySyncDeletions`) sets whether a file the agent deletes locally is also deleted from the store. Uploads and downloads are unaffected.

| Value                                                                 | Behavior                                                                                                                                         |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `"enabled"` (go: `environments.MemorySyncDeletionsEnabled`) (default) | Deletes the memory from the store once a later sync confirms the file is still gone.                                                             |
| `"log_only"` (go: `environments.MemorySyncDeletionsLogOnly`)          | Runs the same checks but only logs what it would have deleted. Use it to watch what your workers would delete before you trust the enabled mode. |
| `"disabled"` (go: `environments.MemorySyncDeletionsDisabled`)         | Never deletes from the store.                                                                                                                    |

For example, to sync every 10 seconds and only log the deletes the worker would have made:

<CodeGroup exclude="shell, csharp, java, php, ruby">
  ```python Python
  worker = EnvironmentWorker(
      client,
      environment_id=environment_id,
      environment_key=environment_key,
      workdir="/workspace",
      memory_sync_interval=10,  # seconds
      memory_sync_deletions="log_only",
  )
  ```

  ```typescript TypeScript
  const worker = new EnvironmentWorker({
    client,
    environmentId,
    environmentKey,
    workdir: "/workspace",
    memorySyncIntervalMs: 10_000,
    memorySyncDeletions: "log_only"
  });
  ```

  <CodeGroupItem language="C#">
    The C# SDK does not have `EnvironmentWorker`.
  </CodeGroupItem>

  ```go Go
  worker := environments.NewEnvironmentWorker(client, environments.EnvironmentWorkerOptions{
  	EnvironmentID:       environmentID,
  	EnvironmentKey:      environmentKey,
  	Workdir:             "/workspace",
  	MemorySyncInterval:  10 * time.Second,
  	MemorySyncDeletions: environments.MemorySyncDeletionsLogOnly,
  })
  ```

  <CodeGroupItem language="Java">
    The Java SDK does not have `EnvironmentWorker`.
  </CodeGroupItem>

  <CodeGroupItem language="PHP">
    The PHP SDK does not have `EnvironmentWorker`.
  </CodeGroupItem>

  <CodeGroupItem language="Ruby">
    The Ruby SDK does not have `EnvironmentWorker`.
  </CodeGroupItem>
</CodeGroup>

## Read-only stores and conflicts

For a store attached with `access: "read_only"`, the `write` and `edit` tools refuse to change files inside its directory. The worker never uploads anything from it.

Changes made through `bash`, or through a custom tool or MCP server you serve from the sandbox, are not blocked locally. They are never synced to the store, and the next remote change to that memory overwrites them. If the local copy itself must stay unchanged during the session:

* Disable the `bash` tool for that agent, and give it no custom tool that writes to the sandbox’s filesystem.
* Do not mount the store path read-only. The worker itself must create the directory and write the downloaded memories into it.

Conflicts resolve in favor of the store. Suppose the agent changes a memory file that also changed in the store since the session last synced it. At the next sync, the worker keeps the store’s version, overwrites the local file with it, and logs a warning. The `write` and `edit` tools themselves succeed and no error reaches the agent. If the agent’s change still applies, it can re-read the file after the sync and make the change again.

## Troubleshooting

See [Memory stores fail to mount](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-operations#memory-stores-fail-to-mount) for the worker’s log messages and their fixes.
