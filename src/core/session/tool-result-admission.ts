export const SELF_HOSTED_TOOL_RESULT_UNSUPPORTED_CODE = 'self_hosted_tool_result_not_supported';

/** The official worker answer channel needs a durable issued-call lifecycle. */
export class SelfHostedToolResultUnsupportedError extends Error {
  readonly code = SELF_HOSTED_TOOL_RESULT_UNSUPPORTED_CODE;

  constructor() {
    super('user.tool_result is not supported: this runtime has no official self-hosted tool-answer lifecycle. Use the local worker completion protocol for existing work items.');
    this.name = 'SelfHostedToolResultUnsupportedError';
  }
}

export function assertToolResultSupported(event: { type: string } | undefined): void {
  if (event?.type === 'user.tool_result') throw new SelfHostedToolResultUnsupportedError();
}
