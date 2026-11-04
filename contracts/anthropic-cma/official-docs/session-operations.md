---
title: Session operations
url: https://platform.claude.com/docs/en/managed-agents/session-operations
description: Retrieve, list, update, archive, and delete Claude Managed Agents sessions.
featureMetadata:
  topic:
    title: Managed Agents
    url: https://platform.claude.com/docs/en/managed-agents/overview
  status: beta
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
  supportedPlatforms:
    Claude API: beta
    Claude Platform on AWS: beta
    Claude Models on Google Cloud (Anthropic managed): beta
---

Once a session exists, use these operations to read, update, archive, or delete it. See [Start a session](https://platform.claude.com/docs/en/managed-agents/sessions) for creating a session and sending it work.

## Session statuses

Sessions progress through these statuses. See [Start a session](https://platform.claude.com/docs/en/managed-agents/sessions) for the session lifecycle.

| Status         | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idle`         | Agent is waiting for input, including user messages or tool confirmations. Sessions created without `initial_events` (java, php: `initialEvents`; csharp, go: `InitialEvents`) start in `idle`. A session can be `idle` while a [workflow run](https://platform.claude.com/docs/en/managed-agents/workflow-runs#while-a-run-is-open) is still open, so `idle` alone doesn’t mean that the work is done. See [Know when the work is done](https://platform.claude.com/docs/en/managed-agents/workflow-runs#know-when-the-work-is-done). |
| `running`      | Agent is actively executing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `rescheduling` | Transient error occurred, retrying automatically.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `terminated`   | Session has ended, either because of an unrecoverable error or because it was archived. A session that completes its work goes `idle`, not `terminated`.                                                                                                                                                                                                                                                                                                                                                                               |

## Updating the agent configuration

You can update a session’s `agent.tools` (csharp, go: `Agent.Tools`) and `agent.mcp_servers` (java, php: `agent.mcpServers`; csharp: `Agent.McpServers`; go: `Agent.MCPServers`), including permission policies and per-tool web settings such as [domain filters](https://platform.claude.com/docs/en/managed-agents/tools-web-restrictions#change-the-lists-mid-session), mid-session without creating a new agent version. Updates are session-local and do not apply to the underlying agent. Updated `allowed_domains` (java, php: `allowedDomains`; csharp, go: `AllowedDomains`) and `blocked_domains` (java, php: `blockedDomains`; csharp, go: `BlockedDomains`) apply to the rest of the session.

Only the agent’s `tools` (csharp, go: `Tools`) and `mcp_servers` (java, php: `mcpServers`; csharp: `McpServers`; go: `MCPServers`) can change after a session is created. To run a session with `model` (csharp, go: `Model`), `system` (csharp, go: `System`; ruby: `system_`), or `skills` (csharp, go: `Skills`) values other than the agent’s, use [agent configuration overrides](https://platform.claude.com/docs/en/managed-agents/sessions#override-agent-configuration-for-a-session) when you create the session. The agent’s model configuration, including its [`inference_geo`](https://platform.claude.com/docs/en/manage-claude/data-residency) pin, also can’t change mid-session: set the pin when you save the agent, or set or clear it for a single session with a `model` (csharp, go: `Model`) override when you create it. The agent’s configured `system` (csharp, go: `System`; ruby: `system_`) field is fixed for the session’s lifetime. On models that support it, you can still append system-level guidance mid-session by sending a [`system.message` event](https://platform.claude.com/docs/en/managed-agents/events-and-streaming#send-system-messages).

The semantics of a `tools` (csharp, go: `Tools`) or `mcp_servers` (java, php: `mcpServers`; csharp: `McpServers`; go: `MCPServers`) update are full replacement: the provided array is the new value. To preserve existing entries, `GET` the session, modify the array, and `POST` it back.

The session must be `idle` to update the agent. To update the agent while the session is running, send a [`user.interrupt` event](https://platform.claude.com/docs/en/managed-agents/events-and-streaming#interrupt-the-agent) by itself and wait for the session to become `idle`. If a [workflow run](https://platform.claude.com/docs/en/managed-agents/workflow-runs#while-a-run-is-open) is open, whether it’s running or paused, the update returns a 400 error, even when the session is `idle`. An interrupt doesn’t end a run, so the update still fails after you interrupt the session. Send a `user.message` that [asks the agent to stop its runs](https://platform.claude.com/docs/en/managed-agents/workflow-runs#interrupt-a-session-with-runs-open), or wait until every run has ended.

<CodeGroup>
  ```bash cURL
  curl -sS --fail-with-body "https://api.anthropic.com/v1/sessions/$SESSION_ID" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "agent": {
        "tools": [
          {"type": "agent_toolset_20260401"},
          {"type": "mcp_toolset", "mcp_server_name": "linear"}
        ],
        "mcp_servers": [
          {"type": "url", "name": "linear", "url": "https://mcp.linear.app/sse"}
        ]
      }
    }'
  ```

  ```bash CLI
  ant beta:sessions update --session-id "$SESSION_ID" <<'YAML'
  agent:
    tools:
      - type: agent_toolset_20260401
      - type: mcp_toolset
        mcp_server_name: linear
    mcp_servers:
      - type: url
        name: linear
        url: https://mcp.linear.app/sse
  YAML
  ```

  ```python Python
  client.beta.sessions.update(
      session.id,
      agent={
          "tools": [
              {"type": "agent_toolset_20260401"},
              {"type": "mcp_toolset", "mcp_server_name": "linear"},
          ],
          "mcp_servers": [
              {"type": "url", "name": "linear", "url": "https://mcp.linear.app/sse"}
          ],
      },
  )
  ```

  ```typescript TypeScript
  await client.beta.sessions.update(session.id, {
    agent: {
      tools: [
        { type: "agent_toolset_20260401" },
        { type: "mcp_toolset", mcp_server_name: "linear" }
      ],
      mcp_servers: [{ type: "url", name: "linear", url: "https://mcp.linear.app/sse" }]
    }
  });
  ```

  ```csharp C#
  await client.Beta.Sessions.Update(session.ID, new()
  {
      Agent = new()
      {
          Tools =
          [
              new BetaManagedAgentsAgentToolset20260401Params(),
              new BetaManagedAgentsMcpToolsetParams { McpServerName = "linear" },
          ],
          McpServers =
          [
              new()
              {
                  Name = "linear",
                  Url = "https://mcp.linear.app/sse",
              },
          ],
      },
  });
  ```

  ```go Go
  _, err = client.Beta.Sessions.Update(ctx, session.ID, anthropic.BetaSessionUpdateParams{
  	Agent: anthropic.BetaManagedAgentsSessionAgentUpdateParam{
  		Tools: []anthropic.BetaManagedAgentsSessionAgentUpdateToolUnionParam{
  			{
  				OfAgentToolset20260401: &anthropic.BetaManagedAgentsAgentToolset20260401Params{},
  			},
  			{
  				OfMCPToolset: &anthropic.BetaManagedAgentsMCPToolsetParams{
  					MCPServerName: "linear",
  				},
  			},
  		},
  		MCPServers: []anthropic.BetaManagedAgentsURLMCPServerParams{
  			{
  				Name: "linear",
  				URL:  "https://mcp.linear.app/sse",
  			},
  		},
  	},
  })
  if err != nil {
  	panic(err)
  }
  ```

  ```java Java
  client.beta().sessions().update(
      session.id(),
      SessionUpdateParams.builder()
          .agent(BetaManagedAgentsSessionAgentUpdate.builder()
              .addTool(BetaManagedAgentsAgentToolset20260401Params.builder().build())
              .addTool(BetaManagedAgentsMcpToolsetParams.builder()
                  .mcpServerName("linear")
                  .build())
              .addMcpServer(BetaManagedAgentsUrlMcpServerParams.builder()
                  .name("linear")
                  .url("https://mcp.linear.app/sse")
                  .build())
              .build())
          .build()
  );
  ```

  ```php PHP
  $client->beta->sessions->update(
      $session->id,
      agent: BetaManagedAgentsSessionAgentUpdate::with(
          tools: [
              BetaManagedAgentsAgentToolset20260401Params::with(),
              BetaManagedAgentsMCPToolsetParams::with(mcpServerName: 'linear'),
          ],
          mcpServers: [
              BetaManagedAgentsURLMCPServerParams::with(
                  name: 'linear',
                  url: 'https://mcp.linear.app/sse',
              ),
          ],
      ),
  );
  ```

  ```ruby Ruby
  client.beta.sessions.update(
    session.id,
    agent: {
      tools: [
        {type: :agent_toolset_20260401},
        {type: :mcp_toolset, mcp_server_name: "linear"}
      ],
      mcp_servers: [
        {type: :url, name: "linear", url: "https://mcp.linear.app/sse"}
      ]
    }
  )
  ```
</CodeGroup>

## Updating the session budget

A session [created with a budget](https://platform.claude.com/docs/en/managed-agents/sessions#set-a-session-budget) accepts two kinds of budget update: replacing the cap with a new `max_list_cost` (java, php: `maxListCost`; csharp, go: `MaxListCost`), and removing it by passing `"budget": null` (python: `budget=None`; typescript: `budget: null`; ruby: `budget: nil`; go: `Budget: param.NullStruct[anthropic.BetaManagedAgentsBudgetLimitParam]()`; java: `.budget(Optional.empty())`; csharp: `Budget = null`; php: `requestOptions: ['extraBodyParams' => ['budget' => null]]`; cli: `--budget null`). Both automatically resume work that paused when the session reached its cap. A replacement cap can be higher or lower than the current one, but it must be strictly greater than the session’s consumed list cost. Removal is one-way: a non-null `budget` (csharp, go: `Budget`) is accepted only on a session that currently has one. You therefore can’t re-add a removed budget or add one to a session created without it. See [Session budgets](https://platform.claude.com/docs/en/managed-agents/budgets#resume-a-session-at-its-budget) for request examples, the error behaviors, and what counts toward list cost.

## Retrieving a session

<CodeGroup>
  ```bash cURL
  curl -fsSL "https://api.anthropic.com/v1/sessions/$SESSION_ID" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01"
  ```

  ```bash CLI
  ant beta:sessions retrieve --session-id "$SESSION_ID"
  ```

  ```python Python
  retrieved = client.beta.sessions.retrieve(session.id)
  print(f"Status: {retrieved.status}")
  ```

  ```typescript TypeScript
  const retrieved = await client.beta.sessions.retrieve(session.id);
  console.log(`Status: ${retrieved.status}`);
  ```

  ```csharp C#
  var retrieved = await client.Beta.Sessions.Retrieve(session.ID);
  Console.WriteLine($"Status: {retrieved.Status.Raw()}");
  ```

  ```go Go
  retrieved, err := client.Beta.Sessions.Get(ctx, session.ID, anthropic.BetaSessionGetParams{})
  if err != nil {
  	panic(err)
  }
  fmt.Printf("Status: %s\n", retrieved.Status)
  ```

  ```java Java
  var retrieved = client.beta().sessions().retrieve(session.id());
  IO.println("Status: " + retrieved.status());
  ```

  ```php PHP
  $retrieved = $client->beta->sessions->retrieve($session->id);
  echo "Status: {$retrieved->status}\n";
  ```

  ```ruby Ruby
  retrieved = client.beta.sessions.retrieve(session.id)
  puts "Status: #{retrieved.status}"
  ```
</CodeGroup>

## Listing sessions

Results from `GET /v1/sessions` are paginated. Use the `limit` query parameter to control the page size. Each response includes a `next_page` cursor; pass it as the `page` parameter on the next request to fetch the following page. `next_page` is `null` when there are no more results.

To go back a page, pass `prev_page` as the `page` parameter. `prev_page` is `null` when you’re on the first page.

A `page` cursor is opaque and encodes the `order` of the request that produced it. The `order` query parameter sets the sort direction of the results, `asc` or `desc` by creation time; the default is `desc` (newest first). Reusing a cursor with a different `order` returns a 400 error, as does changing a `created_at` filter so that it excludes the cursor’s position. Other query parameters, including the remaining filters and `limit`, can change between paginated requests. For the pagination fields shared across list endpoints, see [Pagination](https://platform.claude.com/docs/en/api/overview#pagination).

<CodeGroup>
  ```bash cURL
  curl -sS --fail-with-body \
    "https://api.anthropic.com/v1/sessions?agent_id=$AGENT_ID&limit=1" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01"
  # Pass next_page back as the page query parameter to fetch the next page,
  # or prev_page to go back.
  ```

  ```bash CLI
  # --format raw returns one page envelope with its prev_page and next_page
  # cursors; the default output auto-paginates and emits only the sessions.
  ant beta:sessions list --agent-id "$AGENT_ID" --limit 1 --format raw
  # Pass next_page back as --page to fetch the next page, or prev_page to go back.
  ```

  ```python Python
  # Set `limit` low so the results span more than one page.
  first_page = client.beta.sessions.list(limit=1, agent_id=agent.id)
  # `prev_page` is None on the first page; `next_page` is None on the last.
  print(f"prev_page: {first_page.prev_page}")
  print(f"next_page: {first_page.next_page}")

  # Pass `next_page` back as `page` to fetch the next page.
  second_page = client.beta.sessions.list(
      limit=1, agent_id=agent.id, page=first_page.next_page
  )
  for listed_session in second_page.data:
      print(f"{listed_session.id}: {listed_session.status}")

  # Pass `prev_page` back as `page` to return to the previous page.
  previous_page = client.beta.sessions.list(
      limit=1, agent_id=agent.id, page=second_page.prev_page
  )
  for listed_session in previous_page.data:
      print(f"{listed_session.id}: {listed_session.status}")
  # For forward-only iteration, the page object is also directly iterable.
  ```

  ```typescript TypeScript
  const firstPage = await client.beta.sessions.list({ limit: 1, agent_id: agent.id });
  // prev_page is null on the first page; next_page is set when more sessions exist.
  console.log(`prev_page: ${firstPage.prev_page}`);
  console.log(`next_page: ${firstPage.next_page}`);

  // Pass next_page as the `page` cursor to fetch the second page.
  const secondPage = await client.beta.sessions.list({
    limit: 1,
    agent_id: agent.id,
    page: firstPage.next_page
  });
  for (const listedSession of secondPage.data) {
    console.log(`Page 2 has ${listedSession.id}: ${listedSession.status}`);
  }

  // Pass the second page's prev_page cursor to step back to the first page.
  const previousPage = await client.beta.sessions.list({
    limit: 1,
    agent_id: agent.id,
    page: secondPage.prev_page
  });
  for (const listedSession of previousPage.data) {
    console.log(`Back on page 1: ${listedSession.id} is ${listedSession.status}`);
  }
  // For forward-only iteration, the page object is also directly iterable.
  ```

  ```csharp C#
  // The SessionListPage that `List` returns exposes the items but not the
  // pagination cursors. To read `prev_page` / `next_page`, deserialize the raw
  // response into SessionListPageResponse instead.
  using var page1Response = await client.Beta.Sessions.WithRawResponse.List(
      new SessionListParams { Limit = 1, AgentID = agent.ID }
  );
  var page1 = await page1Response.Deserialize<SessionListPageResponse>();
  Console.WriteLine($"prev_page: {page1.PrevPage ?? "null"}");
  Console.WriteLine($"next_page: {page1.NextPage ?? "null"}");

  // Advance: pass `next_page` from page 1 as the `page` cursor.
  using var page2Response = await client.Beta.Sessions.WithRawResponse.List(
      new SessionListParams { Limit = 1, AgentID = agent.ID, Page = page1.NextPage }
  );
  var page2 = await page2Response.Deserialize<SessionListPageResponse>();
  foreach (var listedSession in page2.Data ?? [])
  {
      Console.WriteLine($"Page 2: {listedSession.ID}: {listedSession.Status.Raw()}");
  }

  // Go back: pass `prev_page` from page 2 as the same `page` cursor.
  using var previousPageResponse = await client.Beta.Sessions.WithRawResponse.List(
      new SessionListParams { Limit = 1, AgentID = agent.ID, Page = page2.PrevPage }
  );
  var previousPage = await previousPageResponse.Deserialize<SessionListPageResponse>();
  foreach (var listedSession in previousPage.Data ?? [])
  {
      Console.WriteLine($"Back to page 1: {listedSession.ID}: {listedSession.Status.Raw()}");
  }
  // For forward-only iteration, (await client.Beta.Sessions.List(...)).Paginate() returns an IAsyncEnumerable that auto-follows next_page.
  ```

  ```go Go
  // Page 1: prev_page is empty because nothing precedes the first page.
  firstPage, err := client.Beta.Sessions.List(ctx, anthropic.BetaSessionListParams{
  	AgentID: anthropic.String(agent.ID),
  	Limit:   anthropic.Int(1),
  })
  if err != nil {
  	panic(err)
  }
  fmt.Printf("Page 1 prev_page: %q\n", firstPage.PrevPage)
  fmt.Printf("Page 1 next_page: %q\n", firstPage.NextPage)

  // Advance: pass next_page as the Page cursor to fetch page 2.
  secondPage, err := client.Beta.Sessions.List(ctx, anthropic.BetaSessionListParams{
  	AgentID: anthropic.String(agent.ID),
  	Limit:   anthropic.Int(1),
  	Page:    anthropic.String(firstPage.NextPage),
  })
  if err != nil {
  	panic(err)
  }
  for _, listedSession := range secondPage.Data {
  	fmt.Printf("Page 2: %s: %s\n", listedSession.ID, listedSession.Status)
  }

  // Go back: page 2's prev_page is the cursor for the page before it.
  previousPage, err := client.Beta.Sessions.List(ctx, anthropic.BetaSessionListParams{
  	AgentID: anthropic.String(agent.ID),
  	Limit:   anthropic.Int(1),
  	Page:    anthropic.String(secondPage.PrevPage),
  })
  if err != nil {
  	panic(err)
  }
  for _, listedSession := range previousPage.Data {
  	fmt.Printf("Back to page 1: %s: %s\n", listedSession.ID, listedSession.Status)
  }
  // For forward-only iteration, use ListAutoPaging to auto-follow next_page.
  ```

  ```java Java
  var params = SessionListParams.builder()
      .agentId(agent.id())
      .limit(1)
      .build();
  var firstPage = client.beta().sessions().list(params);
  for (var listedSession : firstPage.data()) {
      IO.println(listedSession.id() + ": " + listedSession.status());
  }
  // prev_page is an empty Optional on the first page; next_page points to page 2.
  IO.println("prev_page: " + firstPage.response().prevPage());
  IO.println("next_page: " + firstPage.response().nextPage());

  // Advance by passing next_page as the page cursor.
  var nextCursor = firstPage.response().nextPage().orElseThrow();
  var secondPage = client.beta().sessions().list(params.toBuilder()
      .page(nextCursor)
      .build());

  // Go back by passing prev_page as the same page cursor.
  var prevCursor = secondPage.response().prevPage().orElseThrow();
  var previousPage = client.beta().sessions().list(params.toBuilder()
      .page(prevCursor)
      .build());
  // Back on the first page, so prev_page is empty again.
  IO.println("prev_page: " + previousPage.response().prevPage());
  // For forward-only iteration, page.autoPager() returns an Iterable that auto-follows next_page.
  ```

  ```php PHP
  // Page 1: prevPage is null because nothing precedes the first page.
  $firstPage = $client->beta->sessions->list(agentID: $agent->id, limit: 1);
  echo 'Page 1 prev_page: ' . ($firstPage->prevPage ?? 'null') . "\n";
  echo 'Page 1 next_page: ' . ($firstPage->nextPage ?? 'null') . "\n";

  // Advance: pass nextPage back as the `page` cursor to fetch page 2.
  $secondPage = $client->beta->sessions->list(
      agentID: $agent->id,
      limit: 1,
      page: $firstPage->nextPage,
  );
  foreach ($secondPage->getItems() as $listedSession) {
      echo "Page 2: {$listedSession->id}: {$listedSession->status}\n";
  }

  // Go back: page 2's prevPage is the cursor for the page before it.
  $previousPage = $client->beta->sessions->list(
      agentID: $agent->id,
      limit: 1,
      page: $secondPage->prevPage,
  );
  foreach ($previousPage->getItems() as $listedSession) {
      echo "Back to page 1: {$listedSession->id}: {$listedSession->status}\n";
  }
  // For forward-only iteration, $page->pagingEachItem() yields every session across pages.
  ```

  ```ruby Ruby
  first_page = client.beta.sessions.list(agent_id: agent.id, limit: 1)
  first_page.data.each do |listed_session|
    puts "#{listed_session.id}: #{listed_session.status}"
  end

  # `prev_page` is nil on the first page. The next-page cursor is exposed as
  # `next_page_` (trailing underscore) because plain `next_page` is the helper
  # method that fetches the next page object for you.
  puts "prev_page: #{first_page.prev_page.inspect}"
  puts "next_page: #{first_page.next_page_.inspect}"

  # Pass either cursor back as `page` to move through the list in both directions.
  second_page = client.beta.sessions.list(
    agent_id: agent.id,
    limit: 1,
    page: first_page.next_page_
  )
  back_to_first = client.beta.sessions.list(
    agent_id: agent.id,
    limit: 1,
    page: second_page.prev_page
  )
  back_to_first.data.each do |listed_session|
    puts "#{listed_session.id}: #{listed_session.status}"
  end
  # For forward-only iteration, page.auto_paging_each auto-follows next_page.
  ```
</CodeGroup>

## Archiving a session

Archive a session to prevent new events from being sent while preserving its history. A `running` session cannot be archived; to archive one, send a [`user.interrupt` event](https://platform.claude.com/docs/en/managed-agents/events-and-streaming#interrupt-the-agent) by itself and wait for the session to become `idle`. If a [workflow run](https://platform.claude.com/docs/en/managed-agents/workflow-runs#while-a-run-is-open) is open, archiving might return a 400 error, even when the session is `idle`, or it might succeed and end the run. Before you archive, send a `user.message` that [asks the agent to stop its runs](https://platform.claude.com/docs/en/managed-agents/workflow-runs#interrupt-a-session-with-runs-open), or wait until each run has ended. Then archive the session once it’s `idle`.

<CodeGroup>
  ```bash cURL
  curl -fsSL -X POST "https://api.anthropic.com/v1/sessions/$SESSION_ID/archive" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01"
  ```

  ```bash CLI
  ant beta:sessions archive --session-id "$SESSION_ID"
  ```

  ```python Python
  client.beta.sessions.archive(session.id)
  ```

  ```typescript TypeScript
  await client.beta.sessions.archive(session.id);
  ```

  ```csharp C#
  await client.Beta.Sessions.Archive(session.ID);
  ```

  ```go Go
  _, err = client.Beta.Sessions.Archive(ctx, session.ID, anthropic.BetaSessionArchiveParams{})
  if err != nil {
  	panic(err)
  }
  ```

  ```java Java
  client.beta().sessions().archive(session.id());
  ```

  ```php PHP
  $client->beta->sessions->archive($session->id);
  ```

  ```ruby Ruby
  client.beta.sessions.archive(session.id)
  ```
</CodeGroup>

## Deleting a session

Deleting a session is permanent. It deletes the session’s record, events, and associated sandbox. A `running` session cannot be deleted; to delete one, send a [`user.interrupt` event](https://platform.claude.com/docs/en/managed-agents/events-and-streaming#interrupt-the-agent) by itself and wait for the session to become `idle`. If a [workflow run](https://platform.claude.com/docs/en/managed-agents/workflow-runs#while-a-run-is-open) is open, deleting might return a 400 error, even when the session is `idle`, or it might succeed. After a delete that succeeds, no `workflow_run` event reports the end of the session’s runs. Before you delete, send a `user.message` that [asks the agent to stop its runs](https://platform.claude.com/docs/en/managed-agents/workflow-runs#interrupt-a-session-with-runs-open), or wait until each run has ended. Then delete the session once it’s `idle`.

Memory stores, vaults, skills, environments, and agents are independent resources and are not affected by session deletion. Files you uploaded through the Files API are also unaffected, but files the session itself produced are scoped to it and are permanently deleted along with its filesystem. Download anything you need to keep before deleting the session. An output file written at the end of the last turn can take a few seconds after the session goes idle to appear in the [session’s file list](https://platform.claude.com/docs/en/managed-agents/files#listing-and-downloading-session-files), so check that the files you expect are listed first.

<CodeGroup>
  ```bash cURL
  curl -fsSL -X DELETE "https://api.anthropic.com/v1/sessions/$SESSION_ID" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01"
  ```

  ```bash CLI
  ant beta:sessions delete --session-id "$SESSION_ID"
  ```

  ```python Python
  client.beta.sessions.delete(session.id)
  ```

  ```typescript TypeScript
  await client.beta.sessions.delete(session.id);
  ```

  ```csharp C#
  await client.Beta.Sessions.Delete(session.ID);
  ```

  ```go Go
  _, err = client.Beta.Sessions.Delete(ctx, session.ID, anthropic.BetaSessionDeleteParams{})
  if err != nil {
  	panic(err)
  }
  ```

  ```java Java
  client.beta().sessions().delete(session.id());
  ```

  ```php PHP
  $client->beta->sessions->delete($session->id);
  ```

  ```ruby Ruby
  client.beta.sessions.delete(session.id)
  ```
</CodeGroup>
