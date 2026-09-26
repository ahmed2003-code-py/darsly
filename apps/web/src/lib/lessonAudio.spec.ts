import { pickAudioMime, uploadWithRetry } from './lessonAudio';

describe('lesson audio capture', () => {
  it('records WebM/Opus where it can, MP4 on Safari, nothing where neither exists', () => {
    expect(pickAudioMime(() => true)).toBe('audio/webm;codecs=opus');
    expect(pickAudioMime((t) => t === 'audio/mp4')).toBe('audio/mp4');
    expect(pickAudioMime(() => false)).toBeNull();
  });

  it('tries a failed upload again, then gives up', async () => {
    const sleep = jest.fn(async () => undefined);
    let n = 0;
    const flaky = jest.fn(async () => {
      n += 1;
      if (n < 3) throw new Error('Network Error');
    });
    await expect(uploadWithRetry(flaky, 1, new Blob(['x']), [1, 1, 1], sleep)).resolves.toBe(true);
    expect(flaky).toHaveBeenCalledTimes(3);

    const down = jest.fn(async () => {
      throw new Error('Network Error');
    });
    await expect(uploadWithRetry(down, 1, new Blob(['x']), [1, 1], sleep)).resolves.toBe(false);
    expect(down).toHaveBeenCalledTimes(3);
  });

  it('does not ask again when the server refused (switched off, class over)', async () => {
    const refused = jest.fn(async () => {
      throw { response: { status: 409 } };
    });
    await expect(uploadWithRetry(refused, 1, new Blob(['x']), [1, 1], async () => undefined)).resolves.toBe(
      false,
    );
    expect(refused).toHaveBeenCalledTimes(1);
  });
});
