import type { JevAnswer, JevQuestions, JevResponse, JevState } from './types.js';

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';
export const JEV_REQUEST_TIMEOUT_MS = 30_000;

const REDACTED = '[REDACTED]';
const PRIVATE_KEY = /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const KNOWN_API_KEY = /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{8,}|sk_(?:live|test)_[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const SECRET_ASSIGNMENT = /(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|private[_-]?token|password|passwd|secret|token)\b\s*(?:=|:)\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[A-Za-z0-9_+/=-]{4,})(?![.\w(])/gi;
const SECRET_FIELD = /^(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|private[_-]?key|private[_-]?token|password|passwd|secret|token)$/i;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /(?<![\w])\+?\d[\d\s().-]{8,}\d(?![\w])/g;

function redactSensitiveText(value: string): string {
  return value
    .replace(PRIVATE_KEY, '[REDACTED PRIVATE KEY]')
    .replace(BEARER_TOKEN, 'Bearer [REDACTED]')
    .replace(KNOWN_API_KEY, REDACTED)
    .replace(JWT, REDACTED)
    .replace(SECRET_ASSIGNMENT, `$1${REDACTED}`)
    .replace(EMAIL, '[REDACTED EMAIL]')
    .replace(PHONE, (candidate) => {
      const digits = candidate.replace(/\D/g, '').length;
      return digits >= 10 && digits <= 15 ? '[REDACTED PHONE]' : candidate;
    });
}

function redactSensitiveValue(key: string, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return SECRET_FIELD.test(key) ? REDACTED : redactSensitiveText(value);
}

export interface JevRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/** The HTTP request for one Jev call, for any fetch-like transport. */
export function buildJevRequest(
  params: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
  },
  state: JevState,
  questions: JevQuestions,
): JevRequest {
  return {
    url: params.baseUrl ?? SYSTEM_ONE_URL,
    method: 'POST',
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(
      { model: params.model ?? DEFAULT_MODEL, state, questions },
      redactSensitiveValue,
    ),
  };
}

/** Validates a Jev response body; throws on anything but an `answers` object. */
export function parseJevResponse(
  status: number,
  ok: boolean,
  text: string,
): JevResponse {
  if (!ok) {
    throw new Error(`Jev request failed (${status})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Jev returned malformed JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('answers' in parsed) ||
    parsed.answers === null ||
    typeof parsed.answers !== 'object'
  ) {
    throw new Error('Jev response is missing answers');
  }
  return parsed as JevResponse;
}

/** The `noul` probability of one answer; throws when it is not there. */
export function noulAnswer(
  answers: Record<string, JevAnswer>,
  name: string,
): number {
  const answer = answers[name];
  if (
    !answer ||
    !('noul' in answer) ||
    typeof answer.noul !== 'number' ||
    !Number.isFinite(answer.noul)
  ) {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  return answer.noul;
}
