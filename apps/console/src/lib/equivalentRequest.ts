/**
 * Equivalent-request rendering for the create forms.
 *
 * One descriptor (`EquivalentRequest`) describes the HTTP call a form will
 * make; three formatters turn it into cURL, TypeScript (official Anthropic
 * SDK where the endpoint maps to a published resource method, `fetch`
 * otherwise), and Python (`requests`) snippets. The credential is always the
 * `$ANTHROPIC_API_KEY` environment variable — the Console never writes the
 * stored key into a snippet.
 */

export interface EquivalentRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
}

export type EquivalentLanguage = 'curl' | 'typescript' | 'python';

export const EQUIVALENT_LANGUAGES: Array<{ id: EquivalentLanguage; label: string }> = [
  { id: 'curl', label: 'cURL' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'python', label: 'Python' },
];

export function equivalentSnippet(request: EquivalentRequest, baseUrl: string, language: EquivalentLanguage): string {
  switch (language) {
    case 'curl': return formatCurl(request, baseUrl);
    case 'typescript': return formatTypeScript(request, baseUrl);
    case 'python': return formatPython(request, baseUrl);
  }
}

function formatCurl(request: EquivalentRequest, baseUrl: string): string {
  const lines = [
    `curl -sS -X ${request.method} '${baseUrl}${request.path}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -H "x-api-key: $ANTHROPIC_API_KEY"${request.body === undefined ? '' : ' \\'}`,
  ];
  if (request.body !== undefined) {
    lines.push(`  -d '${JSON.stringify(request.body)}'`);
  }
  return lines.join('\n');
}

/** SDK resource calls the TypeScript tab prefers over raw fetch. */
const SDK_CALLS: Record<string, { method: string; result: string }> = {
  'POST /v1/agents': { method: 'client.beta.agents.create', result: 'agent' },
  'POST /v1/sessions': { method: 'client.beta.sessions.create', result: 'session' },
};

function formatTypeScript(request: EquivalentRequest, baseUrl: string): string {
  const sdkCall = SDK_CALLS[`${request.method} ${request.path}`];
  const bodySource = request.body === undefined ? '' : JSON.stringify(request.body, null, 2);
  if (sdkCall) {
    return [
      `import Anthropic from '@anthropic-ai/sdk';`,
      ``,
      `const client = new Anthropic({`,
      `  baseURL: '${baseUrl}',`,
      `  apiKey: process.env.ANTHROPIC_API_KEY,`,
      `});`,
      ``,
      `const ${sdkCall.result} = await ${sdkCall.method}(${bodySource});`,
      `console.log(${sdkCall.result}.id);`,
    ].join('\n');
  }
  return [
    `const response = await fetch('${baseUrl}${request.path}', {`,
    `  method: '${request.method}',`,
    `  headers: {`,
    `    'content-type': 'application/json',`,
    `    'x-api-key': process.env.ANTHROPIC_API_KEY!,`,
    `  },`,
    ...(request.body === undefined ? [] : [`  body: JSON.stringify(${bodySource}),`]),
    `});`,
    `if (!response.ok) throw new Error(await response.text());`,
    `console.log(await response.json());`,
  ].join('\n');
}

/** Render a JSON value as a Python literal (dict/list/str literals). */
function pythonLiteral(value: unknown, indent: number): string {
  const pad = '    '.repeat(indent);
  const closePad = '    '.repeat(indent - 1);
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((item) => `${pad}${pythonLiteral(item, indent + 1)}`);
    return `[\n${items.join(',\n')}\n${closePad}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return '{}';
  const items = entries.map(([key, item]) => `${pad}${JSON.stringify(key)}: ${pythonLiteral(item, indent + 1)}`);
  return `{\n${items.join(',\n')}\n${closePad}}`;
}

function formatPython(request: EquivalentRequest, baseUrl: string): string {
  const fn = { GET: 'get', POST: 'post', PUT: 'put', DELETE: 'delete' }[request.method];
  return [
    `import os`,
    `import requests`,
    ``,
    `response = requests.${fn}(`,
    `    "${baseUrl}${request.path}",`,
    `    headers={"x-api-key": os.environ["ANTHROPIC_API_KEY"]},`,
    ...(request.body === undefined ? [] : [`    json=${pythonLiteral(request.body, 1)},`]),
    `)`,
    `response.raise_for_status()`,
    `print(response.json())`,
  ].join('\n');
}
