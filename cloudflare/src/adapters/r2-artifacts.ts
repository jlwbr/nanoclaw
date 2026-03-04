import { R2Bucket } from '../cf-types.js';
import { SqlClient } from './d1/client.js';
import {
  ArtifactMetadata,
  ArtifactPutRequest,
  ArtifactStoragePort,
} from '../ports/storage.js';
import { stableNowIso } from '../utils.js';

export class R2ArtifactStorageAdapter implements ArtifactStoragePort {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly sql: SqlClient,
  ) {}

  async put(request: ArtifactPutRequest): Promise<ArtifactMetadata> {
    const key = `tenants/${request.tenantId}/runs/${request.runId}/artifacts/${request.artifactId}`;
    const object = await this.bucket.put(key, request.body, {
      httpMetadata: {
        contentType: request.contentType,
      },
      customMetadata: {
        tenantId: request.tenantId,
        runId: request.runId,
        artifactId: request.artifactId,
      },
    });
    if (!object) {
      throw new Error(`Failed to write artifact "${request.artifactId}" to R2`);
    }
    const createdAt = stableNowIso();
    const metadata: ArtifactMetadata = {
      tenantId: request.tenantId,
      runId: request.runId,
      artifactId: request.artifactId,
      key,
      contentType: request.contentType,
      sizeBytes: object.size,
      createdAt,
    };
    await this.sql.run(
      `INSERT INTO artifacts (
        artifact_id, tenant_id, run_id, r2_key, content_type, size_bytes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(artifact_id) DO UPDATE SET
        r2_key = excluded.r2_key,
        content_type = excluded.content_type,
        size_bytes = excluded.size_bytes`,
      [
        metadata.artifactId,
        metadata.tenantId,
        metadata.runId,
        metadata.key,
        metadata.contentType,
        metadata.sizeBytes,
        metadata.createdAt,
      ],
    );
    return metadata;
  }

  async get(
    tenantId: string,
    artifactId: string,
  ): Promise<{ metadata: ArtifactMetadata; bodyText: string } | null> {
    const row = await this.sql.one<Record<string, unknown>>(
      `SELECT artifact_id, tenant_id, run_id, r2_key, content_type, size_bytes, created_at
       FROM artifacts
       WHERE tenant_id = ? AND artifact_id = ?`,
      [tenantId, artifactId],
    );
    if (!row) {
      return null;
    }
    const object = await this.bucket.get(String(row.r2_key));
    if (!object?.body) {
      return null;
    }
    const metadata: ArtifactMetadata = {
      artifactId: String(row.artifact_id),
      tenantId: String(row.tenant_id),
      runId: String(row.run_id),
      key: String(row.r2_key),
      contentType: String(row.content_type),
      sizeBytes: Number(row.size_bytes),
      createdAt: String(row.created_at),
    };
    return {
      metadata,
      bodyText: await object.body.text(),
    };
  }

  async delete(tenantId: string, artifactId: string): Promise<void> {
    const row = await this.sql.one<Record<string, unknown>>(
      'SELECT r2_key FROM artifacts WHERE tenant_id = ? AND artifact_id = ?',
      [tenantId, artifactId],
    );
    if (!row) {
      return;
    }
    await this.bucket.delete(String(row.r2_key));
    await this.sql.run('DELETE FROM artifacts WHERE artifact_id = ?', [artifactId]);
  }
}
