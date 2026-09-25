import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryRaw } = vi.hoisted(() => ({ queryRaw: vi.fn() }));

vi.mock('../src/config/database', () => ({
  prisma: { $queryRaw: queryRaw },
}));

import { createApp } from '../src/app';

describe('GET /api/health', () => {
  beforeEach(() => {
    queryRaw.mockReset();
  });

  it('reports ok when the database responds', async () => {
    queryRaw.mockResolvedValue([{ '?column?': 1 }]);

    const res = await request(createApp()).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      environment: 'test',
      database: { status: 'connected' },
    });
    expect(typeof res.body.database.latencyMs).toBe('number');
  });

  it('reports 503 without leaking the database error outside development', async () => {
    queryRaw.mockRejectedValue(new Error('password authentication failed for user "secret"'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(createApp()).get('/api/health');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'error', database: { status: 'disconnected' } });
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});

describe('error handling', () => {
  it('returns the standard error shape for unknown routes', async () => {
    const res = await request(createApp()).get('/api/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Route GET /api/does-not-exist not found' },
    });
  });

  it('returns 400 in the standard error shape for malformed JSON', async () => {
    const res = await request(createApp())
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send('{"broken":');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('does not advertise the framework', async () => {
    const res = await request(createApp()).get('/api/does-not-exist');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
