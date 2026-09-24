import { PATH_METADATA } from '@nestjs/common/constants';
import { UploadsController } from './uploads.controller';

/**
 * A helper once sat between the video route's decorators and its handler, so
 * `@Post('uploads/videos')` bound to the helper: every video upload called it
 * with no file and crashed on `file.path`. Each route stays on its handler.
 */
describe('UploadsController routes', () => {
  const proto = UploadsController.prototype as unknown as Record<string, object>;
  const routeOf = (method: string) => Reflect.getMetadata(PATH_METADATA, proto[method]);

  it.each([
    ['uploadVideo', 'uploads/videos'],
    ['videoStatus', 'uploads/videos/:id/status'],
    ['uploadAttachment', 'uploads/lessons/:lessonId/attachments'],
  ])('%s serves %s', (method, route) => {
    expect(routeOf(method)).toBe(route);
  });

  it('the byte check is not a route', () => {
    expect(routeOf('rejectMismatch')).toBeUndefined();
  });
});
