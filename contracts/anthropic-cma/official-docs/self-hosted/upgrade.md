---
title: Upgrade self-hosted Claude Managed Agents
url: https://platform.claude.com/docs/en/managed-agents/self-hosted/upgrade
description: Upgrade a self-hosted Claude Managed Agents deployment on Kubernetes or Docker Compose, and roll back if the new release doesn't work.
---

<Note>
  To request access to self-hosted Claude Managed Agents, contact your Anthropic account team. If you belong to a Claude Console organization that already has access, [sign in to the Claude Console](https://platform.claude.com) and switch to that organization. Then reload this page.
</Note>

This page shows how to upgrade a deployment on Kubernetes or Docker Compose, and how to roll back. On Kubernetes, the downtime depends on how far the upgrade goes:

| Upgrade                                                                        | Back up the database first              | Downtime on Kubernetes                                                |
| ------------------------------------------------------------------------------ | --------------------------------------- | --------------------------------------------------------------------- |
| Patch: only the third number changes                                           | No. The database schema stays the same. | None                                                                  |
| Minor: the second number goes up by one, such as `1.2.0` to `1.3.0`            | Yes. The schema changes.                | None, unless a `CHANGELOG.md` section says that the servers must stop |
| Skips a minor release, such as `1.1.0` to `1.3.0`, or changes the first number | Yes. The schema changes.                | From when you stop the old servers until the new ones are ready       |

A Docker Compose stack is down while it restarts, for every kind of upgrade.

## Before you upgrade

Read the new release’s section of `CHANGELOG.md`, at the top of the extracted archive. It starts with the upgrade steps that are specific to that release. If you skip releases, follow every section newer than your version, oldest first.

Then go through [Settings and paths to check](https://platform.claude.com/docs/en/managed-agents/self-hosted/upgrade#settings-and-paths-to-check).

A minor or major upgrade includes a database backup. The dump holds every conversation in plain text, so the commands on this page encrypt it with the [age encryption tool](https://age-encryption.org). Create a key pair once, and keep the private key, `cma-backup.agekey`, away from the backups:

```bash
age-keygen -o cma-backup.agekey
age-keygen -y cma-backup.agekey > cma-backup.agepub
```

## Upgrade on Kubernetes

The `kubectl` commands on this page read the name of the server’s Deployment from a shell variable. Run these two lines in each terminal where you run the commands. The first line looks up the name, and the second prints it:

```bash
server=$(kubectl -n cma-server get deployment -l anthropic.com/role=server -o jsonpath='{.items[*].metadata.name}')
echo "$server"
```

If the second line prints `cma-server`, go on. If it prints another name, read [the names of your objects](https://platform.claude.com/docs/en/managed-agents/self-hosted/upgrade#object-names) before you upgrade. If it prints nothing, check that `kubectl` points at the right cluster, and run the two lines again.

<Steps>
  <Step title="Build and push the new images">
    Extract the new archive. Build and push its three images under the new version, as in [Build and push the images](https://platform.claude.com/docs/en/managed-agents/self-hosted/kubernetes#build-and-push-the-images). If you run the [egress gateway](https://platform.claude.com/docs/en/managed-agents/self-hosted/agent-identity#environment-variable-credentials), build and push its image too.

    If you build a sandbox image of your own, rebuild and push it too, under the new version. Compare its Dockerfile with `kubernetes/sandbox/Dockerfile` in the new archive, and see [what an image of your own needs](https://platform.claude.com/docs/en/managed-agents/self-hosted/call-the-api#what-an-image-of-your-own-needs).
  </Step>

  <Step title="Set the new version in your values files">
    If a values file sets `image.tag`, change it to the new version.
  </Step>

  <Step title="Stop every server, if the upgrade needs it">
    Do this step only in these cases:

    * A server that you run is more than one minor release behind the new release.
    * The first number, the major version, goes up.
    * A section of `CHANGELOG.md` newer than the release that you run says that the servers must stop.

    From this step until the new servers are ready, clients can’t reach the deployment, so plan a maintenance window.

    ```bash
    kubectl -n cma-server scale deployment/$server --replicas=0
    kubectl -n cma-server wait --for=delete pod -l anthropic.com/role=server --timeout=90s
    ```
  </Step>

  <Step title="Back up the database">
    Do this before a minor or major upgrade, or if you stopped the servers. If the old release can’t run on the changed schema, this backup is the only way back.

    Use `pg_dump` from the same major version of PostgreSQL as your database server. For `<role>` and `<database>`, use the `user` and `dbname` values of `database.url` in `cma-server-values.yaml`. `pg_dump` prompts for the role’s password.

    ```bash
    set -o pipefail
    PGSSLMODE=require pg_dump -h <database-host> -U <role> -d <database> -Fc \
      | age -r "$(cat cma-backup.agepub)" -o cma_server-<old-version>.dump.age
    ```

    If either command prints an error, the file it leaves behind is not a backup. Fix the cause and run the command again before you go on.

    If the servers are running, the backup holds only what clients wrote before the dump began.
  </Step>

  <Step title="Upgrade the server, then the sandboxes">
    Run these commands from the new archive’s top directory, with the values files from your install:

    ```bash
    helm upgrade cma-server kubernetes/server/chart --namespace cma-server -f cma-server-values.yaml --wait
    helm upgrade cma kubernetes/chart --namespace cma -f cma-values.yaml --wait
    ```

    If you run more than one environment, run the second command for each sandbox release, with that release’s name, namespace, and values file.

    If you stopped the servers, the first command migrates the schema, restores the server count, and returns once the new servers are ready.
  </Step>
</Steps>

With the servers running, Helm starts each new server before it stops an old one, so the number of ready servers never drops. In a minor upgrade, the first command changes the schema while the old servers keep serving, and then it replaces them. An open event stream on a server that is being replaced ends cleanly, so a client that follows a stream has to reconnect.

If a command fails, see [If the upgrade fails](https://platform.claude.com/docs/en/managed-agents/self-hosted/upgrade#if-the-upgrade-fails).

## Upgrade on Docker Compose

The steps are the same for every kind of upgrade. Run each `docker compose` command from a release’s Compose directory, which is the directory that holds `docker-compose.yml`. In the extracted archive, that directory is `compose`. Use a terminal where `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, and `ANTHROPIC_AUTH_TOKEN` aren’t set, because Compose passes a shell’s values of those variables to the server.

<Steps>
  <Step title="Back up the database">
    Do this before a minor or major upgrade, from the old release’s Compose directory:

    ```bash
    set -o pipefail
    docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
      | age -r "$(cat cma-backup.agepub)" -o cma_server-<old-version>.dump.age
    ```

    In the command, leave `$POSTGRES_USER` and `$POSTGRES_DB` as they are. The text in single quotes runs inside the `postgres` container, which holds the names of its role and its database in those variables.

    The stack keeps serving during the backup, so the dump lacks whatever clients write after the dump begins. If either command prints an error, the file it leaves behind is not a backup. Fix the cause and run the command again before you go on.
  </Step>

  <Step title="Extract the new archive">
    Put the new archive in a directory where the new release can stay, such as the old release’s parent directory. The commands extract the archive there, and the new stack runs from the extracted files.

    If your umask is stricter than `022`, run `umask 022` first. Then run this from the old release’s Compose directory. In place of `<directory>`, write the full path of the directory that holds the new archive. In place of `<archive>`, write the archive’s name without `.tar.gz`.

    ```bash
    releases="<directory>"
    tar -xzf "$releases/<archive>.tar.gz" -C "$releases" && cp .env compose.config.yaml "$releases/<archive>/compose/"
    ```

    The second line also copies your `.env` and `compose.config.yaml` into the extracted `compose` directory. The old stack keeps running through both lines. If a line prints an error, fix the cause and run both lines again.
  </Step>

  <Step title="Repeat your other changes">
    Only `.env` and `compose.config.yaml` carry over. Make your other changes again in the new release’s Compose directory:

    * **A file that you added:** Copy it.
    * **A shipped file that you edited:** Make the same edit in the new release’s copy. Don’t copy the old file over it, because that undoes the release’s changes to the file.
    * **Agent identity:** Copy the `agent-identity` directory with `cp -a`, using `sudo` if root owns it, and edit the `volumes:` block of `docker-compose.yml` again.
    * **A Compose file of your own:** Copy it, and check its relative paths.

    Then make the Docker Compose changes in [Settings and paths to check](https://platform.claude.com/docs/en/managed-agents/self-hosted/upgrade#settings-and-paths-to-check).
  </Step>

  <Step title="Stop the old stack and start the new one">
    Run these lines in the terminal where you extracted the archive, because they use its `$releases` variable. Stay in the old release’s Compose directory, and write the same name in place of `<archive>`. If you exported `COMPOSE_FILE` for the old stack, export the same value first.

    ```bash
    ls "$releases/<archive>/compose/.env" && docker compose down
    cd "$releases/<archive>/compose" && docker compose up --build -d
    ```

    The first line stops the old stack only if the new release’s `.env` is in place. `docker compose down` keeps the database. Don’t add `-v`, which deletes it. The new stack picks up the database, and its `migrate` container updates the schema before the server starts.
  </Step>
</Steps>

If a command fails, see [If the upgrade fails](https://platform.claude.com/docs/en/managed-agents/self-hosted/upgrade#if-the-upgrade-fails).

## If the upgrade fails

Before you roll back, find the cause in the log:

* **Kubernetes:** If the migration Job fails, `helm upgrade` waits a few minutes while the Job retries, and then it fails. During that wait, run `kubectl -n cma-server logs job/$server-migrate` in a second terminal, with `$server` set as in [Upgrade on Kubernetes](https://platform.claude.com/docs/en/managed-agents/self-hosted/upgrade#upgrade-on-kubernetes). Kubernetes deletes the log when the Job stops retrying. If you missed it, run `helm upgrade` again, which starts the Job again.
* **Docker Compose:** The output of `docker compose up --build -d` might not show the reason. Run `docker compose logs` to find it.

| What the log shows                                                                                             | What it means                                                                                                                   | What to do                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A line that contains `refusing to migrate: servers of another release are still running against this database` | Some upgrades need every server stopped first, and a server of the old release is still running. The migration changed nothing. | Stop every server, as in [Upgrade on Kubernetes](https://platform.claude.com/docs/en/managed-agents/self-hosted/upgrade#upgrade-on-kubernetes), and run `helm upgrade` again. If a server didn’t shut down cleanly, wait 20 seconds first: until then, the migration still counts that server as running. |
| A line that contains `cannot downgrade`, when you deploy the old release again                                 | The old release can’t run on the changed schema.                                                                                | Restore the backup, as in [Roll back](https://platform.claude.com/docs/en/managed-agents/self-hosted/upgrade#roll-back).                                                                                                                                                                                  |
| Another error from the migration                                                                               | You don’t need to roll back. On Kubernetes, the servers stay as they were until the migration succeeds.                         | Fix the cause, and run `helm upgrade` or `docker compose up --build -d` again.                                                                                                                                                                                                                            |

The migration can succeed while the new servers don’t become ready. To find the cause, read the servers’ log:

* **Kubernetes:** `kubectl -n cma-server logs -l anthropic.com/role=server --prefix --tail=20`
* **Docker Compose:** `docker compose logs cma-server`

For example, on Kubernetes, a line that contains `has invalid keys` names a setting under `server.config` that the new release doesn’t accept. Fix the cause and run the upgrade command again before you consider a restore, because a restore loses data. On Kubernetes, once the schema has changed, a running server of the old release keeps serving, but it might not start again if it stops.

## Roll back

The `kubectl` commands in this section use the `$server` variable from [Upgrade on Kubernetes](https://platform.claude.com/docs/en/managed-agents/self-hosted/upgrade#upgrade-on-kubernetes). Before you roll back, check [If the upgrade fails](https://platform.claude.com/docs/en/managed-agents/self-hosted/upgrade#if-the-upgrade-fails). Then roll back by the kind of upgrade:

* **After a patch upgrade:** [Deploy the old release again](https://platform.claude.com/docs/en/managed-agents/self-hosted/upgrade#deploy-the-old-release-again). Both releases use the same schema.

* **After a minor or major upgrade:** Open `CHANGELOG.md` in the new archive. Read the section of every release that came after the one that you’re going back to.

  * If a section says that the old release can’t start on the migrated database, restore the backup.
  * Otherwise, deploy the old release again. If that fails with `cannot downgrade`, restore the backup.

<Warning>
  A restore loses everything that clients wrote after the backup began.
</Warning>

### Deploy the old release again

* **Kubernetes:** Go to the old archive’s top directory. Run the two `helm upgrade` commands from [Upgrade on Kubernetes](https://platform.claude.com/docs/en/managed-agents/self-hosted/upgrade#upgrade-on-kubernetes), with the values files as they were for that release. For example, if you added `earlierNames` for the upgrade, take it out. Run the second command only when the first succeeds.
* **Docker Compose:** Run `docker compose down` in the new release’s Compose directory, and then `docker compose up --build -d` in the old one.

If the old release can’t run on the changed schema, the log shows `cannot downgrade`:

* **Kubernetes:** The migration Job fails, and the servers stay as they are. [If the upgrade fails](https://platform.claude.com/docs/en/managed-agents/self-hosted/upgrade#if-the-upgrade-fails) says how to read the Job’s log.
* **Docker Compose:** The server doesn’t start. Read the log with `docker compose logs migrate`.

On Docker Compose, the output of `docker compose logs` might instead show `stored value is encrypted but no encryption key is configured`. In that case, the old release’s `.env` has no `CMA_STORE__CREDENTIALS_ENCRYPTION_KEY` line. Copy that line from the new release’s `.env`, and run `docker compose up --build -d` again.

### Restore the backup on Kubernetes

Your database server needs room for a second copy of the database. For `<role>` and `<database>`, use the `user` and `dbname` values of `database.url` in `cma-server-values.yaml`.

<Steps>
  <Step title="Restore the backup into a new database">
    Connect to the `postgres` database on your database server as an administrator, and run:

    ```sql
    CREATE DATABASE <database>_restored OWNER <role>;
    ```

    Then, on the machine that holds the backup, run this with the paths of your key and backup file. Use a `pg_restore` of the same major version as your database server. It prompts for the role’s password, and it prints nothing if it works.

    ```bash
    age -d -i cma-backup.agekey cma_server-<old-version>.dump.age \
      | PGSSLMODE=require pg_restore -h <database-host> -U <role> -d <database>_restored --no-owner --exit-on-error
    ```

    If this prints an error, stop. Your database hasn’t changed. Run `DROP DATABASE <database>_restored;` as an administrator, and start this step again.
  </Step>

  <Step title="Stop every server">
    ```bash
    kubectl -n cma-server scale deployment/$server --replicas=0
    kubectl -n cma-server wait --for=delete pod -l anthropic.com/role=server --timeout=90s
    ```
  </Step>

  <Step title="Switch to the restored database">
    Connect to the `postgres` database as an administrator, and run:

    ```sql
    ALTER DATABASE <database> RENAME TO <database>_upgraded;
    ALTER DATABASE <database>_restored RENAME TO <database>;
    ```

    If the first statement says that other sessions are using the database, close those sessions and run both statements again. A connection pooler can hold such sessions.
  </Step>

  <Step title="Deploy the old release">
    Follow the Kubernetes item of [Deploy the old release again](https://platform.claude.com/docs/en/managed-agents/self-hosted/upgrade#deploy-the-old-release-again). The first command also restores the server count. If it fails but `kubectl -n cma-server get pods` shows that the old servers are ready, see [If the key check fails](https://platform.claude.com/docs/en/managed-agents/self-hosted/upgrade#if-the-key-check-fails).
  </Step>

  <Step title="Delete the database that you set aside">
    That database still holds what clients wrote after the backup. When the old release works, delete it with `DROP DATABASE <database>_upgraded;`.
  </Step>
</Steps>

#### If the key check fails

In the “Deploy the old release” step, the first `helm upgrade` command waits until the old servers are ready. Then it checks the key that the sandboxes connect with. If the command fails but `kubectl -n cma-server get pods` shows that the old servers are ready, that check failed.

Your data is restored and the servers work, but the sandboxes can’t connect to them yet. The sandboxes connect with a key from the `cma-environment` Secret in their own namespace, `cma`. That key is newer than your backup, so the restored database doesn’t recognize it.

To confirm the cause, run the first command again. While it waits, open a second terminal and set `$server` there too. Then run `kubectl -n cma-server logs job/$server-environment-default`, with your environment’s name in place of `default`. Look for a line that contains `Secret cma/cma-environment records key`. If the log shows another error, fix what it names.

If the log shows that line, delete the Secret with `kubectl -n cma delete secret cma-environment`, and run the first command again. It creates the Secret again, with a new key. Then run the second command.

### Restore the backup on Docker Compose

<Steps>
  <Step title="Start only the database">
    Run `docker compose down` in the new release’s Compose directory. Then run `docker compose up -d --wait postgres` in the old release’s Compose directory. Stay in that directory for the next steps.
  </Step>

  <Step title="Restore the backup into a new database">
    From the old release’s Compose directory, run this with the paths of your key and backup file:

    ```bash
    docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d postgres \
        -c "DROP DATABASE IF EXISTS ${POSTGRES_DB}_restored" -c "CREATE DATABASE ${POSTGRES_DB}_restored"' \
      && age -d -i cma-backup.agekey cma_server-<old-version>.dump.age \
      | docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "${POSTGRES_DB}_restored" --no-owner --exit-on-error'
    ```

    It worked if it prints `DROP DATABASE` and `CREATE DATABASE`, and no error.

    Leave `$POSTGRES_USER` and `$POSTGRES_DB` as they are, here and in the next steps. The text in single quotes runs inside the `postgres` container, which holds the names of its role and its database in those variables.

    If it prints an error, your database hasn’t changed, so you can run the whole command again. If you can’t restore the backup, run `docker compose up --build -d` in the new release’s Compose directory to start that release again.
  </Step>

  <Step title="Switch to the restored database">
    ```bash
    docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d postgres \
        -c "ALTER DATABASE $POSTGRES_DB RENAME TO ${POSTGRES_DB}_upgraded" \
        -c "ALTER DATABASE ${POSTGRES_DB}_restored RENAME TO $POSTGRES_DB"'
    ```
  </Step>

  <Step title="Start the old release">
    Run `docker compose up --build -d`.
  </Step>

  <Step title="Delete the database that you set aside">
    That database still holds what clients wrote after the backup. When the old release works, delete it:

    ```bash
    docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE ${POSTGRES_DB}_upgraded"'
    ```
  </Step>
</Steps>

### After a restore

A restore takes environment keys back to the time of the backup:

* **A key that you revoked after the backup:** It works again. Revoke it again.
* **A key that you created after the backup:** It’s gone. Create a new key for the workers that used it.

[Replace an environment key for your own workers](https://platform.claude.com/docs/en/managed-agents/self-hosted/kubernetes#replace-an-environment-key-for-your-own-workers) has the commands, which also work on Docker Compose. The sandboxes that the Docker Compose stack starts need no action, because the stack replaces their key when it starts.

To list an environment’s keys, including revoked ones, run `list-keys` as follows:

* Use the terminal that you set up in [Call the API on a self-hosted server](https://platform.claude.com/docs/en/managed-agents/self-hosted/call-the-api). Don’t use the terminal that runs `docker compose`.
* On Kubernetes, first run `kubectl -n cma-server port-forward svc/$server 8400:8400` in another terminal, with `$server` set there too.
* Run the command from the archive’s top directory, once for each environment, with that environment’s ID.

```bash
echo "$ANTHROPIC_API_KEY" | ./cma-server-admin list-keys \
  -base-url http://127.0.0.1:8400 -env env_01595EKxaaTTGwwY3kyXdtbs \
  -key-file - -all
```

### Test a backup

To prove that a dump restores, run only the “Restore the backup into a new database” step. It’s in [Restore the backup on Kubernetes](https://platform.claude.com/docs/en/managed-agents/self-hosted/upgrade#restore-the-backup-on-kubernetes) and in [Restore the backup on Docker Compose](https://platform.claude.com/docs/en/managed-agents/self-hosted/upgrade#restore-the-backup-on-docker-compose). That step doesn’t change the database in use. Then drop the new database. On Docker Compose, its name is your database’s name with `_restored` at the end.

## Settings and paths to check

Read this section before you run an upgrade command.

Check the `web_tools` section of your [settings file](https://platform.claude.com/docs/en/managed-agents/self-hosted/configuration-reference#where-settings-go). If the file has no such section, or the section sets no keys, the `web_search` and `web_fetch` tools are off after the upgrade. An agent that uses the default toolset then runs without them, with no error. An agent whose toolset turns on either tool can’t start a session. To keep the tools, see [Web tools need a server setting](https://platform.claude.com/docs/en/managed-agents/self-hosted/differences#web-tools-need-a-server-setting).

On Kubernetes, check that each sandbox values file, such as `cma-values.yaml`, sets `egress.mode`. To keep your sandboxes’ access to the public internet, add `mode: publicInternet` under `egress`. If a file sets no mode, the chart applies its default mode, `closed`. The sandbox chart’s `helm upgrade` command then stops with an error such as `egress.mode is closed and egress.closed.hosts is empty`, and changes nothing.

Check `sandbox.idleTimeout` in the same files. If a file doesn’t set it, a session’s pod goes away about 5 minutes after the agent’s turn ends. The processes that the agent left running stop with the pod. By default, the files in `/workspace` stay. To keep the pod for 30 minutes, add `idleTimeout: 30m` under `sandbox`.

Check the settings file for `inference.attribution`, and the server’s environment for `CMA_INFERENCE__ATTRIBUTION`. Delete the line if you find one. The release that you’re upgrading to doesn’t have the setting, and its server doesn’t start if either is set.

When the Claude API is your inference provider, each model call carries the IDs of its session and of that session’s agent and environment after the upgrade. See [What the server sends to its inference provider](https://platform.claude.com/docs/en/managed-agents/self-hosted-data-and-access#what-the-server-sends-to-its-inference-provider).

### Kubernetes: the names of your objects

`cma-server-values.yaml` has to say which names your install has, in its `earlierNames` setting. To find the name of the server’s Deployment, run `kubectl -n cma-server get deployment -l anthropic.com/role=server`.

| The Deployment’s name | The line in `cma-server-values.yaml` |
| --------------------- | ------------------------------------ |
| `cma-onprem`          | `earlierNames: true`                 |
| `cma-server`          | `earlierNames: false`                |

If the file doesn’t have the line, add it before you upgrade, and keep it there for every later upgrade. Without it, the server chart’s `helm upgrade` command stops with an error that names `earlierNames`, and changes nothing.

With `earlierNames: true`, the chart’s objects keep their `cma-onprem` names, and the servers still find the Secrets that you created under those names. These pages use the names in the middle column. With `earlierNames: true`, use the names in the last column instead:

| Object                                                    | Name on these pages             | Name with `earlierNames: true`  |
| --------------------------------------------------------- | ------------------------------- | ------------------------------- |
| The server’s Deployment and Service                       | `cma-server`                    | `cma-onprem`                    |
| The migration Job                                         | `cma-server-migrate`            | `cma-onprem-migrate`            |
| The Job of each environment                               | `cma-server-environment-<name>` | `cma-onprem-environment-<name>` |
| The Secret with the database password                     | `cma-server-db`                 | `cma-onprem-db`                 |
| The Secret with the inference provider’s credential       | `cma-server-upstream`           | `cma-onprem-upstream`           |
| The Secret with the server API key and the encryption key | `cma-server-keys`               | `cma-onprem-server`             |

Whatever `earlierNames` says, the namespace is named `cma-server`, and the server’s image is named `cma-server-image`.

Each sandbox values file that sets `egress.mode: gateway` has to name the server’s two Services, under `egress.gateway`. If a file doesn’t, add both lines. This example has the names for an install with `earlierNames: true`:

```yaml
egress:
  gateway:
    serverService: cma-onprem
    serverEgressService: cma-onprem-egress
```

### Docker Compose: the archive’s layout and paths

If the release that you’re upgrading from has no `compose` directory, its `docker-compose.yml` is at the archive’s top, beside `bin`. In the new archive, that file is one level deeper, in `compose`.

In the “Repeat your other changes” step, make these changes too:

* **A Compose file of your own:** If the old archive had no `compose` directory, your file also goes one level deeper. A path such as `./bin` in it becomes `../bin`. If the file names the `cma-onprem` service, change that name to `cma-server`.
* **Paths under `/etc/cma-onprem/` or `/run/cma-onprem/`:** Change each one to start with `/etc/cma-server/` or `/run/cma-server/`. Look in the new release’s `.env` and `compose.config.yaml`, in a Compose file of your own, and in each `volumes:` line that you added. In a `volumes:` line, change only the part after the first colon, which is the path inside the container.
