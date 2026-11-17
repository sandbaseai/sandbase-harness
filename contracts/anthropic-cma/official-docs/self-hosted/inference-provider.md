---
title: Inference provider
url: https://platform.claude.com/docs/en/managed-agents/self-hosted/inference-provider
description: Send model calls from your self-hosted Claude Managed Agents server to Amazon Bedrock, Claude Models on Google Cloud (Google managed), Microsoft Foundry, or a model gateway that you run, instead of the Claude API.
---

<Note>
  To request access to self-hosted Claude Managed Agents, contact your Anthropic account team. If you belong to a Claude Console organization that already has access, [sign in to the Claude Console](https://platform.claude.com) and switch to that organization. Then reload this page.
</Note>

By default, your server sends model calls to the Claude API. This page shows how to send them to a cloud provider, or to a model gateway that you run. To change the provider:

1. Put the sample from your provider’s section of this page in the server’s [settings file](https://platform.claude.com/docs/en/managed-agents/self-hosted/configuration-reference#where-settings-go).
2. Give the server the provider’s credential, as the same section shows.
3. Restart the server, as [Where settings go](https://platform.claude.com/docs/en/managed-agents/self-hosted/configuration-reference#where-settings-go) shows. On Docker Compose, if step 2 changed `.env` or `docker-compose.yml`, run `docker compose up -d` instead, because a restart doesn’t reread them.
4. [Check the provider](https://platform.claude.com/docs/en/managed-agents/self-hosted/inference-provider#check-the-provider).

The `inference.provider` setting takes these values:

| `inference.provider`  | Model calls go to                              | The server authenticates with            |
| --------------------- | ---------------------------------------------- | ---------------------------------------- |
| `anthropic` (default) | The Claude API                                 | `ANTHROPIC_API_KEY`                      |
| `bedrock`             | Amazon Bedrock                                 | Your AWS credential                      |
| `vertex`              | Claude Models on Google Cloud (Google managed) | Google Application Default Credentials   |
| `foundry`             | Microsoft Foundry                              | A Foundry API key, or Microsoft Entra ID |
| `gateway`             | A model gateway that you run                   | A key or token that your gateway accepts |

Under every value except `anthropic`, the server needs no Claude API key. It ignores `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_BASE_URL`. The one exception is a [model gateway](https://platform.claude.com/docs/en/managed-agents/self-hosted/inference-provider#model-gateway) whose key you tell the server to read from one of those variables.

Agents name models by their Claude API IDs, such as `claude-opus-5-5`. The server translates the ID, so an agent definition works unchanged under any provider that serves that model.

Some tools and agent settings depend on the provider. See [Differences that depend on your inference provider](https://platform.claude.com/docs/en/managed-agents/self-hosted/differences#differences-that-depend-on-your-inference-provider).

## Give the server a cloud credential

How a cloud provider’s credential reaches the server depends on your install:

* **Docker Compose:** [Pass each variable and file to the server](https://platform.claude.com/docs/en/managed-agents/self-hosted/configuration-reference#pass-a-credential-to-the-compose-stack).
* **Kubernetes:** The server chart passes no AWS, Google Cloud, or Azure variables, so use your cloud’s workload identity. Create a service account with your cloud’s workload identity annotation, and set `server.serviceAccountName` to its name. The chart’s `values.yaml` names the annotation. On Azure Kubernetes Service, also set `server.azureWorkloadIdentity: true`.

## Amazon Bedrock

```yaml
inference:
  provider: bedrock
  region: us-east-1
  #model_id_prefix: global.anthropic.
  #model_id_overrides:
  #  claude-opus-5-5: us.anthropic.claude-opus-5-5
```

The server signs its calls with whatever the AWS SDK’s default credential chain finds on the host. That can be a task role or a pod identity. On a workstation, it can be `AWS_PROFILE` or `AWS_ACCESS_KEY_ID`.

Enable the models that you use in the account. The AWS identity that the server signs with needs these permissions:

* `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on the models and inference profiles that you use.
* `bedrock:ListFoundationModels` and `bedrock:ListInferenceProfiles` on resource `*`. The server reads Amazon Bedrock’s model lists, so that agents can use a model that’s newer than your server’s release. To skip this, set `inference.list_models: false`.

By default, the server puts `us.anthropic.` before each model ID, which names a cross-region inference profile. To use another family of profiles, uncomment `model_id_prefix`.

## Claude Models on Google Cloud (Google managed)

```yaml
inference:
  provider: vertex
  region: us-east5
  project_id: my-project
  #model_id_overrides:
  #  claude-haiku-4-5: claude-haiku-4-5@20251001
```

`region` is required. It is a location of Google Cloud’s Agent Platform that offers the models you use, or `global`. `project_id` is the project that the calls are made in and billed to.

The server uses Google Application Default Credentials: the file that `GOOGLE_APPLICATION_CREDENTIALS` names, or the service account that Compute Engine, Cloud Run, or GKE attaches. That identity needs the `roles/aiplatform.user` role on the project. The project needs the `aiplatform.googleapis.com` API and the Claude models you use enabled.

## Microsoft Foundry

```yaml
inference:
  provider: foundry
  foundry:
    resource: my-resource
  #model_id_overrides:
  #  claude-opus-5-5: team-a-opus
```

`resource` is the name of your Foundry resource, the first part of its hostname: `<resource>.services.ai.azure.com`.

The credential comes from the server’s environment:

* **A Foundry API key:** Set `ANTHROPIC_FOUNDRY_API_KEY`. In the Compose stack, [pass the variable to the server](https://platform.claude.com/docs/en/managed-agents/self-hosted/configuration-reference#pass-a-credential-to-the-compose-stack). On Kubernetes, put it in the `cma-server-upstream` Secret. With `earlierNames: true` in your server values file, the Secret has another name. Find it in [Kubernetes: the names of your objects](https://platform.claude.com/docs/en/managed-agents/self-hosted/upgrade#object-names).
* **Microsoft Entra ID:** Leave `ANTHROPIC_FOUNDRY_API_KEY` unset. The server then gets a token for a service principal, a workload identity on Azure Kubernetes Service, or a managed identity. The identity needs an Azure role on the Foundry resource that allows calls to its model deployments. For a service principal, set `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET`.

A request to Foundry names a deployment, and the server sends the model ID as the deployment name. If a deployment has another name, map it with [`model_id_overrides`](https://platform.claude.com/docs/en/managed-agents/self-hosted/inference-provider#map-a-model-id-that-differs).

## Map a model ID that differs

Your cloud account can have a model under a different ID from the one that the server sends. In that case, uncomment the `model_id_overrides` lines in that provider’s sample, and map the Claude API ID to your account’s ID. Both IDs must name the same model, because the server builds each request for the model that the agent names.

## Model gateway

First check which requests your gateway accepts:

* **The same requests as the Claude API, with one long-lived credential:** Keep the default provider. Set `ANTHROPIC_BASE_URL` to the gateway’s address, and set `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` to the credential that the gateway expects.
* **The same requests as the Claude API, but with short-lived tokens, a credential in another header, or its own model IDs:** Set `inference.provider: gateway` with `format: anthropic-messages`.
* **Amazon Bedrock’s InvokeModel format:** Set `inference.provider: gateway` with `format: bedrock-invoke`.
* **The `rawPredict` format of Claude Models on Google Cloud (Google managed):** Set `inference.provider: gateway` with `format: vertex-raw-predict`.

This sample sets `inference.provider: gateway` with `format: bedrock-invoke`, for a gateway that takes one long-lived key. Put the key in an environment variable and name the variable, never the value:

```yaml
inference:
  provider: gateway
  gateway:
    url: "https://llm-gateway.example.com/v1/model/{model}/invoke"
    format: bedrock-invoke
    # Quote every model_map value.
    model_map:
      claude-opus-5-5: "us.anthropic.claude-opus-5-5"
      claude-sonnet-5: "us.anthropic.claude-sonnet-5"
  credentials:
    supplier: env
    env: { var: LLM_GATEWAY_KEY }
    send_as: { header: x-api-key }
```

* `url` is the gateway’s model route. `{model}` marks where the model ID goes. The URL must be `https://` and end in `/invoke`.

* `model_map` maps each model ID that an agent can name to the ID that the gateway expects. The server refuses a model that has no entry.

* `send_as` names the header that carries the key. Without it, the server sends `Authorization: Bearer <key>`.

* In the Compose stack, [pass the variable](https://platform.claude.com/docs/en/managed-agents/self-hosted/configuration-reference#pass-a-credential-to-the-compose-stack) to the server.

* On Kubernetes, the server chart can’t pass a variable of your own. It does pass `ANTHROPIC_AUTH_TOKEN`, which it reads from the `cma-server-upstream` Secret, so use that name:

  1. Set `env: { var: ANTHROPIC_AUTH_TOKEN }`.
  2. Put the gateway’s key in the `cma-server-upstream` Secret, under the name `ANTHROPIC_AUTH_TOKEN`. With `earlierNames: true` in your server values file, the Secret has another name. Find it in [Kubernetes: the names of your objects](https://platform.claude.com/docs/en/managed-agents/self-hosted/upgrade#object-names).

For `format: anthropic-messages`, replace the `gateway` block with this one:

```yaml
inference:
  gateway:
    url: "https://llm-gateway.example.com/v1/messages"
    format: anthropic-messages
    # Quote every model_map value.
    model_map:
      claude-opus-5-5: "corp-claude-opus"
      claude-sonnet-5: "corp-claude-sonnet"
```

Here, `url` is the whole URL of the gateway’s Messages route, with no `{model}`.

For `format: vertex-raw-predict`, replace the `gateway` block with this one:

```yaml
inference:
  gateway:
    url: "https://llm-gateway.example.com/v1/projects/my-project/locations/global/publishers/anthropic/models/{model}:rawPredict"
    format: vertex-raw-predict
    # Quote every model_map value.
    model_map:
      claude-opus-5-5: "claude-opus-5-5"
      claude-sonnet-5: "claude-sonnet-5"
```

Here, `url` is the gateway’s `rawPredict` route, and it must end in `/{model}:rawPredict`. A `model_map` value can’t contain a colon. The `credentials` block stays as it is. The server sends your gateway’s own credential and gets no Google credential.

[Configuration reference](https://platform.claude.com/docs/en/managed-agents/self-hosted/configuration-reference#model-gateway) lists the gateway’s other settings, such as `streaming`, and the `inference.headers` setting.

### Short-lived tokens

If your gateway takes short-lived tokens, replace the `credentials` block with this one:

```yaml
inference:
  credentials:
    supplier: oauth_exchange
    assertion:
      url: "https://app.example.com/assertion"
      auth: { type: mtls, cert_file: /etc/callback/client.pem, key_file: /etc/callback/client.key }
    exchange:
      token_url: "https://login.example.com/oauth2/token"
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer"
```

The server then gets each token in two steps. First, it calls an HTTP callback that you build. The callback returns an assertion, a signed statement that’s usually a JSON Web Token (JWT). Then the server exchanges the assertion at your OAuth token endpoint for the access token that it sends to the gateway.

* `auth` is how the server authenticates to the callback. The sample uses a client certificate. To use a bearer token that the server reads from a file, set `auth: { type: bearer_file, token_file: /etc/callback/token }`.
* `exchange` names your OAuth token endpoint. The server sends that endpoint only `grant_type` and the assertion, with no client ID or secret.
* If your token endpoint needs more than that, leave out `exchange`. Have your callback get the access token itself and return it in the `assertion` field, which the server then sends to the gateway.
* On Kubernetes, put the certificate files in a Secret, name it in the chart’s `server.extensionFiles.secretName`, and point `cert_file` and `key_file` at `/run/cma-server/extension-files/`.

The server sends the callback a `POST` request with this body:

```json
{
  "version": 1,
  "purpose": "inference",
  "session": {
    "id": "sesn_011CZkZAtmR3yMPDzynEDxu7",
    "agent_id": "agent_011CYm1BLqPXpQRk5khsSXrs",
    "environment_id": "env_01595EKxaaTTGwwY3kyXdtbs"
  },
  "principal": {
    "issuer": "https://login.example.com/oauth2/default",
    "subject": "00u1a2b3c4d5e6f7g8h9"
  },
  "request_id": "req_011CSHoEeqs5C35K2UUqR7Fy"
}
```

`principal` is the caller that created the session. For a [single sign-on](https://platform.claude.com/docs/en/managed-agents/self-hosted/configure#single-sign-on) caller, `issuer` is that caller’s `issuer_url`, and `subject` is the caller’s subject. For the server API key, `principal` is `{"issuer": "cma", "subject": "server"}`. Have the callback ignore fields that it doesn’t know.

The callback answers with status `200` and this body:

```json
{ "assertion": "<signed JWT>", "reuse": "session" }
```

`reuse` says which sessions can use the token. With `session`, the default, only the session in the request can, which suits a token that names one user. With `deployment`, sessions share the token, so return `deployment` only for a token that names your organization and no person.

If the callback or the token endpoint fails, the turn ends with a `session.error` event of type `model_request_failed_error`, and the session stays usable. The reason is in the server log, on a line that contains `credential supplier failed`.

If the token endpoint’s reply has no `expires_in` and the token has no `exp` claim, the server sends the token but doesn’t store it. It then asks for another token on every model call.

For the other settings, such as `renew_before` and `ca_file`, see the Configuration reference’s tables of [model gateway settings](https://platform.claude.com/docs/en/managed-agents/self-hosted/configuration-reference#model-gateway) and [short-lived token settings](https://platform.claude.com/docs/en/managed-agents/self-hosted/configuration-reference#short-lived-gateway-tokens).

### Microsoft Entra ID tokens

If your gateway checks Microsoft Entra ID tokens against its own app registration, replace the `credentials` block with this one:

```yaml
inference:
  credentials:
    supplier: azure
    azure: { scope: "api://11111111-2222-3333-4444-555555555555/.default" }
```

`scope` is the application ID URI or the application ID of the gateway’s app registration, followed by `/.default`. Name only the gateway’s own registration. A token for another resource would let whoever runs the gateway act as the server there.

The token is issued to the server’s own Azure identity, set up as for Microsoft Entra ID under [Microsoft Foundry](https://platform.claude.com/docs/en/managed-agents/self-hosted/inference-provider#microsoft-foundry). If the registration requires an app role, assign that role to the identity before you start the server. A later assignment takes effect only when the server gets another token.

The token names that identity and no person, so a gateway that must know which person is calling needs `oauth_exchange`. Run a turn through your gateway, under the identity that your servers will use, before you rely on this supplier.

## Check the provider

After you change the settings and restart the server, look for this line in the server log. It says that the server found a credential for the provider:

```text wrap
level=INFO msg="upstream credential resolved" provider=bedrock
```

The line doesn’t prove that your account has a model enabled. A missing model shows up as a `session.error` on the first turn that uses it.

A gateway that you name in `ANTHROPIC_BASE_URL` might reject the [server-side fallback](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback#server-side-fallback) field or header. If every turn fails for that reason, set `inference.model_fallback: false` in the [settings file](https://platform.claude.com/docs/en/managed-agents/self-hosted/configuration-reference#where-settings-go).
