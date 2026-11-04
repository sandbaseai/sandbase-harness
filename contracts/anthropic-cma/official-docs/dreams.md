---
title: Dreams
url: https://platform.claude.com/docs/en/managed-agents/dreams
description: Let Claude review past sessions to curate an agent's memory and surface new insights.
featureMetadata:
  status: research-preview
  betaHeader: managed-agents-2026-04-01, dreaming-2026-04-21
  zdr:
    eligibility: not-eligible
    note: Sessions are stateful resources; transcripts persist until you delete them. Applies to all Managed Agents sub-features, including Self-hosted sandboxes.
  supportedModels:
    - claude-fable-5-1
    - claude-fable-5
    - claude-opus-5-5
    - claude-opus-5
    - claude-sonnet-5-5
    - claude-sonnet-5
    - claude-opus-4-8
    - claude-opus-4-7
    - claude-sonnet-4-6
  supportedPlatforms:
    Claude API: research-preview
---

<Note>
  Dreams are in research preview.

  * [Request access](https://claude.com/form/claude-managed-agents)
</Note>

Agents write to their [memory stores](https://platform.claude.com/docs/en/managed-agents/memory) as they work, but these writes are local and incremental: over many sessions a memory store accumulates duplicates, contradictions, and stale entries.

**Dreams** let Claude clean that up. A dream reads an existing memory store alongside past session transcripts, then produces a new, reorganized memory store: duplicates merged, stale or contradicted entries replaced with the latest value, and new insights surfaced.

The input store is never modified, so you can review the output and discard it if you don’t like the result.

## How it works

A **dream** is an asynchronous job that takes:

* a pre-existing **memory store:** the store Claude verifies, deduplicates, and reorganizes, and
* 1 to 100 **sessions:** past transcripts Claude mines for patterns and insights to fold into the output.

The dream produces another **output memory store**, separate from the input. The output store ID appears in the dream’s `outputs` (csharp, go: `Outputs`) array shortly after the dream starts `running`, once the workflow has cloned the input store; a `running` dream can briefly report an empty `outputs` (csharp, go: `Outputs`) array.

## Create a dream

<CodeGroup>
  ```bash cURL
  curl -s https://api.anthropic.com/v1/dreams \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01,dreaming-2026-04-21" \
    -H "content-type: application/json" \
    -d '{
      "inputs": [
        { "type": "memory_store", "memory_store_id": "'"$store_id"'" },
        { "type": "sessions", "session_ids": ["'"$session_a"'", "'"$session_b"'"] }
      ],
      "model": "claude-opus-5-5",
      "instructions": "Focus on coding-style preferences; ignore one-off debugging notes."
    }'
  ```

  ```bash CLI
  ant beta:dreams create <<YAML
  inputs:
    - type: memory_store
      memory_store_id: $store_id
    - type: sessions
      session_ids: [$session_a, $session_b]
  model: claude-opus-5-5
  instructions: Focus on coding-style preferences; ignore one-off debugging notes.
  YAML
  ```

  ```python Python
  dream = client.beta.dreams.create(
      inputs=[
          {"type": "memory_store", "memory_store_id": store_id},
          {"type": "sessions", "session_ids": [session_a, session_b]},
      ],
      model="claude-opus-5-5",
      instructions="Focus on coding-style preferences; ignore one-off debugging notes.",
  )
  print(dream.id)  # drm_01...
  ```

  ```typescript TypeScript
  let dream = await client.beta.dreams.create({
    inputs: [
      { type: "memory_store", memory_store_id: storeId },
      { type: "sessions", session_ids: [sessionA, sessionB] }
    ],
    model: "claude-opus-5-5",
    instructions: "Focus on coding-style preferences; ignore one-off debugging notes."
  });
  console.log(dream.id); // drm_01...
  ```

  ```csharp C#
  var dream = await client.Beta.Dreams.Create(new()
  {
      Inputs =
      [
          new BetaDreamMemoryStoreInput { MemoryStoreID = storeID },
          new BetaDreamSessionsInput { SessionIds = [sessionA, sessionB] },
      ],
      Model = "claude-opus-5-5",
      Instructions = "Focus on coding-style preferences; ignore one-off debugging notes.",
  });
  Console.WriteLine(dream.ID);  // drm_01...
  ```

  ```go Go
  dream, err := client.Beta.Dreams.New(ctx, anthropic.BetaDreamNewParams{
  	Inputs: []anthropic.BetaDreamInputUnionParam{
  		anthropic.BetaDreamInputParamOfMemoryStore(storeID),
  		anthropic.BetaDreamInputParamOfSessions([]string{sessionA, sessionB}),
  	},
  	Model: anthropic.BetaDreamNewParamsModelUnion{
  		OfString: anthropic.String("claude-opus-5-5"),
  	},
  	Instructions: anthropic.String("Focus on coding-style preferences; ignore one-off debugging notes."),
  })
  if err != nil {
  	panic(err)
  }
  fmt.Println(dream.ID) // drm_01...
  ```

  ```java Java
  var dream = client.beta().dreams().create(
      DreamCreateParams.builder()
          .addMemoryStoreInput(storeId)
          .addSessionsInput(List.of(sessionA, sessionB))
          .model("claude-opus-5-5")
          .instructions("Focus on coding-style preferences; ignore one-off debugging notes.")
          .build()
  );
  IO.println(dream.id());  // drm_01...
  ```

  ```php PHP
  $dream = $client->beta->dreams->create(
      inputs: [
          ['type' => 'memory_store', 'memory_store_id' => $storeId],
          ['type' => 'sessions', 'session_ids' => [$sessionA, $sessionB]],
      ],
      model: 'claude-opus-5-5',
      instructions: 'Focus on coding-style preferences; ignore one-off debugging notes.',
  );
  echo "{$dream->id}\n"; // drm_01...
  ```

  ```ruby Ruby
  dream = client.beta.dreams.create(
    inputs: [
      {type: "memory_store", memory_store_id: store_id},
      {type: "sessions", session_ids: [session_a, session_b]}
    ],
    model: "claude-opus-5-5",
    instructions: "Focus on coding-style preferences; ignore one-off debugging notes."
  )
  puts dream.id # drm_01...
  ```
</CodeGroup>

Dreaming inputs include the pre-existing memory store and an array of sessions. The model you choose runs the dreaming pipeline. Only [select models](https://platform.claude.com/docs/en/managed-agents/dreams#feature-availability) are supported. You can optionally pass `instructions` (csharp, go: `Instructions`) to steer the dreaming process. See [Steer with instructions](https://platform.claude.com/docs/en/managed-agents/dreams#steer-with-instructions).

The response is the full `dream` resource with `status: "pending"`:

```json
{
  "type": "dream",
  "id": "drm_01AbCDefGhIjKlMnOpQrStUv",
  "status": "pending",
  "inputs": [
    { "type": "memory_store", "memory_store_id": "memstore_01Hx..." },
    { "type": "sessions", "session_ids": ["sesn_01...", "sesn_02..."] }
  ],
  "outputs": [],
  "model": { "id": "claude-opus-5-5" },
  "instructions": "Focus on coding-style preferences; ignore one-off debugging notes.",
  "session_id": null,
  "created_at": "2026-04-29T17:04:10Z",
  "ended_at": null,
  "archived_at": null,
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_read_input_tokens": 0,
    "cache_creation_input_tokens": 0
  },
  "error": null
}
```

<Tip>
  If you only have session transcripts and no existing store, [create an empty memory store](https://platform.claude.com/docs/en/managed-agents/memory#create-a-memory-store) first and pass it as the `memory_store` input.
</Tip>

### Steer with instructions

The optional `instructions` (csharp, go: `Instructions`) field steers what the dreaming pipeline synthesizes. It is applied throughout the pipeline: what to read closely, what to merge or drop, and how to structure the output store.

Use `instructions` (csharp, go: `Instructions`) for high-level synthesis guidance such as focus areas (“focus on coding-style preferences”), content to preserve unchanged, or output conventions you want applied across the store. The pipeline is a synthesis pass over the inputs, not an editor applied to the text of the store, so imperative directives that target specific lines (“change sentence X to Y,” “fix the count in section Z”) generally produce no change. To make targeted edits to individual memories, use the [Memory Stores API](https://platform.claude.com/docs/en/managed-agents/memory#view-and-edit-memories) on the output store directly.

## Track progress

Dreams run asynchronously and typically take minutes to a few hours, driven by the number of input transcripts. Poll the dream by ID to check status:

<CodeGroup>
  ```bash cURL
  curl -s "https://api.anthropic.com/v1/dreams/$dream_id" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01,dreaming-2026-04-21"
  ```

  ```bash CLI
  ant beta:dreams retrieve --dream-id "$dream_id"
  ```

  ```python Python
  while dream.status in ("pending", "running"):
      time.sleep(10)
      dream = client.beta.dreams.retrieve(dream.id)
      print(f"status={dream.status} input_tokens={dream.usage.input_tokens}")
  ```

  ```typescript TypeScript
  while (dream.status === "pending" || dream.status === "running") {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    dream = await client.beta.dreams.retrieve(dream.id);
    console.log(`status=${dream.status} input_tokens=${dream.usage.input_tokens}`);
  }
  ```

  ```csharp C#
  while (dream.Status.Value() is BetaDreamStatus.Pending or BetaDreamStatus.Running)
  {
      await Task.Delay(TimeSpan.FromSeconds(10));
      dream = await client.Beta.Dreams.Retrieve(dream.ID);
      Console.WriteLine($"status={dream.Status.Raw()} input_tokens={dream.Usage.InputTokens}");
  }
  ```

  ```go Go
  for dream.Status == anthropic.BetaDreamStatusPending || dream.Status == anthropic.BetaDreamStatusRunning {
  	time.Sleep(10 * time.Second)
  	dream, err = client.Beta.Dreams.Get(ctx, dream.ID, anthropic.BetaDreamGetParams{})
  	if err != nil {
  		panic(err)
  	}
  	fmt.Printf("status=%s input_tokens=%d\n", dream.Status, dream.Usage.InputTokens)
  }
  ```

  ```java Java
  while (dream.status().equals(BetaDreamStatus.PENDING)
          || dream.status().equals(BetaDreamStatus.RUNNING)) {
      Thread.sleep(10_000);
      dream = client.beta().dreams().retrieve(dream.id());
      IO.println("status=" + dream.status() + " input_tokens=" + dream.usage().inputTokens());
  }
  ```

  ```php PHP
  while (in_array($dream->status, [BetaDreamStatus::PENDING->value, BetaDreamStatus::RUNNING->value], true)) {
      sleep(10);
      $dream = $client->beta->dreams->retrieve($dream->id);
      echo "status={$dream->status} input_tokens={$dream->usage->inputTokens}\n";
  }
  ```

  ```ruby Ruby
  while %i[pending running].include?(dream.status)
    sleep 10
    dream = client.beta.dreams.retrieve(dream.id)
    puts "status=#{dream.status} input_tokens=#{dream.usage.input_tokens}"
  end
  ```
</CodeGroup>

### Lifecycle

| `status` (csharp, go: `Status`) | Meaning                                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `pending`                       | Dream successfully created and queued.                                                                            |
| `running`                       | The pipeline is processing. `usage` (csharp, go: `Usage`) updates as work progresses.                             |
| `completed`                     | Finished successfully. The `outputs` (csharp, go: `Outputs`) value is the new memory store.                       |
| `failed`                        | Dreaming run ended with an error. The output memory store is left as-is with whatever was written before failure. |
| `canceled`                      | Dreaming run canceled. The output memory store is left as-is.                                                     |

### Watch the pipeline run

Once a dream is `running`, its `session_id` (java: `sessionId`; php: `sessionID`; csharp, go: `SessionID`) field points at the underlying [session](https://platform.claude.com/docs/en/managed-agents/sessions) running the pipeline. You can stream that session’s [events](https://platform.claude.com/docs/en/managed-agents/events-and-streaming) to observe what the dream is reading and writing in real time. The session is archived (not deleted) when the dream reaches a terminal state, so the transcript remains available afterward.

## Use the output

When `status` (csharp, go: `Status`) reaches `completed`, the `memory_store` entry in `outputs` (csharp, go: `Outputs`) references a fully populated store. It’s an ordinary memory store in your workspace. Review it with the [Memory Stores API](https://platform.claude.com/docs/en/managed-agents/memory#view-and-edit-memories) or in the Claude Console, then either:

* **Use it:** attach it to future sessions as a `memory_store` resource in place of (or alongside) the input memory store, or
* **Discard it:** [delete the memory store](https://platform.claude.com/docs/en/api/beta/memory_stores/delete) or [archive the memory store](https://platform.claude.com/docs/en/api/beta/memory_stores/archive).

<CodeGroup>
  ```bash cURL
  # $output_store_id is the memory_store_id of the completed dream's memory_store output
  curl -s https://api.anthropic.com/v1/sessions \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "agent": "'"$agent_id"'",
      "environment_id": "'"$environment_id"'",
      "resources": [
        { "type": "memory_store", "memory_store_id": "'"$output_store_id"'" }
      ]
    }'
  ```

  ```bash CLI
  # $output_store_id is the memory_store_id of the completed dream's memory_store output
  ant beta:sessions create <<YAML
  agent: $agent_id
  environment_id: $environment_id
  resources:
    - type: memory_store
      memory_store_id: $output_store_id
  YAML
  ```

  ```python Python
  # After the dream ends, the output holds the rebuilt memory store
  output_store_id = next(
      output.memory_store_id for output in dream.outputs if output.type == "memory_store"
  )

  session = client.beta.sessions.create(
      agent=agent_id,
      environment_id=environment_id,
      resources=[
          {"type": "memory_store", "memory_store_id": output_store_id},
      ],
  )
  ```

  ```typescript TypeScript
  // After the dream ends, the output holds the rebuilt memory store
  const output = dream.outputs.find((entry) => entry.type === "memory_store");
  const outputStoreId = output!.memory_store_id;

  await client.beta.sessions.create({
    agent: agentId,
    environment_id: environmentId,
    resources: [{ type: "memory_store", memory_store_id: outputStoreId }]
  });
  ```

  ```csharp C#
  var output = dream.Outputs.FirstOrDefault(entry => entry.Type.GetString() == "memory_store");
  if (output is { MemoryStoreID: var outputStoreID })
  {
      await client.Beta.Sessions.Create(new()
      {
          Agent = agentID,
          EnvironmentID = environmentID,
          Resources =
          [
              new BetaManagedAgentsMemoryStoreResourceParam { MemoryStoreID = outputStoreID },
          ],
      });
  }
  ```

  ```go Go
  for _, output := range dream.Outputs {
  	if output.Type != "memory_store" {
  		continue
  	}
  	outputStoreID := output.MemoryStoreID

  	session, err := client.Beta.Sessions.New(ctx, anthropic.BetaSessionNewParams{
  		Agent: anthropic.BetaSessionNewParamsAgentUnion{
  			OfString: anthropic.String(agentID),
  		},
  		EnvironmentID: environmentID,
  		Resources: []anthropic.BetaSessionNewParamsResourceUnion{{
  			OfMemoryStore: &anthropic.BetaManagedAgentsMemoryStoreResourceParam{
  				MemoryStoreID: outputStoreID,
  			},
  		}},
  	})
  	if err != nil {
  		panic(err)
  	}
  	fmt.Println(session.ID)
  	break
  }
  ```

  ```java Java
  var output = dream.outputs().stream()
      .filter(entry -> entry._type().equals(JsonValue.from("memory_store")))
      .findFirst();
  if (output.isPresent()) {
      var outputStoreId = output.get().memoryStoreId();

      var session = client.beta().sessions().create(
          SessionCreateParams.builder()
              .agent(agentId)
              .environmentId(environmentId)
              .addMemoryStoreResource(outputStoreId)
              .build()
      );
  }
  ```

  ```php PHP
  $matches = array_filter($dream->outputs, fn($output) => $output->type === 'memory_store');
  $output = $matches ? reset($matches) : null;
  if ($output !== null) {
      $session = $client->beta->sessions->create(
          agent: $agentId,
          environmentID: $environmentId,
          resources: [
              ['type' => 'memory_store', 'memory_store_id' => $output->memoryStoreID],
          ],
      );
  }
  ```

  ```ruby Ruby
  output = dream.outputs.find { it.type == :memory_store }
  if output
    client.beta.sessions.create(
      agent: agent_id,
      environment_id: environment_id,
      resources: [
        {type: "memory_store", memory_store_id: output.memory_store_id}
      ]
    )
  end
  ```
</CodeGroup>

The dream itself never deletes or modifies its inputs. On `failed` or `canceled` the output store persists with partial contents so you can inspect what was produced before stopping; clean it up through the Memory Stores API if you don’t need it.

<Warning>
  While a dream is `pending` or `running`, the 400 guard applies to archiving the dream itself, not its stores. Archiving or deleting an *input* memory store mid-run (or deleting an input session) will cause the dream to fail with `input_memory_store_unavailable` or `input_session_unavailable`.
</Warning>

## Cancel a dream

Cancel moves a `pending` or `running` dream to `canceled` immediately. Canceling an already-`canceled` dream is an idempotent no-op; canceling a `completed` or `failed` dream returns 400.

<Note>
  After cancellation, the dream’s `usage` (csharp, go: `Usage`) fields might continue to update for a few seconds while in-flight work winds down. Poll the dream until `usage` (csharp, go: `Usage`) stabilizes if you need the final count.
</Note>

<CodeGroup>
  ```bash cURL
  curl -s -X POST "https://api.anthropic.com/v1/dreams/$dream_id/cancel" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01,dreaming-2026-04-21"
  ```

  ```bash CLI
  ant beta:dreams cancel --dream-id "$dream_id"
  ```

  ```python Python
  client.beta.dreams.cancel(dream.id)
  ```

  ```typescript TypeScript
  await client.beta.dreams.cancel(dream.id);
  ```

  ```csharp C#
  await client.Beta.Dreams.Cancel(dream.ID);
  ```

  ```go Go
  dream, err = client.Beta.Dreams.Cancel(ctx, dream.ID, anthropic.BetaDreamCancelParams{})
  if err != nil {
  	panic(err)
  }
  ```

  ```java Java
  client.beta().dreams().cancel(dream.id());
  ```

  ```php PHP
  $client->beta->dreams->cancel($dream->id);
  ```

  ```ruby Ruby
  client.beta.dreams.cancel(dream.id)
  ```
</CodeGroup>

## Archive a dream

Archive sets `archived_at` (java, php: `archivedAt`; csharp, go: `ArchivedAt`) on a dream that has reached a terminal state (`completed`, `failed`, or `canceled`); `status` (csharp, go: `Status`) is left unchanged. Archived dreams are excluded from default list responses but remain readable by ID. Archiving an already-archived dream is an idempotent no-op. Archiving a `pending` or `running` dream returns 400; cancel it first. There is no unarchive.

<CodeGroup>
  ```bash cURL
  curl -s -X POST "https://api.anthropic.com/v1/dreams/$dream_id/archive" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01,dreaming-2026-04-21"
  ```

  ```bash CLI
  ant beta:dreams archive --dream-id "$dream_id"
  ```

  ```python Python
  client.beta.dreams.archive(dream.id)
  ```

  ```typescript TypeScript
  await client.beta.dreams.archive(dream.id);
  ```

  ```csharp C#
  await client.Beta.Dreams.Archive(dream.ID);
  ```

  ```go Go
  dream, err = client.Beta.Dreams.Archive(ctx, dream.ID, anthropic.BetaDreamArchiveParams{})
  if err != nil {
  	panic(err)
  }
  ```

  ```java Java
  client.beta().dreams().archive(dream.id());
  ```

  ```php PHP
  $client->beta->dreams->archive($dream->id);
  ```

  ```ruby Ruby
  client.beta.dreams.archive(dream.id)
  ```
</CodeGroup>

Archiving a dream does not touch its output memory store; manage that separately through the [Memory Stores API](https://platform.claude.com/docs/en/managed-agents/memory#view-and-edit-memories).

## List dreams

Returns all non-archived dreams in the workspace, newest first. Use `limit` (csharp, go: `Limit`) (default 20, max 100) and the `page` (csharp, go: `Page`) cursor to paginate. Set `include_archived` (java, php: `includeArchived`; csharp, go: `IncludeArchived`) to `true` to include archived dreams.

<CodeGroup>
  ```bash cURL
  curl -s "https://api.anthropic.com/v1/dreams?limit=20" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01,dreaming-2026-04-21"
  ```

  ```bash CLI
  ant beta:dreams list --limit 20
  ```

  ```python Python
  for listed_dream in client.beta.dreams.list(limit=20):
      print(listed_dream.id, listed_dream.status)
  ```

  ```typescript TypeScript
  for await (const listedDream of client.beta.dreams.list({ limit: 20 })) {
    console.log(listedDream.id, listedDream.status);
  }
  ```

  ```csharp C#
  var page = await client.Beta.Dreams.List(new() { Limit = 20 });
  await foreach (var listed in page.Paginate())
  {
      Console.WriteLine($"{listed.ID} {listed.Status.Raw()}");
  }
  ```

  ```go Go
  dreams := client.Beta.Dreams.ListAutoPaging(ctx, anthropic.BetaDreamListParams{
  	Limit: anthropic.Int(20),
  })
  for dreams.Next() {
  	listed := dreams.Current()
  	fmt.Println(listed.ID, listed.Status)
  }
  if err := dreams.Err(); err != nil {
  	panic(err)
  }
  ```

  ```java Java
  for (var listedDream : client.beta().dreams().list(
      DreamListParams.builder()
          .limit(20)
          .build()
  ).autoPager()) {
      IO.println(listedDream.id() + " " + listedDream.status());
  }
  ```

  ```php PHP
  foreach ($client->beta->dreams->list(limit: 20)->pagingEachItem() as $dream) {
      echo "{$dream->id} {$dream->status}\n";
  }
  ```

  ```ruby Ruby
  client.beta.dreams.list(limit: 20).auto_paging_each do
    puts "#{it.id} #{it.status}"
  end
  ```
</CodeGroup>

## Errors

A non-exhaustive list of possible dreaming errors follows.

| `error.type`                      | When                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `timeout`                         | The pipeline exceeded its runtime budget.                                                       |
| `internal_error`                  | Unclassified pipeline failure.                                                                  |
| `memory_store_org_limit_exceeded` | Your organization hit its memory-store cap while the pipeline was provisioning working storage. |
| `input_memory_store_too_large`    | The input memory store exceeds the pipeline’s size limit.                                       |
| `input_memory_store_unavailable`  | The input memory store was archived or deleted after the dream was created.                     |
| `input_session_unavailable`       | An input session was deleted after the dream was created.                                       |

## Billing

Dreams are billed at standard API token rates for the model you select; `usage` (csharp, go: `Usage`) on the resource reports the exact totals. Cost scales roughly linearly with the number and length of input sessions. Start with a small batch of sessions and scale up once you’re satisfied with the curation quality.

## Limits

Default rate limits apply to dream creation while this feature is in research preview. [Contact support](https://support.claude.com) if you need higher limits.

## Availability

Dreams are in research preview on select models.

### API support

#### [Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview)

* Availability: Available

| Status           | Cloud platforms | Models                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Research preview | Claude API      | [Claude Fable 5.1](https://platform.claude.com/docs/en/models/fable-5-1/overview), [Claude Fable 5](https://platform.claude.com/docs/en/models/fable-5/overview), [Claude Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/overview), [Claude Opus 5](https://platform.claude.com/docs/en/models/opus-5/overview), [Claude Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/overview), [Claude Sonnet 5](https://platform.claude.com/docs/en/models/sonnet-5/overview), [Claude Opus 4.8](https://platform.claude.com/docs/en/models/opus-4-8/overview), [Claude Opus 4.7](https://platform.claude.com/docs/en/models/opus-4-7/overview), [Claude Sonnet 4.6](https://platform.claude.com/docs/en/models/sonnet-4-6/overview) |

### Required beta headers

[Beta headers overview](https://platform.claude.com/docs/en/api/beta-headers)

Beta headers allow you to access experimental features and new model capabilities before they become part of the standard API.

* `managed-agents-2026-04-01`
* `dreaming-2026-04-21`

Dream endpoints require the `dreaming-2026-04-21` beta header. The `managed-agents-2026-04-01` header on its own doesn’t grant access to dreams. Session calls use `managed-agents-2026-04-01`, and memory store calls use `agent-memory-2026-07-22`. The SDK sets the right header on each call.

### Data handling

[Data handling overview](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention#feature-eligibility)

| Item    | Zero data retention                                                                                                                                      | HIPAA                                                                        |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Status  | Not eligible                                                                                                                                             | Not eligible                                                                 |
| Details | Sessions are stateful resources; transcripts persist until you delete them. Applies to all Managed Agents sub-features, including Self-hosted sandboxes. | Applies to all Managed Agents sub-features, including Self-hosted sandboxes. |

Applicable endpoints:

* `/v1/agents`
* `/v1/sessions`
* `/v1/environments`
