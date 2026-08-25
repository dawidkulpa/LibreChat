import { resolveUploadedImageArguments } from './images';

const files = [
  { file_id: 'first', type: 'image/png' },
  { file_id: 'second', type: 'image/jpeg' },
  { file_id: 'third', type: 'image/webp' },
];
const imageUrls = {
  first: 'data:image/png;base64,Zmlyc3Q=',
  second: 'data:image/jpeg;base64,c2Vjb25k',
  third: 'data:image/webp;base64,dGhpcmQ=',
};
const request = { body: { files } };

function createDependencies(overrides = {}) {
  return {
    findFiles: jest.fn().mockResolvedValue(files),
    encodeImages: jest.fn().mockResolvedValue({
      image_urls: files.map((file) => ({
        file_id: file.file_id,
        image_url: { url: imageUrls[file.file_id as keyof typeof imageUrls] },
      })),
    }),
    ...overrides,
  };
}

describe('resolveUploadedImageArguments', () => {
  it('returns the original arguments without I/O when forwarding is absent or false', async () => {
    const findFiles = jest.fn();
    const encodeImages = jest.fn();
    const toolArguments = { image: '/mnt/data/0.png' };

    await expect(
      resolveUploadedImageArguments({ toolArguments, dependencies: { findFiles, encodeImages } }),
    ).resolves.toBe(toolArguments);
    await expect(
      resolveUploadedImageArguments({
        forwardUploadedImages: false,
        toolArguments,
        dependencies: { findFiles, encodeImages },
      }),
    ).resolves.toBe(toolArguments);

    expect(findFiles).not.toHaveBeenCalled();
    expect(encodeImages).not.toHaveBeenCalled();
  });

  it('leaves non-exact paths, URLs, data URLs, unsafe indexes, and uppercase extensions untouched', async () => {
    const dependencies = createDependencies();
    const toolArguments = {
      values: [
        '/mnt/data/0.PNG',
        '/mnt/data/-1.png',
        '/mnt/data/1.5.png',
        '/mnt/data/9007199254740992.png',
        'file:///mnt/data/0.png',
        'https://example.test/mnt/data/0.png',
        'prefix /mnt/data/0.png',
        '/mnt/data/0.png suffix',
        'data:image/png;base64,Zmlyc3Q=',
      ],
    };

    await expect(
      resolveUploadedImageArguments({
        forwardUploadedImages: true,
        toolArguments,
        request,
        user: { id: 'user-1' },
        dependencies,
      }),
    ).resolves.toBe(toolArguments);

    expect(dependencies.findFiles).not.toHaveBeenCalled();
    expect(dependencies.encodeImages).not.toHaveBeenCalled();
  });

  it('replaces only referenced nested placeholders without mutating input and deduplicates lookup and encoding', async () => {
    const dependencies = createDependencies({
      findFiles: jest.fn().mockResolvedValue([files[2], files[1], files[0]]),
    });
    const toolArguments = {
      first: '/mnt/data/2.webp',
      nested: ['/mnt/data/1.jpeg', { duplicate: '/mnt/data/1.jpeg' }, '/mnt/data/0.png'],
      untouched: '/mnt/data/7.gif',
    };

    await expect(
      resolveUploadedImageArguments({
        forwardUploadedImages: true,
        toolArguments,
        request,
        user: { id: 'user-1' },
        dependencies,
      }),
    ).resolves.toEqual({
      first: imageUrls.third,
      nested: [imageUrls.second, { duplicate: imageUrls.second }, imageUrls.first],
      untouched: '/mnt/data/7.gif',
    });

    expect(toolArguments.nested[1]).toEqual({ duplicate: '/mnt/data/1.jpeg' });
    expect(dependencies.findFiles).toHaveBeenCalledWith({
      file_id: { $in: ['first', 'second', 'third'] },
      user: 'user-1',
    });
    expect(dependencies.encodeImages).toHaveBeenCalledWith(request, files);
    expect(dependencies.encodeImages).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing current-request file', { body: { files: [] } }, files, imageUrls.first],
    ['foreign database file', request, [], imageUrls.first],
    ['invalid encoded URL', request, files, 'https://example.test/image.png'],
    ['mismatched encoded MIME', request, files, imageUrls.second],
    ['noncanonical encoded base64', request, files, 'data:image/png;base64,Zh=='],
  ])(
    'fails closed for %s without exposing the encoded payload',
    async (_label, currentRequest, foundFiles, url) => {
      const dependencies = createDependencies({
        findFiles: jest.fn().mockResolvedValue(foundFiles),
        encodeImages: jest.fn().mockResolvedValue({
          image_urls: [{ file_id: 'first', image_url: { url } }],
        }),
      });

      await expect(
        resolveUploadedImageArguments({
          forwardUploadedImages: true,
          toolArguments: { image: '/mnt/data/0.png' },
          request: currentRequest,
          user: { id: 'user-1' },
          dependencies,
        }),
      ).rejects.toThrow('Unable to resolve referenced uploaded image.');
    },
  );
});
