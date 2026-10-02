export function extractTypeScriptSnippets(markdown: string): string[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const snippets: string[] = [];
  let snippet: string[] | undefined;

  for (const line of lines) {
    if (!snippet) {
      if (/^\s*```(?:typescript|ts)(?:\s+[^`]*)?\s*$/i.test(line)) snippet = [];
      continue;
    }

    if (/^\s*```\s*$/.test(line)) {
      snippets.push(snippet.join('\n').trimEnd());
      snippet = undefined;
      continue;
    }

    snippet.push(line);
  }

  if (snippet) throw new Error('Unclosed TypeScript code fence');
  return snippets;
}

export function selectTypeScriptSnippets(snippets: string[], indexes?: number[]): string {
  const selected = indexes ?? snippets.map((_, index) => index);
  for (const index of selected) {
    if (!Number.isInteger(index) || index < 0 || index >= snippets.length) {
      throw new Error(`TypeScript snippet index ${index} is out of range (found ${snippets.length})`);
    }
  }
  return selected.map((index) => snippets[index]).join('\n\n');
}
