import { YoutubeImportService } from './youtube-import.service';

/**
 * What a teacher actually pastes.
 *
 * Every accepted case here came from a real place a link gets copied from —
 * a browser bar, a share sheet, a chat message that wrapped it. The refusals
 * matter more: this function is the only thing between a typed string and a
 * shelled-out downloader, so anything that is not plainly a video on a host we
 * named has to come back null.
 */
describe('a pasted video link', () => {
  const svc = new YoutubeImportService({} as never);
  const id = (raw: string) => svc.resolveSource(raw)?.id ?? null;
  const url = (raw: string) => svc.resolveSource(raw)?.url ?? null;

  describe('YouTube', () => {
    const ID = 'dQw4w9WgXcQ';
    it.each([
      ['a watch link', `https://www.youtube.com/watch?v=${ID}`],
      ['a short link', `https://youtu.be/${ID}`],
      ['a short', `https://www.youtube.com/shorts/${ID}`],
      ['an embed', `https://www.youtube.com/embed/${ID}`],
      ['a live link', `https://www.youtube.com/live/${ID}`],
      ['the old /v/ form', `https://www.youtube.com/v/${ID}`],
      ['the privacy domain', `https://www.youtube-nocookie.com/embed/${ID}`],
      ['mobile', `https://m.youtube.com/watch?v=${ID}`],
      ['no protocol', `youtube.com/watch?v=${ID}`],
      ['a bare id', ID],
      ['extra query junk', `https://www.youtube.com/watch?v=${ID}&t=42s&list=PL123`],
      ['wrapped by a chat client', `<https://youtu.be/${ID}>`],
      ['with a trailing full stop', `https://youtu.be/${ID}.`],
      ['padded with spaces', `   https://youtu.be/${ID}   `],
    ])('takes %s', (_label, raw) => {
      expect(id(raw)).toBe(ID);
    });

    it('always rebuilds the URL rather than passing the string on', () => {
      // The pasted string carried a playlist and a timestamp; what reaches the
      // downloader carries neither.
      expect(url(`https://m.youtube.com/watch?v=${ID}&list=PLxx&t=9`))
        .toBe(`https://www.youtube.com/watch?v=${ID}`);
    });
  });

  describe('Facebook', () => {
    it('takes a watch link', () => {
      expect(url('https://www.facebook.com/watch/?v=1234567890')).toBe(
        'https://www.facebook.com/watch/?v=1234567890',
      );
    });
    it("takes a page's video", () => {
      expect(id('https://www.facebook.com/SomePage/videos/9876543210/')).toBe('9876543210');
    });
    it('takes a reel', () => {
      expect(id('https://web.facebook.com/reel/5551234567')).toBe('5551234567');
    });
    it('refuses a short link it would have to follow to understand', () => {
      // Resolving it means a request to an address nobody has checked, which is
      // the thing this guard exists to prevent.
      expect(svc.resolveSource('https://fb.watch/aBcDeFg/')).toBeNull();
    });
  });

  describe('refuses', () => {
    it.each([
      ['an empty string', ''],
      ['a lookalike host', 'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ'],
      ['a host we never named', 'https://vimeo.com/12345678'],
      ['an internal address', 'http://169.254.169.254/latest/meta-data/'],
      ['a file URL', 'file:///etc/passwd'],
      ['a javascript URL', 'javascript:alert(1)'],
      ['a watch link with no id', 'https://www.youtube.com/watch?list=PL123'],
      ['an id of the wrong length', 'https://youtu.be/tooshort'],
      ['a channel page', 'https://www.youtube.com/@someone'],
      ['a facebook profile', 'https://www.facebook.com/someone'],
    ])('%s', (_label, raw) => {
      expect(svc.resolveSource(raw)).toBeNull();
    });
  });
});
