---
title: Agent identity and credentials
url: https://platform.claude.com/docs/en/managed-agents/self-hosted/agent-identity
description: Have your self-hosted Claude Managed Agents server sign a short-lived token that names each agent, keep vault credentials in your secret manager, and keep secrets out of sandboxes with the egress gateway.
---

<Note>
  To request access to self-hosted Claude Managed Agents, contact your Anthropic account team. If you belong to a Claude Console organization that already has access, [sign in to the Claude Console](https://platform.claude.com) and switch to that organization. Then reload this page.
</Note>

This page shows how to let the systems outside your server trust an agent, and where to keep the credentials that your agents use:

* [Agent identity](https://platform.claude.com/docs/en/managed-agents/self-hosted/agent-identity#agent-identity): Let an MCP server or gateway give each agent its own access. The server signs a short-lived token that names the agent.
* [Secret manager](https://platform.claude.com/docs/en/managed-agents/self-hosted/agent-identity#secret-manager): The server keeps vault credentials in AWS Secrets Manager, Google Cloud Secret Manager, HashiCorp Vault, or Azure Key Vault.
* [Environment variable credentials](https://platform.claude.com/docs/en/managed-agents/self-hosted/agent-identity#environment-variable-credentials): Let an agent’s commands call a service while the sandbox holds only a placeholder. The egress gateway puts the real value into the agent’s requests.

## Agent identity

Your server can sign a short-lived JSON Web Token (JWT) that names an agent, and send it with that agent’s MCP calls. The receiver, an MCP server or gateway, checks the token against public keys that you publish, and can then give each agent its own access.

### Set up the issuer

1. **Choose the issuer URL.** You publish your public keys at this URL in step 3, and receivers fetch them from it. A static web host works. Don’t use your server’s address, because the server doesn’t serve the keys at the paths that receivers fetch. Use an `https://` URL with no path or trailing slash, on a hostname that you can keep.

2. **Create the signing key.** Run these commands at the top of the extracted archive:

   ```bash
   mkdir -m 700 agent-identity
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out agent-identity/signing-key.pem
   ```

3. **Publish the public keys.** This command writes them to `issuer-files/.well-known/`. Serve `issuer-files` at the root of the issuer’s hostname, with the content type `application/json`.

   ```bash
   CMA_AGENT_IDENTITY__ISSUER=https://agents.example.com \
   CMA_AGENT_IDENTITY__KEY_FILE=./agent-identity/signing-key.pem \
     ./cma-server export-issuer -out issuer-files
   ```

4. **Give the server the key.**

   <Tabs>
     <Tab title="Docker Compose">
       1. If the archive has a `compose` directory, move the key’s directory into it: `mv agent-identity compose/agent-identity`.
       2. In `docker-compose.yml`, delete the `volumes: *server_mounts` line of the `cma-server` service, and uncomment the `volumes:` block below it. If you changed the `x-server-mounts` list, make the same change in that block, because the `cma-server` service no longer reads the list.
       3. In the directory that holds `agent-identity`, run `sudo chown -R root:root agent-identity`, unless you use Docker Desktop on macOS or rootless Docker.
     </Tab>

     <Tab title="Kubernetes">
       Run `kubectl -n cma-server create secret generic cma-agent-identity --from-file=agent-identity/signing-key.pem`. Then set `server.agentIdentity.secretName` to `cma-agent-identity` in the server chart’s values file.
     </Tab>
   </Tabs>

5. **Change the [settings file](https://platform.claude.com/docs/en/managed-agents/self-hosted/configuration-reference#where-settings-go).** List the receiver’s hostname in [`mcp.allowed_hostnames`](https://platform.claude.com/docs/en/managed-agents/self-hosted/differences#mcp-servers-need-an-allowlist-entry), and add this section:

   ```yaml
   agent_identity:
     issuer: https://agents.example.com
     key_file: /run/cma-server/agent-identity/signing-key.pem
     direct:
       audiences:
         - audience: https://mcp-gateway.example.com
           urls:
             - https://mcp-gateway.example.com
   ```

   Each `audience` names one receiver, as an `https://` URL. Its `urls` are the URL prefixes of the MCP servers that can receive a token for it.

6. **Restart the server.** In the Compose stack, run `docker compose up -d` from the Compose file’s directory instead of a restart.

To keep the private key out of files, use `key_secret` (your [secret manager](https://platform.claude.com/docs/en/managed-agents/self-hosted/agent-identity#secret-manager)) or `kms_key` (AWS KMS or Google Cloud KMS). [Configuration reference](https://platform.claude.com/docs/en/managed-agents/self-hosted/configuration-reference#agent-identity) describes both settings.

### Send the token to an MCP server

[MCP connector](https://platform.claude.com/docs/en/managed-agents/mcp-connector) describes the fields of an agent’s MCP server entry. Add an `auth` field to that entry:

```yaml
mcp_servers:
  - type: url
    name: tickets
    url: https://mcp-gateway.example.com/tickets
    auth:
      type: agent_token
      audience: https://mcp-gateway.example.com
```

For each tool listing or tool call, your server signs a new token. It sends the token as `Authorization: Bearer <token>`, in place of a vault credential. Neither the model nor the worker receives it.

To send both the token and a [vault credential](https://platform.claude.com/docs/en/managed-agents/vaults), replace the `auth` field with an `agent_token_header` field:

```yaml
mcp_servers:
  - type: url
    name: tickets
    url: https://mcp-gateway.example.com/tickets
    agent_token_header:
      audience: https://mcp-gateway.example.com
```

The vault credential goes in the `Authorization` header, as it does for an entry with neither field. The token goes in an `Agent-Identity-Token` header, with no `Bearer` prefix.

The SDK doesn’t have the `auth` and `agent_token_header` fields. In SDK code, add the field to the MCP server entry as an extra field, or send the request as plain JSON.

These pages show how to send extra fields:

[Python SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/python#undocumented-request-params) · [TypeScript SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript#undocumented-request-params) · [Go SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/go#request-fields) · [Java SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/java#undocumented-parameters) · [PHP SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/php#undocumented-request-parameters) · [Ruby SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/ruby#undocumented-request-params)

Some of those pages show extra fields only at the top level of a request, not inside a list entry. In that case, make `mcp_servers` itself the extra field. Send the whole list that way, with `auth` or `agent_token_header` in its entry.

To stop an agent’s tokens, remove the entry from the agent, or archive the agent. A token already sent stays valid until its `exp`, at most 5 minutes by default.

### What the receiver checks

Have the receiver accept a request only if all of these hold:

* The signature verifies under a key in your key set, `<issuer>/.well-known/jwks.json`. The right key is the one whose ID matches `kid` in the token’s header. For an RSA key, the algorithm is `RS256`.
* `iss` equals your issuer URL, and `aud` equals the receiver’s audience.
* `exp` is in the future, and `iat` is not in the future.
* `typ` in the token’s header is `agent+jwt`, and `token_use` is `agent`.

Then apply these rules:

* Base each agent’s access rules on the `agent_id` claim, the agent’s ID in the API.
* Accept a repeated `jti`, because one listing or call can take several requests with the same token.
* Have a gateway call each tool with its own credential, and never pass the token on.

With [single sign-on](https://platform.claude.com/docs/en/managed-agents/self-hosted/configure#single-sign-on), the token of a tool call also names the caller that created the session, in the `actor_sub` and `actor_iss` claims. `actor_sub` doesn’t mean that the caller approved the call. The model chooses each call.

These tokens have no `actor_sub`:

* The token of a tool listing
* The token of a subagent’s call
* Every token of a session that the server API key created

If a rule depends on the caller, refuse a tool call that has no `actor_sub`.

### Test the MCP gateway

The `check-gateway` command sends an MCP gateway valid and invalid tokens. Give the command a settings file of its own, here `check-gateway.yaml`:

1. Copy into the file only the `mcp` and `agent_identity` sections of the server’s settings, and `limits.mcp_call_timeout` if the server sets it.
2. In the copy, change `key_file` to the key’s path on the machine where you run the command, such as `./agent-identity/signing-key.pem`. If you moved the directory into `compose`, that’s `./compose/agent-identity/signing-key.pem`.

For `-agent`, give the ID of an agent that the gateway allows. If root owns the key, use `sudo`.

```bash
./cma-server check-gateway -config check-gateway.yaml -agent agent_011CYm1BLqPXpQRk5khsSXrs \
  -url https://mcp-gateway.example.com/tickets
```

The command prints one line for each request that it sends, with the gateway’s answer. A run that passes then prints a line that starts with `check-gateway: PASS`, and exits with code `0`. A run that fails says what went wrong, on a line that starts with `check-gateway:`, and exits with code `1`.

## Secret manager

By default, the server stores the secrets of [vault credentials](https://platform.claude.com/docs/en/managed-agents/vaults) in its database. With a `secret_store` section, the server writes each new vault credential’s secret to your secret manager, under a name prefix that you reserve for it. The database keeps only a reference.

Add the block for your secret manager to the [settings file](https://platform.claude.com/docs/en/managed-agents/self-hosted/configuration-reference#where-settings-go):

<Tabs>
  <Tab title="AWS Secrets Manager">
    ```yaml
    secret_store:
      type: aws_secrets_manager
      region: us-east-1
      prefix: cma-server/prod/
    ```
  </Tab>

  <Tab title="Google Cloud Secret Manager">
    ```yaml
    secret_store:
      type: gcp_secret_manager
      project: my-project        # the project ID, not its number
      prefix: cma-server-prod--
    ```
  </Tab>

  <Tab title="Azure Key Vault">
    ```yaml
    secret_store:
      type: azure_key_vault
      vault_url: https://my-vault.vault.azure.net
      prefix: cma-server-prod--
    ```
  </Tab>

  <Tab title="HashiCorp Vault">
    ```yaml
    secret_store:
      type: hashicorp_vault
      address: https://vault.internal:8200
      prefix: cma-server/prod/
      approle:
        role_id: <role-id>
        secret_id_file: /run/vault/secret-id
      #kubernetes: { role: cma-server }
      #token_file: /run/vault/token
    ```

    Set exactly one of the three login methods:

    * **`approle`:** Use it with Docker Compose, on a host, or with the server Helm chart. The server logs in with a role ID, and with a secret ID that it reads from a file.
    * **`kubernetes`:** Use it only on a Kubernetes install of your own, whose server pod has a service account token. The server logs in with that token. The server Helm chart gives the server’s pods no such token, so this method doesn’t work with the chart.
    * **`token_file`:** Use it for any other Vault login method. Run Vault Agent beside the server, and have it write its token to this file.

    With the server Helm chart, give the server the secret ID in a Secret:

    1. Put the secret ID in a Secret in the server’s namespace, and name that Secret in the chart’s `server.extensionFiles.secretName`.
    2. Set `approle.secret_id_file` to the secret ID’s path. The chart mounts each key of that Secret as a file under `/run/cma-server/extension-files/`, so a key named `secret-id` is at `/run/cma-server/extension-files/secret-id`.

    For the `kubernetes` method, bind the Vault Kubernetes role to the server’s namespace and service account, not to the sandboxes’ namespace, `cma`.
  </Tab>
</Tabs>

### Grant access

Give the server one identity, and confine it to the prefix. The `iam/` directory of the archive has a file for each secret manager:

* **AWS Secrets Manager:** Replace the placeholders in `aws-secrets-manager-policy.json`, and attach the policy to the identity that the server runs as.
* **Google Cloud Secret Manager:** Run the commands in the comments of `gcp-secret-manager-role.yaml`.
* **Azure Key Vault:** An Azure role covers a whole key vault, not a prefix. So give the deployment a key vault of its own, one that uses Azure role-based access control. Replace `SUBSCRIPTION_ID` in `azure-key-vault-role.json`, and create a custom role from it. Assign the role on the key vault to the identity that the server runs as.
* **HashiCorp Vault:** Replace the placeholders in `hashicorp-vault-policy.hcl`, and attach the policy to the identity that the server runs as.

To AWS and Google Cloud, the server authenticates as it does for inference. To Azure Key Vault, it authenticates with Microsoft Entra ID, as it does for [Microsoft Foundry](https://platform.claude.com/docs/en/managed-agents/self-hosted/inference-provider#microsoft-foundry).

### Check the setup

Run `validate-store` before the first start and after any policy change. It creates, reads, and deletes a test secret under the prefix, without starting the server. Run the command where the server runs, with the server’s environment:

* **Docker Compose:** Run it in the server’s container. On Arm, replace `linux_amd64` in this command with `linux_arm64`:

  ```bash
  docker compose exec cma-server /opt/cma-server/bin/linux_amd64/cma-server validate-store -config /etc/cma-server/config.yaml
  ```

* **On a host:**

  ```bash
  ./cma-server validate-store -config /etc/cma-server/config.yaml
  ```

* **Kubernetes:** Run the same command as a Job under the server’s service account.

A run that passes ends with a line that says `pass`, and exits with code `0`.

With Azure Key Vault, run this check against your key vault before you rely on it.

### Secret manager limits

* **Choose the settings once.** After any of these changes, the server no longer finds the secrets that it wrote before the change:

  * You remove the `secret_store` section.
  * You change `type`, `prefix`, `region`, `project`, `vault_url`, `mount`, or `namespace`. The last two are optional HashiCorp Vault settings.
  * You point `address` at another Vault.

  The server finds those secrets again only when you restore the old values.

* **One identity reads the whole prefix.** If two groups must not be able to reach each other’s credentials, give each group its own deployment. Each deployment needs its own prefix or key vault and its own identity.

## Environment variable credentials

With an [environment variable credential](https://platform.claude.com/docs/en/managed-agents/vaults#add-a-credential), an agent’s commands can call a service while the sandbox holds only a placeholder for the secret. The egress gateway puts the real value into requests to the hosts that the credential lists.

The gateway, `cma-egress`, is a proxy in the release archive that stands between your sandboxes and the internet. It is off by default, and your server accepts these credentials only with the gateway on.

With the gateway on, two limits apply to your sandboxes:

* Sandboxes reach the internet only through the gateway.
* The gateway connects only to the hosts that you list in the server’s `egress.allowed_hostnames` setting.

List exact public hostnames, with no wildcards. Include every host that your agents’ commands download from.

If you built your own sandbox image, start the worker through `cma-with-egress`, as [Build your own sandbox image](https://platform.claude.com/docs/en/managed-agents/self-hosted/call-the-api#what-an-image-of-your-own-needs) shows.

### Turn on the gateway in the Compose stack

From the directory that holds `docker-compose.yml`, add two lines to `.env`. The first lists the hosts that the gateway connects to, with commas between them. The second loads the gateway’s Compose file. Then start the stack:

```bash
echo 'CMA_EGRESS__ALLOWED_HOSTNAMES=api.github.com' >> .env
echo 'COMPOSE_FILE=docker-compose.yml:docker-compose.egress.yml' >> .env
docker compose up --build -d
```

If you use another Compose file too, add it to the `COMPOSE_FILE` line. A `COMPOSE_FILE` variable in your shell overrides the one in `.env`, so unset the shell’s variable.

The gateway’s file sets the server’s other `egress` settings, so don’t add an `egress` section to `compose.config.yaml`.

### Turn on the gateway on Kubernetes

These steps start from the deployment in [Deploy on Kubernetes](https://platform.claude.com/docs/en/managed-agents/self-hosted/kubernetes). They use that page’s `REGISTRY`, `TAG`, and `PLATFORM` variables and its two values files. Run the commands from the archive’s top directory, with OpenSSL 3.0 or later. The sandbox chart doesn’t offer the gateway on Azure Kubernetes Service (AKS).

The server chart’s upgrade in these steps also adds a network policy over the servers’ pods. Check two of the ports that it covers before you start:

* **Port 9464, the metrics port:** The policy closes it. If Prometheus scrapes that port, set `server.telemetry.prometheus.scraper.namespace` in `cma-server-values.yaml` to the namespace that Prometheus runs in.
* **Port 8400, the API’s port:** The policy admits every source. If a policy of your own limits who reaches port 8400, that limit stops working. Network policies add up, so a connection gets through if any one policy admits it.

<Steps>
  <Step title="Build and push the gateway’s image">
    ```bash
    docker buildx build --platform "$PLATFORM" -f kubernetes/egress/Dockerfile -t "$REGISTRY/cma-egress:$TAG" --push .
    ```
  </Step>

  <Step title="Create the certificate authority and the gateway key">
    ```bash
    (umask 077 && openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 825 \
      -subj "/CN=cma-server egress gateway" \
      -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
      -addext "keyUsage=critical,keyCertSign,cRLSign" \
      -keyout egress-ca.key -out egress-ca.crt)
    kubectl -n cma create secret tls cma-egress-ca --cert=egress-ca.crt --key=egress-ca.key
    kubectl -n cma-server create configmap cma-egress-ca --from-file=ca.crt=egress-ca.crt
    GATEWAY_KEY=$(openssl rand -hex 32)
    printf %s "$GATEWAY_KEY" | kubectl -n cma create secret generic cma-egress-gateway-key --from-file=gateway-key=/dev/stdin
    printf %s "$GATEWAY_KEY" | kubectl -n cma-server create secret generic cma-egress-gateway-key --from-file=gateway-key=/dev/stdin
    unset GATEWAY_KEY
    ```

    Then delete `egress-ca.key`, the certificate authority’s private key. Anyone who holds it can impersonate any website to your sandboxes. The certificate is valid for 825 days. See [Renew the certificate](https://platform.claude.com/docs/en/managed-agents/self-hosted/agent-identity#renew-the-certificate).
  </Step>

  <Step title="Remove the sandboxes of earlier sessions">
    If the environment has run no sessions, skip this step. A sandbox from before the change can’t start its worker afterward. These commands also delete each sandbox’s workspace:

    ```bash
    kubectl -n cma scale deployment cma-dispatcher --replicas=0
    kubectl -n cma delete sandboxwarmpool cma-sandbox
    kubectl -n cma delete sandboxclaims --all
    ```

    On Google Kubernetes Engine (GKE), also run this command:

    ```bash
    kubectl -n cma delete sandboxes --all
    ```

    Repeat `kubectl -n cma get sandboxes,pods,pvc` until it finds nothing. The `helm upgrade` in the step “Turn on the sandboxes’ side” starts the dispatcher again.
  </Step>

  <Step title="Turn on the server’s side">
    Choose a free IPv4 address in the cluster’s Service range for the gateway. The `CLUSTER-IP` column of `kubectl get svc -A` shows addresses in that range. Add this to `cma-server-values.yaml`. If the file already has a `server` block, merge these lines into it:

    ```yaml
    egressGateway:
      enabled: true
      proxyAddress: 34.118.224.53:3128   # the address that you chose, and port 3128
    server:
      config:
        egress:
          allowed_hostnames:
            - api.github.com
    ```

    Then run the upgrade:

    ```bash
    helm upgrade cma-server kubernetes/server/chart --namespace cma-server -f cma-server-values.yaml --wait
    ```
  </Step>

  <Step title="Turn on the sandboxes’ side">
    Run `kubectl -n cma-server get svc` to list the server’s two Services. In a new install, they are named `cma-server` and `cma-server-egress`.

    In `cma-values.yaml`, change `egress.mode` to `gateway`, and add a `gateway` block under `egress`. Give the block the two names that the command listed:

    ```yaml
    egress:
      mode: gateway
      gateway:
        serviceIP: 34.118.224.53   # the address that you chose
        serverService: cma-server
        serverEgressService: cma-server-egress
        apiServerCIDRs:
          - 203.0.113.10/32        # the cluster's API endpoint
    ```

    Keep the file’s other `egress` values. To print the API endpoint’s addresses and port, run `kubectl get endpoints kubernetes -n default`. If the port isn’t 443, also set `egress.gateway.apiServerPort`.

    ```bash
    helm upgrade cma kubernetes/chart --namespace cma -f cma-values.yaml --wait
    ```

    If the upgrade stops on a conflict over `.spec.replicas`, run `kubectl -n cma scale deployment cma-dispatcher --replicas=1`, and then run the upgrade again.
  </Step>
</Steps>

### Add a credential

Create an environment variable credential as [Add a credential](https://platform.claude.com/docs/en/managed-agents/vaults#add-a-credential) shows. The hosted guides say that these credentials aren’t supported with self-hosted sandboxes. That describes the hosted service, not your server.

Your server adds rules of its own. It refuses a request that breaks one with a `400` error that names the field. Two of those rules follow:

* `networking` (csharp, go: `Networking`) must have the type `limited`, and every host in `allowed_hosts` (java, php: `allowedHosts`; csharp, go: `AllowedHosts`) must be on the server’s `egress.allowed_hostnames` list.
* `injection_location` (java, php: `injectionLocation`; csharp, go: `InjectionLocation`) must be `{"header": true}` in JSON, and can’t be left out.

After you add a host to the server’s list, apply the change. On Docker Compose, run `docker compose up -d`. On Kubernetes, run the server’s `helm upgrade` command and `kubectl -n cma-server rollout restart deployment -l anthropic.com/role=server`.

### Check the egress gateway

Create a session with the credential’s vault, and ask the agent to run two commands. This example is for a credential named `GITHUB_TOKEN` that lists `api.github.com`:

```bash
printenv GITHUB_TOKEN
curl -sS -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user
```

The first command prints a placeholder that starts with `cma_ph_`. The second prints the profile of the token’s GitHub account, because the gateway replaced the placeholder with the token. The gateway refuses a request to a host that isn’t on your list with a `403` error.

On Kubernetes, if every request gets a `503` error, your cluster’s network probably rewrites the pods’ addresses, as the `--masquerade-all` option of kube-proxy does. The gateway tells sandboxes apart by their pods’ addresses, so those addresses must reach it unchanged.

### Renew the certificate

On Kubernetes, renew the certificate while no session runs. Repeat the whole step “Create the certificate authority and the gateway key” in [Turn on the gateway on Kubernetes](https://platform.claude.com/docs/en/managed-agents/self-hosted/agent-identity#turn-on-the-gateway-on-kubernetes). It creates the certificate authority and the gateway key again, so you don’t need the `egress-ca.key` file that you deleted. Make one change: add `--dry-run=client -o yaml | kubectl apply -f -` to the end of each of the four lines that run `kubectl create`. A line that ends in `--from-file=gateway-key=/dev/stdin`, for example, then ends in `--from-file=gateway-key=/dev/stdin --dry-run=client -o yaml | kubectl apply -f -`.

Then restart the servers and the gateway:

```bash
kubectl -n cma-server rollout restart deployment -l anthropic.com/role=server
kubectl -n cma rollout restart deployment/cma-egress
```

### Egress gateway limits

* **Headers:** The gateway puts a value only into a request header, never into a URL or a body. By default, the only header is `Authorization`. To allow others, list them together with `Authorization` in `egress.swap_header_names`, or in `CMA_EGRESS__SWAP_HEADER_NAMES` in `.env` for the Compose stack.
* **Programs that ignore proxy variables:** Sandboxes find the gateway through `HTTPS_PROXY` and related variables. Java tools such as Maven and Gradle don’t read those variables, so they reach nothing.
