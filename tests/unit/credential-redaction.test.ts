import { describe, expect, it } from 'vitest';
import { createCredentialRedactor } from '@/core/credentials/redaction.js';

describe('credential redaction', () => {
  it('removes environment and bearer values from event-shaped payloads', () => {
    const envSecret = 'environment-demo-secret';
    const bearerSecret = 'bearer-demo-secret';
    const redactor = createCredentialRedactor({
      sessionId: 'sess_redaction',
      vaultIds: ['vlt_demo'],
      environment: { TOKEN: envSecret },
      request_headers: { Authorization: `Bearer ${bearerSecret}` },
      request_body: { token: bearerSecret },
      credentials: [],
      denied: [],
    });

    const payload = redactor({
      metadata: { authorization: `Bearer ${bearerSecret}` },
      content: [{
        type: 'tool_use',
        input: { command: `curl -H "Authorization: Bearer ${bearerSecret}" && echo ${envSecret}` },
      }, {
        type: 'tool_result',
        content: `TOKEN=${envSecret}`,
      }],
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(envSecret);
    expect(serialized).not.toContain(bearerSecret);
    expect(serialized).toContain('[REDACTED]');

    redactor.clear();
  });
});
