import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createApiClient } from './api-client';

const responseSchema = z.object({ ok: z.literal(true) });

describe('createApiClient', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('serializes a typed request and validates the JSON response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = createApiClient({ baseUrl: 'https://vault.test/api' });
    await expect(
      client.request({
        method: 'POST',
        path: '/switches',
        body: { title: 'Plan' },
        schema: responseSchema,
      }),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://vault.test/api/switches',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ title: 'Plan' }),
        credentials: 'include',
      }),
    );
  });

  it('omits content-type on bodyless requests so empty POSTs reach auth handlers', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = createApiClient({ baseUrl: 'https://vault.test/api' });
    await expect(
      client.request({ method: 'POST', path: '/logout', schema: responseSchema }),
    ).resolves.toEqual({ ok: true });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('returns a typed HTTP error without exposing the response body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 401, statusText: 'Unauthorized' }),
    );
    const client = createApiClient({ baseUrl: 'https://vault.test/api' });
    await expect(client.request({ path: '/me', schema: responseSchema })).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      status: 401,
    });
  });

  it('rejects invalid response payloads before callers use them', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = createApiClient({ baseUrl: 'https://vault.test/api' });
    await expect(client.request({ path: '/health', schema: responseSchema })).rejects.toMatchObject(
      { code: 'VALIDATION_ERROR', status: 200 },
    );
  });
});
