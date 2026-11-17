---
title: Single sign-on
url: https://platform.claude.com/docs/en/managed-agents/self-hosted/configure
description: Let people and services call your self-hosted Claude Managed Agents server with tokens from your identity provider.
---

<Note>
  To request access to self-hosted Claude Managed Agents, contact your Anthropic account team. If you belong to a Claude Console organization that already has access, [sign in to the Claude Console](https://platform.claude.com) and switch to that organization. Then reload this page.
</Note>

By default, your server accepts one shared key, the [server API key](https://platform.claude.com/docs/en/managed-agents/self-hosted#the-three-credentials). With single sign-on, each person or service can also call the server with a token from your OpenID Connect (OIDC) identity provider. The server gives the caller a role from the groups in the token. The server API key keeps working as an administrator credential.

This page shows how to add your identity provider, what each role can do, and how to let developers log in from a terminal.

## Add your identity provider

<Steps>
  <Step title="Register the server in your identity provider">
    Register the server as an API with an identifier such as `api://cma-server`, and have clients request tokens for it.
  </Step>

  <Step title="List the identity provider in the settings file">
    Add an entry under `auth.issuers` in the [settings file](https://platform.claude.com/docs/en/managed-agents/self-hosted/configuration-reference#where-settings-go):

    ```yaml
    auth:
      issuers:
        - name: okta
          issuer_url: https://login.example.com/oauth2/default
          audiences: [api://cma-server]
          roles:
            - group: cma-admins
              role: admin
            - group: "eng-*"
              role: developer
    ```

    * `name` labels the issuer in log lines, and the server records it as part of the creator of each resource. Don’t change it once people have created resources.
    * `issuer_url` must equal the `iss` claim of your tokens.
    * `audiences` lists the values that a token’s `aud` claim can carry, such as the identifier from the first step.
    * `roles` maps a group to `admin`, `developer`, or `user`. The highest matching role wins.

    For the other fields, see [Issuer entries](https://platform.claude.com/docs/en/managed-agents/self-hosted/configuration-reference#issuer-entries). If your provider is Microsoft Entra ID, also see [Microsoft Entra ID](https://platform.claude.com/docs/en/managed-agents/self-hosted/configure#microsoft-entra-id).
  </Step>

  <Step title="Restart the server and check sign-in">
    Restart the server. A caller sends the token as `Authorization: Bearer <token>`, on any route that accepts the server API key.

    For every request that a token authenticated, the server logs `auth=oidc`, the issuer’s `name`, and the caller’s subject (`sub=`).
  </Step>
</Steps>

### If sign-in fails

| Response                               | Cause                                                  | The server’s log line contains |
| -------------------------------------- | ------------------------------------------------------ | ------------------------------ |
| `401`, the same as for a wrong API key | The token failed a check. The log line has the reason. | `oidc token`                   |
| `403`                                  | The token’s groups match no `roles` entry              | `token holds no role`          |

### Microsoft Entra ID

Entra ID differs from other providers in two ways. Both settings go in the issuer entry:

* **The person:** Entra ID gives a person a different `sub` in each client application, so the default would record one person as several creators. Set `subject_claim: oid`.
* **The groups:** Entra ID leaves the `groups` claim out of a token if the person belongs to many groups. That person then matches no `roles` entry. To prevent this, have Entra ID emit only the groups assigned to the application. Or assign app roles to people in Entra ID, and set `groups_claim: roles` so that the server reads app roles in place of groups.

## What each role can do

| Role                            | Agents, skills, sessions, vaults, and memory stores | Environments                                               |
| ------------------------------- | --------------------------------------------------- | ---------------------------------------------------------- |
| `admin`, and the server API key | Sees and changes everything                         | Creates, changes, and deletes them, and creates their keys |
| `developer` or `user`           | Sees and changes only what that caller created      | Lists them, reads them, and runs sessions in them          |

`developer` and `user` have the same access. A caller with either role:

* **Can’t see a resource that someone else created.** The resource is absent from lists, and a request for its ID gets the same answer as a request for an unknown ID. That includes everything created with the server API key before you turned on single sign-on.
* **Can’t share a resource** with another caller or a group.

Map `admin` to exact group names. An administrator can also start a session that uses any user’s vault. So give the role only to groups that you trust with every user’s MCP tokens.

## Let developers log in from a terminal

Developers can log in through your identity provider and then use the `ant` CLI under their own identity, without the server API key. You do the first two steps, and each developer does the third.

<Steps>
  <Step title="Register an application in your identity provider">
    Register a native (“public”) application that has:

    * No client secret
    * The authorization code grant with PKCE
    * The redirect URI `http://127.0.0.1/callback`

    Some providers need one of the [other redirect URIs](https://platform.claude.com/docs/en/managed-agents/self-hosted/configure#other-redirect-uris).
  </Step>

  <Step title="Add the application to the issuer entry">
    Add `login_client_id` and `login_scopes` to the issuer entry, and restart the server:

    ```yaml
    login_client_id: 0oa1b2c3d4e5f6g7h8i9
    login_scopes: [openid, cma-server.access]
    ```

    `login_scopes` lists the scopes that your provider needs to issue a token whose `aud` claim is in the issuer entry’s `audiences` list.
  </Step>

  <Step title="Log in">
    Each developer runs the login from the top of the extracted archive:

    ```bash
    ./cma-server-admin login https://cma.example.com
    ```

    The server’s URL must be `https://`, or `http://` to `localhost`, `127.0.0.1`, or `::1`. With one of the [other redirect URIs](https://platform.claude.com/docs/en/managed-agents/self-hosted/configure#other-redirect-uris), add its flag to the command.

    The command opens the provider’s sign-in page in a browser and then writes an `ant` CLI profile named `cma-server`. Pass `--profile cma-server` to any `ant` command, or run `ant profile activate cma-server` to make the profile the default.
  </Step>
</Steps>

When the token expires, the developer runs `login` again. To have the `ant` CLI renew the token instead, add `offline_access` to `login_scopes`.

### Other redirect URIs

| Provider                                       | Redirect URI to register                                          | Flag that developers add to the `login` command |
| ---------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------- |
| Microsoft Entra ID                             | `http://localhost/callback`                                       | `-listen localhost:0`                           |
| One that requires the port in the redirect URI | A URI with a fixed port, such as `http://127.0.0.1:8123/callback` | `-listen 127.0.0.1:8123`                        |

To list the other flags, add `-h` to the `login` command.

## Let people sign in to the console on your server

The console on your server signs people in through the application that you registered for the [terminal login](https://platform.claude.com/docs/en/managed-agents/self-hosted/configure#let-developers-log-in-from-a-terminal). To finish its setup, see [Set up sign-in](https://platform.claude.com/docs/en/managed-agents/self-hosted/console#set-up-sign-in).
