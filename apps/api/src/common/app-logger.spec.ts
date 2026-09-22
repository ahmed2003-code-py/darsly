import { AppLogger } from './app-logger';
import { requestIdMiddleware } from './request-context';

/**
 * Two readers, two formats. In development a person is watching a terminal and
 * Nest's coloured line is already right; in production a log tool is ingesting
 * it and wants JSON with a field it can query on.
 */
function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const out = jest.spyOn(process.stdout, 'write').mockImplementation((c: any) => (lines.push(String(c)), true));
  const err = jest.spyOn(process.stderr, 'write').mockImplementation((c: any) => (lines.push(String(c)), true));
  try {
    fn();
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
  return lines;
}

const inRequest = (id: string, fn: () => void) =>
  requestIdMiddleware({ headers: { 'x-request-id': id } } as any, { setHeader: () => undefined } as any, fn);

describe('AppLogger', () => {
  const original = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = original;
  });

  describe('in production', () => {
    function prodLogger() {
      process.env.NODE_ENV = 'production';
      return new AppLogger();
    }

    it('emits one JSON object per line, carrying the request id', () => {
      const logger = prodLogger();

      const lines = capture(() => inRequest('trace-42', () => logger.log('saved the thing', 'CoursesService')));

      const entry = JSON.parse(lines.join('').trim());
      expect(entry).toMatchObject({
        level: 'log',
        requestId: 'trace-42',
        context: 'CoursesService',
        message: 'saved the thing',
      });
      expect(typeof entry.time).toBe('string');
    });

    it('omits requestId outside a request rather than inventing one', () => {
      const logger = prodLogger();

      const lines = capture(() => logger.log('worker tick', 'VideoJobWorker'));

      expect(JSON.parse(lines.join('').trim()).requestId).toBeUndefined();
    });

    it('sends errors to stderr', () => {
      const logger = prodLogger();
      const err = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

      logger.error('it broke', undefined, 'PaymentsService');

      expect(err).toHaveBeenCalled();
      jest.restoreAllMocks();
    });

    it('never throws on a value that will not serialise', () => {
      const logger = prodLogger();
      const circular: any = {};
      circular.self = circular;

      expect(() => capture(() => logger.log(circular))).not.toThrow();
    });
  });

  describe('in development', () => {
    it('keeps Nest’s readable line and appends the id', () => {
      process.env.NODE_ENV = 'development';
      const logger = new AppLogger();

      const lines = capture(() => inRequest('dev-7', () => logger.log('hello', 'Ctx')));
      const all = lines.join('');

      expect(all).toContain('hello');
      expect(all).toContain('[req:dev-7]');
      expect(all.trim().startsWith('{')).toBe(false); // not JSON
    });

    it('leaves the line alone outside a request', () => {
      process.env.NODE_ENV = 'development';
      const logger = new AppLogger();

      const all = capture(() => logger.log('boot', 'Ctx')).join('');

      expect(all).toContain('boot');
      expect(all).not.toContain('[req:');
    });
  });
});
