import { AppError } from './errors.js';
import { hmacSha256Hex } from './utils.js';

export async function verifyHmacSignature(params: {
  headers: Headers;
  body: string;
  headerName: string;
  secret: string;
  missingMessage: string;
  invalidMessage: string;
}): Promise<void> {
  const actual = params.headers.get(params.headerName);
  if (!actual) {
    throw new AppError({
      code: 'UNAUTHORIZED',
      status: 401,
      retryable: false,
      message: params.missingMessage,
    });
  }
  const expected = await hmacSha256Hex(params.secret, params.body);
  if (actual !== expected) {
    throw new AppError({
      code: 'UNAUTHORIZED',
      status: 401,
      retryable: false,
      message: params.invalidMessage,
    });
  }
}
