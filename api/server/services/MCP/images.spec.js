const mockGetFiles = jest.fn();
const mockEncodeAndFormat = jest.fn();

jest.mock('~/models', () => ({ getFiles: (...args) => mockGetFiles(...args) }));
jest.mock('~/server/services/Files/images/encode', () => ({
  encodeAndFormat: (...args) => mockEncodeAndFormat(...args),
}));

const { VisionModes } = require('librechat-data-provider');
const { resolveUploadedImageArguments } = require('./images');

const mib = 1024 * 1024;

function createRequest(fileSizeLimit) {
  return {
    body: { files: [{ file_id: 'image-1', type: 'image/png' }] },
    config: { fileConfig: { endpoints: { default: { fileSizeLimit } } } },
  };
}

describe('MCP uploaded-image adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves a referenced zero-byte-metadata image through the effective-user query and MCP encoder', async () => {
    const request = createRequest(1);
    const file = { file_id: 'image-1', bytes: 0, type: 'image/png' };
    mockGetFiles.mockResolvedValue([file]);
    mockEncodeAndFormat.mockResolvedValue({
      image_urls: [
        {
          file_id: file.file_id,
          image_url: { url: 'data:image/png;base64,aW1hZ2U=' },
        },
      ],
    });

    await expect(
      resolveUploadedImageArguments({
        forwardUploadedImages: true,
        request,
        toolArguments: { image: '/mnt/data/0.png' },
        user: { id: 'effective-user' },
      }),
    ).resolves.toEqual({ image: 'data:image/png;base64,aW1hZ2U=' });

    expect(mockGetFiles).toHaveBeenCalledWith({
      file_id: { $in: [file.file_id] },
      user: 'effective-user',
    });
    expect(mockEncodeAndFormat).toHaveBeenCalledWith(
      request,
      [file],
      { mcpImageSizeLimit: mib },
      VisionModes.mcp,
    );
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
    ['missing', undefined],
  ])('fails closed without encoding %s byte metadata', async (_label, bytes) => {
    const request = createRequest(mib);
    const file = { file_id: 'image-1', bytes, type: 'image/png' };
    mockGetFiles.mockResolvedValue([file]);

    await expect(
      resolveUploadedImageArguments({
        forwardUploadedImages: true,
        request,
        toolArguments: { image: '/mnt/data/0.png' },
        user: { id: 'effective-user' },
      }),
    ).rejects.toThrow('Unable to resolve referenced uploaded image.');

    expect(mockEncodeAndFormat).not.toHaveBeenCalled();
  });
});
