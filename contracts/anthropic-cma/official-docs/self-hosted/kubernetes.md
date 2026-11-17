---
title: Deploy on Kubernetes
url: https://platform.claude.com/docs/en/managed-agents/self-hosted/kubernetes
description: Install the self-hosted Claude Managed Agents server and its sandboxes on a Kubernetes cluster with the two Helm charts in the release archive, then run a first session in a sandbox pod.
---

<Note>
  To request access to self-hosted Claude Managed Agents, contact your Anthropic account team. If you belong to a Claude Console organization that already has access, [sign in to the Claude Console](https://platform.claude.com) and switch to that organization. Then reload this page.
</Note>

This page takes an empty Google Kubernetes Engine (GKE) cluster to a session that runs a tool in a sandbox pod. It uses the two Helm charts in the release archive, which run the whole stack on the cluster:

* **`cma-server`:** Applies the database schema and runs two servers behind a Service, in the namespace `cma-server`.
* **`cma-sandboxes`:** Runs a dispatcher and the sandbox pods in the namespace `cma`. The dispatcher polls the server for work and gives each session its own sandbox pod, where a worker runs the agent’s shell and file tools.

Your PostgreSQL database stays outside both. On another kind of cluster, the steps are the same, but the cluster prerequisites and a few chart values differ. See [Other clusters](https://platform.claude.com/docs/en/managed-agents/self-hosted/kubernetes#other-clusters).

## Prerequisites

* **A cluster:** Kubernetes 1.30 or later, with:

  * The Agent Sandbox controller (on GKE, the [Agent Sandbox add-on](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/how-install-agent-sandbox))
  * Nodes that run gVisor (on GKE, a [GKE Sandbox node pool](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/sandbox-pods))
  * A network plugin that enforces NetworkPolicy (on GKE, Dataplane V2 or Calico)

* **A database:** PostgreSQL 16 or later that the cluster can reach.

* **A registry:** One that the cluster can pull from. You build the images yourself.

* **A Claude API key:** The server uses it for model calls. To use another provider, see [Inference provider](https://platform.claude.com/docs/en/managed-agents/self-hosted/inference-provider).

* **Permissions:** Cluster-admin rights or the equivalent. The install creates namespaces, Roles, and a ClusterRoleBinding.

* **Tools on your machine:** `helm`, `kubectl`, `docker buildx`, `openssl`, and the [`ant` CLI](https://platform.claude.com/docs/en/cli-sdks-libraries/cli/quickstart#installation).

* **The release archive:** To request access to the download, contact your Anthropic account team. If your organization already has access, follow the note at the top of this page. After you download the archive, extract it. Run every command on this page from its top directory.

## Install the stack

<Steps>
  <Step title="Build and push the images">
    Set these variables to your own values. `PLATFORM` is your nodes’ architecture. `TAG` is the release’s version, which is in the archive’s name after the `v`. Both charts expect images that have this version as their tag.

    ```bash
    REGISTRY=us-docker.pkg.dev/my-project/cma
    TAG=1.2.3
    PLATFORM=linux/amd64
    ```

    Then build and push the three images:

    ```bash
    docker buildx build --platform "$PLATFORM" -f kubernetes/server/Dockerfile -t "$REGISTRY/cma-server-image:$TAG" --push .
    docker buildx build --platform "$PLATFORM" -f kubernetes/dispatcher/Dockerfile -t "$REGISTRY/cma-dispatcher:$TAG" --push .
    docker buildx build --platform "$PLATFORM" -t "$REGISTRY/cma-sandbox:$TAG" --push kubernetes/sandbox
    ```
  </Step>

  <Step title="Create a secrets file and the database">
    Create a file with a generated database password and a placeholder for your Claude API key:

    ```bash
    cat > secrets.env <<EOF
    PG_PASSWORD=$(openssl rand -hex 32)
    UPSTREAM_KEY=sk-ant-...
    EOF
    chmod 600 secrets.env
    ```

    Open `secrets.env` in an editor and replace `sk-ant-...` with your Claude API key. Then connect to your database server as an administrator, for example, with `psql`. Run this SQL, with the value of `PG_PASSWORD` in place of `...`:

    ```sql
    CREATE ROLE cma_server LOGIN PASSWORD '...';
    GRANT cma_server TO CURRENT_USER;
    CREATE DATABASE cma_server OWNER cma_server;
    ```
  </Step>

  <Step title="Create the server’s namespace and Secrets">
    Create the server’s namespace and its Secrets:

    ```bash
    source secrets.env
    ENCRYPTION_KEY=$(openssl rand -base64 32)
    kubectl create namespace cma-server
    kubectl label namespace cma-server pod-security.kubernetes.io/enforce=restricted pod-security.kubernetes.io/enforce-version=latest
    kubectl -n cma-server create secret generic cma-server-db \
      --from-literal=PGPASSWORD="$PG_PASSWORD"
    kubectl -n cma-server create secret generic cma-server-keys \
      --from-literal=CMA_SERVER__API_KEY="$(openssl rand -hex 32)" \
      --from-literal=CMA_STORE__CREDENTIALS_ENCRYPTION_KEY="$ENCRYPTION_KEY"
    kubectl -n cma-server create secret generic cma-server-upstream \
      --from-literal=ANTHROPIC_API_KEY="$UPSTREAM_KEY"
    ```

    Print the encryption key with `echo "$ENCRYPTION_KEY"`, and keep a copy outside the cluster. The server uses this key to encrypt the credentials that it stores, and a restored database needs it. Then delete `secrets.env`. The `cma-server-db` Secret keeps the database password.
  </Step>

  <Step title="Create the sandboxes’ namespace and certificate">
    Create the sandboxes’ namespace, and a certificate that the dispatcher serves and the sandboxes trust:

    ```bash
    kubectl create namespace cma
    kubectl label namespace cma pod-security.kubernetes.io/enforce=restricted pod-security.kubernetes.io/enforce-version=latest
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 825 \
      -subj "/CN=cma-dispatcher.cma.svc" \
      -addext "subjectAltName=DNS:cma-dispatcher.cma.svc,DNS:cma-dispatcher.cma.svc.cluster.local" \
      -keyout tls.key -out tls.crt
    kubectl -n cma create secret tls cma-dispatcher-tls --cert=tls.crt --key=tls.key --dry-run=client -o yaml | kubectl apply -f -
    kubectl -n cma create configmap cma-dispatcher-ca --from-file=ca.crt=tls.crt --dry-run=client -o yaml | kubectl apply -f -
    ```
  </Step>

  <Step title="Install the server">
    Save this as `cma-server-values.yaml`, with your registry and your database’s address:

    ```yaml
    earlierNames: false   # a new install
    image:
      registry: us-docker.pkg.dev/my-project/cma   # REGISTRY in the build commands
    database:
      url: host=10.20.0.5 port=5432 user=cma_server dbname=cma_server sslmode=require   # your database's address
    environments:
      - name: default
        namespace: cma
    ```

    Then install the chart:

    ```bash
    helm install cma-server kubernetes/server/chart --namespace cma-server -f cma-server-values.yaml --wait
    kubectl -n cma-server logs job/cma-server-environment-default
    ```

    The install creates the environment `default` and stores its key in the Secret `cma-environment` in the namespace `cma`. The second command prints one line that starts `filled Secret cma/cma-environment`. If a first `helm install` fails, run `helm uninstall` for that release before you install again.
  </Step>

  <Step title="Find the cluster addresses to block">
    This install lets sandboxes reach the public internet. A cluster’s API endpoint usually has a public address, so sandboxes could reach it too. To block it, you list its address under `egress.clusterCIDRs` in the next step.

    To print the address, run `gcloud container clusters describe my-cluster --format 'value(endpoint)'` with your cluster’s name.

    The chart itself blocks the private ranges `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, and `100.64.0.0/10`. If your cluster has a pod, service, or node range outside those four, list that range as well.
  </Step>

  <Step title="Install the sandboxes">
    Save this as `cma-values.yaml`, with your registry and the addresses from the previous step:

    ```yaml
    platform: gke
    image:
      registry: us-docker.pkg.dev/my-project/cma   # REGISTRY in the build commands
    egress:
      mode: publicInternet
      clusterCIDRs:
        - 203.0.113.10/32                          # the cluster's API endpoint
      cmaServer:
        pods:
          namespace: cma-server
          matchLabels:
            anthropic.com/role: server
        port: 8400
    ```

    `egress.cmaServer` opens the path to your servers. To compare `publicInternet` with the two other modes, see [What sandboxes can reach](https://platform.claude.com/docs/en/managed-agents/self-hosted/kubernetes#what-sandboxes-can-reach).

    If your cluster uses one of these DNS setups, add a line to the file:

    * **Cloud DNS for GKE, which Autopilot clusters use:** `gke: {dns: cloudDns}`
    * **NodeLocal DNSCache:** `gke: {dns: nodeLocalCache, kubeDnsUpstreamIP: <address>}`. To print the address, run `kubectl -n kube-system get svc kube-dns-upstream -o jsonpath='{.spec.clusterIP}'`.

    Then install the chart:

    ```bash
    helm install cma kubernetes/chart --namespace cma -f cma-values.yaml --wait
    ```
  </Step>
</Steps>

## Run a session

These steps use a new install’s names. If your server values file has `earlierNames: true`, find the names to use instead in [Kubernetes: the names of your objects](https://platform.claude.com/docs/en/managed-agents/self-hosted/upgrade#object-names).

<Steps>
  <Step title="Forward the server’s port">
    In one terminal, forward the server’s port to your machine:

    ```bash
    kubectl -n cma-server port-forward svc/cma-server 8400:8400
    ```
  </Step>

  <Step title="Point the CLI at your server">
    In a second terminal, point the `ant` CLI at the forwarded port and read the server API key from the `cma-server-keys` Secret:

    ```bash
    export ANTHROPIC_BASE_URL=http://127.0.0.1:8400
    export ANTHROPIC_API_KEY=$(kubectl -n cma-server get secret cma-server-keys -o jsonpath='{.data.CMA_SERVER__API_KEY}' | base64 -d)
    ```
  </Step>

  <Step title="Create an agent and ask it to run a command">
    Follow three steps of the quickstart’s [Run your first session](https://platform.claude.com/docs/en/managed-agents/self-hosted/quickstart#run-your-first-session): Create an agent, Start a session, and Ask the agent to run a command. In Start a session, replace `compose-sandbox` with `default`, the name of the environment that the charts create.
  </Step>

  <Step title="Find the sandbox pod">
    The agent replies with the hostname of the pod that ran the command. In a third terminal, `kubectl -n cma get pods` lists a pod of that name beside the dispatcher’s. By default, the pod goes away about 5 minutes after the agent’s turn ends. If it isn’t in the list, ask the agent to run `hostname` again.

    To leave the chat, press Ctrl+C.
  </Step>
</Steps>

## Put TLS in front of the server

The server speaks plain HTTP on port 8400, and requests from your applications carry the server API key. Before clients outside the cluster connect, put a load balancer or ingress that terminates TLS in front of the `cma-server` Service. It must:

* Pass request paths through unchanged.
* Accept request bodies up to 32 MiB.
* Pass responses through unbuffered.
* Set a default read timeout of 2 minutes. For Git requests, set a read timeout of 10 minutes for paths matching `^/cma-[a-z]+/git/`.
* Send traffic only to servers that are ready. The `cma-server` Service already does this. A load balancer that reaches the pods directly must probe `/cma-server/readyz` on each pod and skip one that returns `503`.
* Never resend a `POST` that a server already accepted.
* Never cache a response.

To check it from outside the cluster, run `curl -s https://<host>/cma-server/healthz`. The response is `{"status":"ok"}`.

## What sandboxes can reach

In `cma-values.yaml`, `egress.mode: publicInternet` lets sandboxes reach the public internet.

This table compares it with the two other modes:

| `egress.mode`         | What sandboxes can reach                                                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `closed`, the default | Your servers and the dispatcher, and no DNS server                                                                                                                                                                                                |
| `publicInternet`      | Your servers, the dispatcher, a DNS server, and the public internet                                                                                                                                                                               |
| `gateway`             | Your servers, the dispatcher, and, through the egress gateway, the hosts that you list. See [Turn on the gateway on Kubernetes](https://platform.claude.com/docs/en/managed-agents/self-hosted/agent-identity#turn-on-the-gateway-on-kubernetes). |

## Other clusters

Set `platform` in `cma-values.yaml` to `eks` for Amazon EKS, to `aks` for Azure Kubernetes Service (AKS), or to `generic` for any other cluster. All three need the upstream Agent Sandbox controller with its extensions, and a network plugin that enforces NetworkPolicy. They also need:

* **Amazon EKS:** A node group with gVisor’s `runsc` registered as a containerd handler named `runsc`. Label the nodes `cma.anthropic.com/sandbox-node=true`, and taint them `cma.anthropic.com/sandbox-node=true:NoSchedule`. The chart registers the `gvisor` RuntimeClass against that handler.
* **AKS:** A node pool with Pod Sandboxing, with the same label and taint as on Amazon EKS. Put the name of the cluster’s network policy engine (`cilium`, `calico`, or `azure`) in `aks.networkPolicy`. Keep `egress.mode: publicInternet`, the only mode that the chart accepts on AKS. Test the chart on your cluster before agents do real work on it.
* **Any other cluster:** A RuntimeClass for gVisor or another sandboxed runtime. Put its name in `runtimeClass.name`.

The folder `kubernetes/chart/examples/` in the archive has a complete values file for each kind of cluster.

## Free a session’s volume

By the chart’s defaults, each session has a 10 GiB volume for `/workspace`. The volume stays after the session’s pod goes away, so the session’s next message finds its files.

| To free                                      | Do this                                                                                                                                                                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One session’s volume                         | Archive the session after its turn ends. The dispatcher usually deletes the volume within about 5 minutes.                                                                                                                                                   |
| The volumes of sessions that nobody archives | Set `dispatcher.retentionDays` in `cma-values.yaml`. The dispatcher then deletes a volume once its session has been idle for that many days, and the session’s next message starts with an empty `/workspace`. The chart’s default, `0`, keeps every volume. |

The commands in this section are for GKE. On another cluster, use `sandboxclaims` in place of `sandboxes`.

Deleting a session doesn’t free its volume. Archive the session first. Delete it only after `kubectl -n cma get sandboxes -l anthropic.com/session-id=<session-id>` lists nothing.

If you deleted a session without archiving it, free its volume yourself:

1. Find the session’s ID in the dispatcher’s log. This command prints a line for each session that appears to be deleted and still has a volume, with the ID after `session_id`:

   ```bash
   kubectl -n cma logs deployment/cma-dispatcher --since=6m \
     | grep "could not check the claim's session" | grep "403 Forbidden"
   ```

   The dispatcher writes these lines every 5 minutes. If the session isn’t listed, wait 5 minutes and run the command again.

2. Confirm that the session is deleted. With the port forwarded and `ANTHROPIC_API_KEY` set as in [Run a session](https://platform.claude.com/docs/en/managed-agents/self-hosted/kubernetes#run-a-session), run `ant --base-url http://127.0.0.1:8400 beta:sessions retrieve --session-id <session-id>`. Go on only if the answer is `404 Not Found` with `Session not found`. If the command prints a session, stop: that session isn’t deleted.

3. Delete the Kubernetes object that owns the volume. The session’s files go with it:

   ```bash
   kubectl -n cma delete sandboxes -l anthropic.com/session-id=<session-id>
   ```

## Renew keys and certificates

An environment key is valid for 365 days, and the dispatcher’s certificate is valid for 825 days. Renew each before it expires.

In an environment key’s last 30 days, the server logs a warning on each request that uses the key. The warning starts `environment key is within 30 days of expiry`.

### Renew the environment key that the charts created

To see when the key expires, run `kubectl -n cma describe secret cma-environment`.

Run these two commands at least once in the key’s last 60 days, from the top directory of the installed release’s archive:

```bash
helm upgrade cma-server kubernetes/server/chart --namespace cma-server -f cma-server-values.yaml --wait
kubectl -n cma rollout restart deployment/cma-dispatcher
```

Each time the server chart’s `helm upgrade` command runs, it stores a new key in the Secret if the key expires within 60 days. Nothing else renews the key. The second command restarts the dispatcher so that it reads the new key.

### Renew the dispatcher’s certificate

Go back to the step “Create the sandboxes’ namespace and certificate.” Repeat its `openssl` command and the two `kubectl` commands after it. Then restart the dispatcher with `kubectl -n cma rollout restart deployment/cma-dispatcher`.

### Replace an environment key for your own workers

The charts renew only their own key. If you created a key yourself, as in [Create an environment and its key](https://platform.claude.com/docs/en/managed-agents/self-hosted/call-the-api#create-an-environment-and-its-key), replace it with the admin CLI. The CLI is at the top of the release archive.

Run the commands in the second terminal from [Run a session](https://platform.claude.com/docs/en/managed-agents/self-hosted/kubernetes#run-a-session), where `ANTHROPIC_API_KEY` holds the server API key. Keep the port-forward running in the first terminal. If you reach your server at another address, pass that address as `-base-url`, and you need no port-forward.

<Steps>
  <Step title="Create a new key for the same environment">
    For `-env`, pass the environment’s ID:

    ```bash
    echo "$ANTHROPIC_API_KEY" | ./cma-server-admin mint-key \
      -base-url http://127.0.0.1:8400 -env env_01595EKxaaTTGwwY3kyXdtbs -key-file -
    ```

    The command prints the new key, and it prints the key’s ID and expiry on standard error.
  </Step>

  <Step title="Move your workers to the new key">
    Set the new key as `ANTHROPIC_ENVIRONMENT_KEY` for each process that polls, and restart it.
  </Step>

  <Step title="Revoke the old key">
    A worker that still uses a revoked key gets a `401` error and gives up the session it was serving. To find the old key’s ID, run `list-keys` with the same `-base-url`, `-env`, and `-key-file` flags. When no worker uses the old key anymore, revoke it by that ID:

    ```bash
    echo "$ANTHROPIC_API_KEY" | ./cma-server-admin revoke-key \
      -base-url http://127.0.0.1:8400 -env env_01595EKxaaTTGwwY3kyXdtbs \
      -key-id etok_01AbCdEfGhIjKlMnOpQrStUv -key-file -
    ```
  </Step>
</Steps>

## Uninstall the stack

Delete the sandboxes first. `helm uninstall` deletes the network policies that confine sandboxes, but the sandboxes that the dispatcher made for sessions keep running.

These steps don’t touch your database, but they delete the Secrets. To use the database again, you need your copy of the encryption key.

<Steps>
  <Step title="Stop the dispatcher and delete the sandboxes">
    ```bash
    kubectl -n cma scale deployment/cma-dispatcher --replicas=0
    kubectl -n cma delete sandboxwarmpool cma-sandbox
    kubectl -n cma delete sandboxclaims --all
    ```

    On GKE, also run this command:

    ```bash
    kubectl -n cma delete sandboxes --all
    ```
  </Step>

  <Step title="Wait until the sandboxes are gone">
    Repeat this command until the sandboxes, their pods, and their volumes are gone:

    ```bash
    kubectl -n cma get sandboxes,pods,pvc
    ```
  </Step>

  <Step title="Uninstall the charts and delete the namespaces">
    ```bash
    helm uninstall cma --namespace cma
    helm uninstall cma-server --namespace cma-server
    kubectl delete namespace cma cma-server
    ```
  </Step>
</Steps>

## Next steps

* **Upgrade:** [Upgrade self-hosted Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/self-hosted/upgrade) has the `helm upgrade` commands.
* **Change other chart values:** See the comments in `kubernetes/server/chart/values.yaml` for the server and `kubernetes/chart/values.yaml` for the sandboxes.
* **Call the API from your code:** See [Call the API on a self-hosted server](https://platform.claude.com/docs/en/managed-agents/self-hosted/call-the-api).
* **Work in a browser:** See [Use the console on your server](https://platform.claude.com/docs/en/managed-agents/self-hosted/console).
