import type { LanguageModelMiddleware } from 'ai';

/** Provider parsers can quote the entire response in validation errors. */
function safeError(error: unknown): Error {
  const source = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const status = typeof source.statusCode === 'number' && Number.isInteger(source.statusCode)
    && source.statusCode >= 400 && source.statusCode <= 599 ? source.statusCode : undefined;
  let code: string | undefined;
  let timeout = false;
  let current: Record<string, unknown> | undefined = source;
  // SDKs wrap native fetch errors. Inspect a bounded cause chain, retaining
  // only known codes; neither raw messages nor arbitrary code strings escape.
  for (let depth = 0; current && depth < 8; depth++) {
    code ??= ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND'].find((value) => current!.code === value);
    timeout ||= current.name === 'TimeoutError'
      || ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].some((value) => current!.code === value);
    current = current.cause && typeof current.cause === 'object' ? current.cause as Record<string, unknown> : undefined;
  }
  const clean = new Error(status ? `MiniMax request failed with HTTP ${status}`
    : code ? `MiniMax request failed (${code})`
      : timeout ? 'MiniMax request timeout' : 'MiniMax request or response failed');
  if (source.name === 'AbortError') clean.name = 'AbortError';
  const headers = new Headers();
  const retryAfter = source.responseHeaders instanceof Headers
    ? source.responseHeaders.get('retry-after')
    : source.responseHeaders && typeof source.responseHeaders === 'object'
      ? (source.responseHeaders as Record<string, unknown>)['retry-after'] : undefined;
  if (typeof retryAfter === 'string' && retryAfter.length < 128) {
    if (/^\d+(\.\d+)?$/.test(retryAfter) && Number.isFinite(Number(retryAfter))) {
      headers.set('retry-after', String(Number(retryAfter)));
    } else {
      const date = Date.parse(retryAfter);
      if (!Number.isNaN(date)) headers.set('retry-after', new Date(date).toUTCString());
    }
  }
  return Object.assign(clean, { ...(status ? { statusCode: status } : {}), responseHeaders: headers });
}

/** Sanitize before retry observers or public error projection see the failure. */
export function miniMaxErrorMiddleware(): LanguageModelMiddleware {
  return {
    wrapGenerate: async ({ doGenerate }) => {
      try { return await doGenerate(); } catch (error) { throw safeError(error); }
    },
    wrapStream: async ({ doStream }) => {
      try {
        const result = await doStream();
        const reader = result.stream.getReader();
        return { ...result, stream: new ReadableStream({
          async pull(controller) {
            try {
              const { done, value } = await reader.read();
              if (done) { reader.releaseLock(); controller.close(); }
              else controller.enqueue(value.type === 'error' ? { ...value, error: safeError(value.error) } : value);
            } catch (error) {
              reader.releaseLock();
              controller.error(safeError(error));
            }
          },
          async cancel(reason) {
            try { await reader.cancel(reason); } finally { reader.releaseLock(); }
          },
        }) };
      } catch (error) { throw safeError(error); }
    },
  };
}
