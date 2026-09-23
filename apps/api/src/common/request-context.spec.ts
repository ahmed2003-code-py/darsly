import { currentRequestId, requestIdMiddleware } from './request-context';

/**
 * The id has to survive an `await`, because almost nothing in this codebase
 * logs before one. That is the whole reason for AsyncLocalStorage rather than
 * a field on `req` — a service five layers down has no request object, and
 * threading one by hand reaches the places someone remembered, which are never
 * the places that break.
 */
function run(headers: Record<string, string | string[]> = {}) {
  const req = { headers } as any;
  const res = { setHeader: jest.fn() } as any;
  return { req, res };
}

describe('requestIdMiddleware', () => {
  it('generates an id and echoes it back', () => {
    const { req, res } = run();
    let seen: string | null = null;

    requestIdMiddleware(req, res, () => {
      seen = currentRequestId();
    });

    expect(seen).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', seen);
  });

  it('honours a sane inbound id, so a trace survives the edge', () => {
    const { req, res } = run({ 'x-request-id': 'edge-abc_123.4' });
    let seen: string | null = null;

    requestIdMiddleware(req, res, () => {
      seen = currentRequestId();
    });

    expect(seen).toBe('edge-abc_123.4');
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', 'edge-abc_123.4');
  });

  /**
   * The id is repeated into log lines, so an unsanitised header is how newline
   * injection gets into a log file. Anything unusual is replaced rather than
   * cleaned — a caller does not get to choose how their line is framed.
   */
  it.each([
    ['a newline', 'abc\ndef'],
    ['a space', 'abc def'],
    ['ANSI escapes', '\u001b[31mred'],
    ['an over-long value', 'x'.repeat(65)],
    ['an empty value', ''],
  ])('replaces %s rather than logging it', (_label, value) => {
    const { req, res } = run({ 'x-request-id': value });
    let seen: string | null = null;

    requestIdMiddleware(req, res, () => {
      seen = currentRequestId();
    });

    expect(seen).not.toBe(value);
    expect(seen).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('takes the first value when the header is repeated', () => {
    const { req, res } = run({ 'x-request-id': ['first-id', 'second-id'] });
    let seen: string | null = null;

    requestIdMiddleware(req, res, () => {
      seen = currentRequestId();
    });

    expect(seen).toBe('first-id');
  });

  it('survives awaits — the reason this is AsyncLocalStorage', async () => {
    const { req, res } = run({ 'x-request-id': 'deep-1' });

    const seen = await new Promise<string | null>((resolve) => {
      requestIdMiddleware(req, res, async () => {
        await new Promise((r) => setTimeout(r, 5));
        await Promise.all([Promise.resolve(), new Promise((r) => setImmediate(r))]);
        resolve(currentRequestId());
      });
    });

    expect(seen).toBe('deep-1');
  });

  it('keeps two concurrent requests apart', async () => {
    const ids = await Promise.all(
      ['req-a', 'req-b'].map(
        (id) =>
          new Promise<string | null>((resolve) => {
            const { req, res } = run({ 'x-request-id': id });
            requestIdMiddleware(req, res, async () => {
              await new Promise((r) => setTimeout(r, Math.random() * 10));
              resolve(currentRequestId());
            });
          }),
      ),
    );

    expect(ids).toEqual(['req-a', 'req-b']);
  });

  it('is null outside a request — a worker tick is not faked into one', () => {
    expect(currentRequestId()).toBeNull();
  });
});
