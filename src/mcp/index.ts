import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createManagedAgentsMcpServer } from './server.js';

async function main(): Promise<void> {
  const server = createManagedAgentsMcpServer();
  await server.connect(new StdioServerTransport());
  process.stderr.write('sandbase-harness MCP server connected over stdio\n');
}

main().catch((error) => {
  process.stderr.write(`sandbase-harness MCP server failed: ${String(error)}\n`);
  process.exitCode = 1;
});
