/**
 * Minimal structural type for the OpenAPI 3 document we hand-author in openapi.ts.
 * Deliberately permissive (no full openapi-types dependency) — just enough shape so the
 * document is typed as an object and editors give basic completion at the top level.
 */
export interface OpenAPIV3 {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers?: Array<{ url: string; description?: string }>;
  tags?: Array<{ name: string; description?: string }>;
  paths: Record<string, unknown>;
  components?: {
    parameters?: Record<string, unknown>;
    responses?: Record<string, unknown>;
    schemas?: Record<string, unknown>;
  };
}
