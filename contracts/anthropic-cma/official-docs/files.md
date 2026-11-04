---
title: Adding files
url: https://platform.claude.com/docs/en/managed-agents/files
description: Upload files and mount them in your sandbox for reading and processing.
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

You can provide files to your agent by uploading them through the Files API and mounting them in the session’s sandbox.

## Uploading files

First, upload a file using the [Files API](https://platform.claude.com/docs/en/build-with-claude/files):

<CodeGroup>
  ```bash cURL
  curl --fail-with-body -sS https://api.anthropic.com/v1/files \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -F file=@data.csv
  ```

  ```bash CLI
  ant files upload --file data.csv
  ```

  ```python Python
  file = client.files.upload(file=Path("data.csv"))
  print(f"File ID: {file.id}")
  ```

  ```typescript TypeScript
  const file = await client.files.upload({
    file: await toFile(readFile("data.csv"), "data.csv", { type: "text/csv" })
  });
  console.log(`File ID: ${file.id}`);
  ```

  ```csharp C#
  await using var stream = File.OpenRead(csvPath);
  var file = await client.Files.Upload(new() { File = stream });
  Console.WriteLine($"File ID: {file.ID}");
  ```

  ```go Go
  csvFile, err := os.Open("data.csv")
  if err != nil {
  	panic(err)
  }
  defer csvFile.Close()

  file, err := client.Files.Upload(ctx, anthropic.FileUploadParams{
  	File: csvFile,
  })
  if err != nil {
  	panic(err)
  }
  fmt.Printf("File ID: %s\n", file.ID)
  ```

  ```java Java
  var file = client.files().upload(
      FileUploadParams.builder()
          .file(dataCsv)
          .build()
  );
  IO.println("File ID: " + file.id());
  ```

  ```php PHP
  $file = $client->files->upload(
      file: FileParam::fromResource(fopen($csvPath, 'r'), filename: 'data.csv', contentType: 'text/csv'),
  );
  echo "File ID: {$file->id}\n";
  ```

  ```ruby Ruby
  file = client.files.upload(file: Pathname(csv_path))
  puts "File ID: #{file.id}"
  ```
</CodeGroup>

## Mounting files in a session

Mount uploaded files into the sandbox by adding them to the `resources` (csharp, go: `Resources`) array when creating a session:

<Tip>
  The `mount_path` (java, php: `mountPath`; csharp, go: `MountPath`) is optional, but make sure the uploaded file has a descriptive name so the agent can identify it.
</Tip>

<CodeGroup>
  ```bash cURL
  curl --fail-with-body -sS https://api.anthropic.com/v1/sessions \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "agent": "'"$AGENT_ID"'",
      "environment_id": "'"$ENVIRONMENT_ID"'",
      "resources": [
        {
          "type": "file",
          "file_id": "'"$FILE_ID"'",
          "mount_path": "/data.csv"
        }
      ]
    }'
  ```

  ```bash CLI
  ant beta:sessions create \
    --agent "$AGENT_ID" \
    --environment-id "$ENVIRONMENT_ID" <<EOF
  resources:
    - type: file
      file_id: $FILE_ID
      mount_path: /data.csv
  EOF
  ```

  ```python Python
  session = client.beta.sessions.create(
      agent=agent.id,
      environment_id=environment.id,
      resources=[
          {
              "type": "file",
              "file_id": file.id,
              "mount_path": "/data.csv",
          },
      ],
  )
  ```

  ```typescript TypeScript
  const session = await client.beta.sessions.create({
    agent: agent.id,
    environment_id: environment.id,
    resources: [
      {
        type: "file",
        file_id: file.id,
        mount_path: "/data.csv"
      }
    ]
  });
  ```

  ```csharp C#
  var session = await client.Beta.Sessions.Create(new()
  {
      Agent = agent.ID,
      EnvironmentID = environment.ID,
      Resources =
      [
          new BetaManagedAgentsFileResourceParams
          {
              FileID = file.ID,
              MountPath = "/data.csv",
          },
      ],
  });
  ```

  ```go Go
  session, err := client.Beta.Sessions.New(ctx, anthropic.BetaSessionNewParams{
  	Agent: anthropic.BetaSessionNewParamsAgentUnion{
  		OfString: anthropic.String(agent.ID),
  	},
  	EnvironmentID: environment.ID,
  	Resources: []anthropic.BetaSessionNewParamsResourceUnion{{
  		OfFile: &anthropic.BetaManagedAgentsFileResourceParams{
  			FileID:    file.ID,
  			MountPath: anthropic.String("/data.csv"),
  		},
  	}},
  })
  if err != nil {
  	panic(err)
  }
  ```

  ```java Java
  var session = client.beta().sessions().create(
      SessionCreateParams.builder()
          .agent(agent.id())
          .environmentId(environment.id())
          .addResource(
              BetaManagedAgentsFileResourceParams.builder()
                  .fileId(file.id())
                  .mountPath("/data.csv")
                  .build()
          )
          .build()
  );
  ```

  ```php PHP
  $session = $client->beta->sessions->create(
      agent: $agent->id,
      environmentID: $environment->id,
      resources: [
          BetaManagedAgentsFileResourceParams::with(
              fileID: $file->id,
              mountPath: '/data.csv',
          ),
      ],
  );
  ```

  ```ruby Ruby
  session = client.beta.sessions.create(
    agent: agent.id,
    environment_id: environment.id,
    resources: [
      {
        type: "file",
        file_id: file.id,
        mount_path: "/data.csv"
      }
    ]
  )
  ```
</CodeGroup>

With the preceding `mount_path` (java, php: `mountPath`; csharp, go: `MountPath`), the agent reads the file at `/mnt/session/uploads/data.csv` (see [File paths](https://platform.claude.com/docs/en/managed-agents/files#file-paths)).

A new `file_id` (java: `fileId`; php: `fileID`; csharp, go: `FileID`) is created that references the instance of the file in the session. These copies do not count against your [storage limits](https://platform.claude.com/docs/en/build-with-claude/files).

## Multiple files

Mount multiple files by adding entries to the `resources` (csharp, go: `Resources`) array:

<CodeGroup>
  ```bash cURL
  curl -fsSL https://api.anthropic.com/v1/sessions \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "agent": "agent_01J8XkN5uT3vHpLqRfWdY2",
      "environment_id": "env_01K2mPsT7hNwR4jXuLvCqD8",
      "resources": [
        {
          "type": "file",
          "file_id": "file_011CNha8iCJcU1wXNR6q4V8w",
          "mount_path": "/data.csv"
        },
        {
          "type": "file",
          "file_id": "file_011CPMxVD3fHLUhvTqtsQA5w",
          "mount_path": "/config.json"
        },
        {
          "type": "file",
          "file_id": "file_011CRb3kQ7tWx9ZsLmDe2Vh4",
          "mount_path": "/src/main.py"
        }
      ]
    }'
  ```

  ```bash CLI
  ant beta:sessions create \
    --agent agent_01J8XkN5uT3vHpLqRfWdY2 \
    --environment-id env_01K2mPsT7hNwR4jXuLvCqD8 <<YAML
  resources:
    - type: file
      file_id: file_011CNha8iCJcU1wXNR6q4V8w
      mount_path: /data.csv
    - type: file
      file_id: file_011CPMxVD3fHLUhvTqtsQA5w
      mount_path: /config.json
    - type: file
      file_id: file_011CRb3kQ7tWx9ZsLmDe2Vh4
      mount_path: /src/main.py
  YAML
  ```

  ```python Python
  resources = [
      {"type": "file", "file_id": "file_abc123", "mount_path": "/data.csv"},
      {"type": "file", "file_id": "file_def456", "mount_path": "/config.json"},
      {"type": "file", "file_id": "file_ghi789", "mount_path": "/src/main.py"},
  ]
  ```

  ```typescript TypeScript
  resources: [
    { type: "file", file_id: "file_abc123", mount_path: "/data.csv" },
    { type: "file", file_id: "file_def456", mount_path: "/config.json" },
    { type: "file", file_id: "file_ghi789", mount_path: "/src/main.py" }
  ]
  ```

  ```csharp C#
  using Anthropic.Models.Beta.Sessions;

  var resources = new[]
  {
      new BetaManagedAgentsFileResourceParams { FileID = "file_abc123", MountPath = "/data.csv" },
      new BetaManagedAgentsFileResourceParams { FileID = "file_def456", MountPath = "/config.json" },
      new BetaManagedAgentsFileResourceParams { FileID = "file_ghi789", MountPath = "/src/main.py" },
  };
  ```

  ```go Go
  resources := []anthropic.BetaSessionNewParamsResourceUnion{
  	{OfFile: &anthropic.BetaManagedAgentsFileResourceParams{Type: "file", FileID: "file_abc123", MountPath: anthropic.String("/data.csv")}},
  	{OfFile: &anthropic.BetaManagedAgentsFileResourceParams{Type: "file", FileID: "file_def456", MountPath: anthropic.String("/config.json")}},
  	{OfFile: &anthropic.BetaManagedAgentsFileResourceParams{Type: "file", FileID: "file_ghi789", MountPath: anthropic.String("/src/main.py")}},
  }
  ```

  ```java Java
  import com.anthropic.models.beta.sessions.*;
  import java.util.List;

  var resources = List.of(
      BetaManagedAgentsFileResourceParams.builder()
          .fileId("file_abc123")
          .mountPath("/data.csv")
          .build(),
      BetaManagedAgentsFileResourceParams.builder()
          .fileId("file_def456")
          .mountPath("/config.json")
          .build(),
      BetaManagedAgentsFileResourceParams.builder()
          .fileId("file_ghi789")
          .mountPath("/src/main.py")
          .build()
  );
  ```

  ```php PHP
  $resources = [
      ['type' => 'file', 'fileID' => 'file_abc123', 'mountPath' => '/data.csv'],
      ['type' => 'file', 'fileID' => 'file_def456', 'mountPath' => '/config.json'],
      ['type' => 'file', 'fileID' => 'file_ghi789', 'mountPath' => '/src/main.py'],
  ];
  ```

  ```ruby Ruby
  resources = [
    {type: "file", file_id: "file_abc123", mount_path: "/data.csv"},
    {type: "file", file_id: "file_def456", mount_path: "/config.json"},
    {type: "file", file_id: "file_ghi789", mount_path: "/src/main.py"}
  ]
  ```
</CodeGroup>

A maximum of 500 files is supported for each session.

## Managing files on a running session

You can add or remove files from a session after creation using the session resources API. Each resource has an `id` (csharp, go: `ID`) returned when it is added (or listed), which you use for deletes.

<CodeGroup>
  ```bash cURL
  curl --fail-with-body -sS "https://api.anthropic.com/v1/sessions/$SESSION_ID/resources" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01" \
    -H "content-type: application/json" \
    -d '{
      "type": "file",
      "file_id": "'"$FILE_ID"'"
    }'
  ```

  ```bash CLI
  ant beta:sessions:resources add \
    --session-id "$SESSION_ID" \
    --type file \
    --file-id "$FILE_ID"
  ```

  ```python Python
  resource = client.beta.sessions.resources.add(
      session.id,
      type="file",
      file_id=file.id,
  )
  print(resource.id)  # "sesrsc_01ABC..."
  ```

  ```typescript TypeScript
  const resource = await client.beta.sessions.resources.add(session.id, {
    type: "file",
    file_id: file.id
  });
  if (resource.type !== "file") {
    throw new Error(`Unexpected resource type: ${resource.type}`);
  }
  console.log(resource.id); // "sesrsc_01ABC..."
  ```

  ```csharp C#
  var resource = await client.Beta.Sessions.Resources.Add(session.ID, new()
  {
      FileID = file.ID,
  });
  Console.WriteLine(resource.ID);  // "sesrsc_01ABC..."
  ```

  ```go Go
  resource, err := client.Beta.Sessions.Resources.Add(ctx, session.ID, anthropic.BetaSessionResourceAddParams{
  	BetaManagedAgentsFileResourceParams: anthropic.BetaManagedAgentsFileResourceParams{
  		FileID: file.ID,
  	},
  })
  if err != nil {
  	panic(err)
  }
  fmt.Println(resource.ID) // "sesrsc_01ABC..."
  ```

  ```java Java
  var resource = client.beta().sessions().resources().add(
      session.id(),
      ResourceAddParams.builder()
          .betaManagedAgentsFileResourceParams(
              BetaManagedAgentsFileResourceParams.builder()
                  .fileId(file.id())
                  .build()
          )
          .build()
  );
  IO.println(resource.id()); // "sesrsc_01ABC..."
  ```

  ```php PHP
  $resource = $client->beta->sessions->resources->add(
      $session->id,
      fileID: $file->id,
  );
  echo "{$resource->id}\n";  // "sesrsc_01ABC..."
  ```

  ```ruby Ruby
  resource = client.beta.sessions.resources.add(
    session.id,
    type: "file",
    file_id: file.id
  )
  puts resource.id # "sesrsc_01ABC..."
  ```
</CodeGroup>

List all resources on a session with `GET /v1/sessions/{session_id}/resources` (python, typescript, ruby: `client.beta.sessions.resources.list()`; go, csharp: `client.Beta.Sessions.Resources.List()`; java: `client.beta().sessions().resources().list()`; php: `$client->beta->sessions->resources->list()`; cli: `ant beta:sessions:resources list`). To remove a file, call `DELETE /v1/sessions/{session_id}/resources/{resource_id}` (python, typescript, ruby: `client.beta.sessions.resources.delete()`; go, csharp: `client.Beta.Sessions.Resources.Delete()`; java: `client.beta().sessions().resources().delete()`; php: `$client->beta->sessions->resources->delete()`; cli: `ant beta:sessions:resources delete`) with the resource ID:

<CodeGroup>
  ```bash cURL
  curl --fail-with-body -sS "https://api.anthropic.com/v1/sessions/$SESSION_ID/resources" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01"

  curl --fail-with-body -sS -X DELETE "https://api.anthropic.com/v1/sessions/$SESSION_ID/resources/$RESOURCE_ID" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01"
  ```

  ```bash CLI
  ant beta:sessions:resources list --session-id "$SESSION_ID"

  ant beta:sessions:resources delete \
    --session-id "$SESSION_ID" \
    --resource-id "$RESOURCE_ID"
  ```

  ```python Python
  listed = client.beta.sessions.resources.list(session.id)
  for entry in listed.data:
      print(entry.id, entry.type)

  client.beta.sessions.resources.delete(resource.id, session_id=session.id)
  ```

  ```typescript TypeScript
  const listed = await client.beta.sessions.resources.list(session.id);
  for (const entry of listed.data) {
    if (entry.type !== "memory_store") {
      console.log(entry.id, entry.type);
    }
  }

  await client.beta.sessions.resources.delete(resource.id, {
    session_id: session.id
  });
  ```

  ```csharp C#
  var listed = await client.Beta.Sessions.Resources.List(session.ID);
  await foreach (var entry in listed.Paginate())
  {
      Console.WriteLine($"{entry.ID} {entry.Type.Raw()}");
  }

  await client.Beta.Sessions.Resources.Delete(resource.ID, new() { SessionID = session.ID });
  ```

  ```go Go
  listed, err := client.Beta.Sessions.Resources.List(ctx, session.ID, anthropic.BetaSessionResourceListParams{})
  if err != nil {
  	panic(err)
  }
  for _, entry := range listed.Data {
  	fmt.Println(entry.ID, entry.Type)
  }

  if _, err := client.Beta.Sessions.Resources.Delete(ctx, resource.ID, anthropic.BetaSessionResourceDeleteParams{
  	SessionID: session.ID,
  }); err != nil {
  	panic(err)
  }
  ```

  ```java Java
  var listed = client.beta().sessions().resources().list(session.id());
  for (var entry : listed.data()) {
      switch (entry.type().value()) {
          case FILE -> {
              var fileResource = entry.asFile();
              IO.println(fileResource.id() + " " + fileResource._type());
          }
          case GITHUB_REPOSITORY -> {
              var repoResource = entry.asGitHubRepository();
              IO.println(repoResource.id() + " " + repoResource._type());
          }
      }
  }

  client.beta().sessions().resources().delete(
      resource.id(),
      ResourceDeleteParams.builder()
          .sessionId(session.id())
          .build()
  );
  ```

  ```php PHP
  $listed = $client->beta->sessions->resources->list($session->id);
  foreach ($listed->data as $entry) {
      echo "{$entry->id} {$entry->type}\n";
  }

  $client->beta->sessions->resources->delete($resource->id, sessionID: $session->id);
  ```

  ```ruby Ruby
  listed = client.beta.sessions.resources.list(session.id)
  listed.data.each { puts "#{it.id} #{it.type}" }

  client.beta.sessions.resources.delete(resource.id, session_id: session.id)
  ```
</CodeGroup>

## Listing and downloading session files

Use the [Files API](https://platform.claude.com/docs/en/build-with-claude/files) to list files scoped to a session and download them. Files the agent writes to `/mnt/session/outputs/` appear in the list shortly after the agent finishes writing them, sometimes a few seconds after the session goes idle. If an output file you expect is missing, list again after a short delay; once it appears in the list, its upload is complete.

Filtering by `scope_id` (java: `scopeId`; php: `scopeID`; csharp, go: `ScopeID`) requires the `managed-agents-2026-04-01` beta header, so the list examples call `GET /v1/files` (python, typescript, ruby: `client.beta.files.list()`; go, csharp: `client.Beta.Files.List()`; java: `client.beta().files().list()`; php: `$client->beta->files->list()`; cli: `ant beta:files list`) and pass that header explicitly.

<CodeGroup>
  ```bash cURL
  # List files associated with a session
  curl -fsSL "https://api.anthropic.com/v1/files?scope_id=sesn_abc123" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01"

  # Download a file
  curl -fsSL "https://api.anthropic.com/v1/files/$FILE_ID/content" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -o output.txt
  ```

  ```bash CLI
  # List files associated with a session
  ant beta:files list --scope-id sesn_abc123 --beta managed-agents-2026-04-01

  # Download a file
  ant files download --file-id "$FILE_ID" --output output.txt
  ```

  ```python Python
  # List files associated with a session
  files = client.beta.files.list(
      scope_id="sesn_abc123",
      betas=["managed-agents-2026-04-01"],
  )
  for file in files:
      print(file.id, file.filename)

  # Download a file
  content = client.files.download(files.data[0].id)
  content.write_to_file("output.txt")
  ```

  ```typescript TypeScript
  import { writeFile } from "node:fs/promises";

  // List files associated with a session
  const files = await client.beta.files.list({
    scope_id: "sesn_abc123",
    betas: ["managed-agents-2026-04-01"]
  });
  for (const file of files.data) {
    console.log(file.id, file.filename);
  }

  // Download a file
  const content = await client.files.download(files.data[0].id);
  await writeFile("output.txt", new Uint8Array(await content.arrayBuffer()));
  ```

  ```csharp C#
  // List files associated with a session
  var files = await client.Beta.Files.List(new()
  {
      ScopeID = "sesn_abc123",
      Betas = ["managed-agents-2026-04-01"],
  });

  // Download a file
  using var content = await client.Files.Download(files.Items[0].ID);
  await using var output = File.Create("output.txt");
  await (await content.ReadAsStream()).CopyToAsync(output);
  ```

  ```go Go
  // List files associated with a session
  files, err := client.Beta.Files.List(ctx, anthropic.BetaFileListParams{
  	ScopeID: anthropic.String("sesn_abc123"),
  	Betas:   []anthropic.AnthropicBeta{"managed-agents-2026-04-01"},
  })
  if err != nil {
  	panic(err)
  }

  // Download a file
  resp, err := client.Files.Download(ctx, files.Data[0].ID, anthropic.FileDownloadParams{})
  if err != nil {
  	panic(err)
  }
  defer resp.Body.Close()
  out, err := os.Create("output.txt")
  if err != nil {
  	panic(err)
  }
  defer out.Close()
  if _, err := io.Copy(out, resp.Body); err != nil {
  	panic(err)
  }
  ```

  ```java Java
  // List files associated with a session
  var files = client.beta().files().list(FileListParams.builder()
      .scopeId("sesn_abc123")
      .addBeta(AnthropicBeta.of("managed-agents-2026-04-01"))
      .build());

  // Download a file
  try (HttpResponse response = client.files().download(files.data().get(0).id())) {
      try (InputStream body = response.body()) {
          Files.copy(body, Path.of("output.txt"), StandardCopyOption.REPLACE_EXISTING);
      }
  }
  ```

  ```php PHP
  // List files associated with a session
  $files = $client->beta->files->list(
      scopeID: 'sesn_abc123',
      betas: ['managed-agents-2026-04-01'],
  );
  foreach ($files->getItems() as $file) {
      echo "{$file->id} {$file->filename}\n";
  }

  // Download a file
  $content = $client->files->download($files->getItems()[0]->id);
  file_put_contents('output.txt', $content);
  ```

  ```ruby Ruby
  # List files associated with a session
  files = client.beta.files.list(
    scope_id: "sesn_abc123",
    betas: ["managed-agents-2026-04-01"]
  )

  # Download a file
  content = client.files.download(files.data[0].id)
  File.binwrite("output.txt", content.read)
  ```
</CodeGroup>

## Supported file types

The agent can work with any file type, including:

* Source code (`.py`, `.js`, `.ts`, `.go`, `.rs`, and others)
* Data files (`.csv`, `.json`, `.xml`, `.yaml`)
* Documents (`.txt`, `.md`)
* Archives (`.zip`, `.tar.gz`) - the agent can extract these using bash
* Binary files - the agent can process these with appropriate tools

## File paths

<Note>
  Files mounted in the sandbox are read-only copies. The agent can read them but cannot modify the original uploaded file. To work with modified versions, the agent writes to new paths within the sandbox.
</Note>

* The path you specify is rooted under the session’s uploads directory: a `mount_path` (java, php: `mountPath`; csharp, go: `MountPath`) of `/data.csv` places the file at `/mnt/session/uploads/data.csv` in the sandbox.
* If you omit `mount_path` (java, php: `mountPath`; csharp, go: `MountPath`), the file is placed at `/mnt/session/uploads/<file_id>`.
* Parent directories are created automatically.
* Paths should be absolute (starting with `/`).
* Files the agent writes to `/mnt/session/outputs/` become available through the Files API, scoped to the session; see [Listing and downloading session files](https://platform.claude.com/docs/en/managed-agents/files#listing-and-downloading-session-files).
