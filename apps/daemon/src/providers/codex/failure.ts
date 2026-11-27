export function codexFailure(info: unknown): string | undefined {
  if (typeof info === 'string') {
    switch (info) {
      case 'unauthorized': return 'PROVIDER_AUTH_REQUIRED';
      case 'rateLimitExceeded':
      case 'usageLimitExceeded': return 'PROVIDER_RATE_LIMITED';
      case 'modelNotFound': return 'MODEL_UNAVAILABLE';
      case 'sandboxError':
      case 'tooManyDenials':
      case 'cyberPolicy':
      case 'misalignmentPolicyViolation': return 'PROVIDER_POLICY_DENIED';
      case 'serverOverloaded':
      case 'flexUnavailable': return 'PROVIDER_UNAVAILABLE';
    }
  }
  if (info && typeof info === 'object') {
    const connection = ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected',
      'responseTooManyFailedAttempts'] as const;
    for (const kind of connection) {
      if (!Object.hasOwn(info, kind)) continue;
      const status = (info as Record<string, { httpStatusCode?: number | null }>)[kind]?.httpStatusCode;
      if (status === 401 || status === 403) return 'PROVIDER_AUTH_REQUIRED';
      if (status === 429) return 'PROVIDER_RATE_LIMITED';
      if (status === 404) return 'MODEL_UNAVAILABLE';
      return 'PROVIDER_NETWORK_ERROR';
    }
    const value = info as { codexErrorInfo?: unknown; data?: { codexErrorInfo?: unknown } };
    return codexFailure(value.codexErrorInfo ?? value.data?.codexErrorInfo);
  }
}

export class RpcFailure extends Error {
  readonly category: string | undefined;
  constructor(info: unknown) {
    super('Codex rejected the protocol request.');
    this.category = codexFailure(info);
  }
}
