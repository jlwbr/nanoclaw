export interface ArtifactPutRequest {
  tenantId: string;
  runId: string;
  artifactId: string;
  contentType: string;
  body: string | ArrayBuffer;
}

export interface ArtifactMetadata {
  tenantId: string;
  runId: string;
  artifactId: string;
  key: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface ArtifactStoragePort {
  put(request: ArtifactPutRequest): Promise<ArtifactMetadata>;
  get(tenantId: string, artifactId: string): Promise<{
    metadata: ArtifactMetadata;
    bodyText: string;
  } | null>;
  delete(tenantId: string, artifactId: string): Promise<void>;
}
