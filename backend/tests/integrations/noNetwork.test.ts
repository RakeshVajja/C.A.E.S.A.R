import { describe, expect, it } from 'vitest';
import { FetchError } from '../../src/integrations/http/httpClient';
import { OpenAlexClient } from '../../src/integrations/openalex/client';

describe('test environment', () => {
  it('blocks live network access, so an un-mocked client fails instead of calling OpenAlex', async () => {
    const client = new OpenAlexClient({ http: { maxRetries: 0 } });
    const error = await client.validateAuthor('A5023888391').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FetchError);
    expect((error as FetchError).message).toContain('Live network access is disabled in tests');
  });
});
