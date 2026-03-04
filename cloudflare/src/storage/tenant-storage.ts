import { Env } from '../types';

function ensureBucket(env: Env): R2Bucket {
  if (!env.TENANT_FILES) {
    throw new Error('TENANT_FILES R2 binding is not configured');
  }
  return env.TENANT_FILES;
}

export function tenantClaudePath(
  tenantId: string,
  groupFolder: string,
): string {
  return `tenants/${tenantId}/groups/${groupFolder}/CLAUDE.md`;
}

export function tenantSessionPath(
  tenantId: string,
  groupFolder: string,
  sessionId: string,
): string {
  return `tenants/${tenantId}/sessions/${groupFolder}/${sessionId}.json`;
}

export function tenantLogPath(
  tenantId: string,
  isoTimestamp: string,
  fileName: string,
): string {
  return `tenants/${tenantId}/logs/${isoTimestamp}/${fileName}`;
}

export async function putTenantObject(
  env: Env,
  key: string,
  body: string | ArrayBuffer | ArrayBufferView,
  metadata?: Record<string, string>,
): Promise<void> {
  await ensureBucket(env).put(key, body, {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: metadata,
  });
}

export async function getTenantObjectText(
  env: Env,
  key: string,
): Promise<string | null> {
  const object = await ensureBucket(env).get(key);
  if (!object) return null;
  return object.text();
}
