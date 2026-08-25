const {
  resolveUploadedImageArguments: resolveUploadedImageArgumentsInApi,
} = require('@librechat/api');
const { mergeFileConfig, getEndpointFileConfig, VisionModes } = require('librechat-data-provider');

function getMcpImageSizeLimit(request) {
  const fileConfig = mergeFileConfig(request?.config?.fileConfig);
  return getEndpointFileConfig({ fileConfig }).fileSizeLimit;
}

function getDependencies() {
  const db = require('~/models');
  const { encodeAndFormat } = require('~/server/services/Files/images/encode');

  return {
    findFiles: db.getFiles,
    encodeImages: async (request, files) => {
      const mcpImageSizeLimit = getMcpImageSizeLimit(request);
      const imageFiles = files.filter(
        (file) =>
          Number.isSafeInteger(file.bytes) && file.bytes >= 0 && file.bytes <= mcpImageSizeLimit,
      );

      if (imageFiles.length === 0) {
        return { image_urls: [] };
      }

      const { image_urls } = await encodeAndFormat(
        request,
        imageFiles,
        { mcpImageSizeLimit },
        VisionModes.mcp,
      );
      return { image_urls };
    },
  };
}

async function resolveUploadedImageArguments(params) {
  return await resolveUploadedImageArgumentsInApi({
    ...params,
    dependencies: params.dependencies ?? getDependencies(),
  });
}

module.exports = { resolveUploadedImageArguments };
