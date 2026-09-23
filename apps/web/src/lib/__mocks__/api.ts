/**
 * Stands in for `lib/api` while the pure logic beside it is tested.
 *
 * The real module builds an axios client from `import.meta.env` and installs
 * a token-refresh interceptor — none of which a test of a reducer needs, and
 * all of which would need a browser-shaped environment to load at all. Any
 * test that actually called one of these would fail loudly rather than
 * silently reach the network.
 */
export const api = new Proxy(
  {},
  {
    get() {
      throw new Error('lib/api is mocked in unit tests — do not make HTTP calls here');
    },
  },
) as never;

export function apiOrigin(): string {
  return 'http://api.test';
}
