const UPLOAD_PLACEHOLDER = /^\/mnt\/data\/(\d+)\.(png|jpe?g|webp)$/;
const DATA_URL = /^data:(image\/[^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/i;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

type SupportedImageMime = 'image/png' | 'image/jpeg' | 'image/webp';
type ToolArgumentValue =
  | string
  | number
  | boolean
  | null
  | ToolArgumentValue[]
  | { [key: string]: ToolArgumentValue };

type UploadPlaceholder = { index: number; mimeType: SupportedImageMime };

export interface ImageToolRequest {
  body?: {
    files?: Array<{ file_id?: string; type?: string }>;
  };
}

export interface ImageToolFile {
  file_id: string;
  type?: string;
}

export interface ImageToolDependencies {
  findFiles: (query: {
    file_id: { $in: string[] };
    user: string;
  }) => Promise<readonly ImageToolFile[]>;
  encodeImages: (
    request: ImageToolRequest | undefined,
    files: readonly ImageToolFile[],
  ) => Promise<{
    image_urls?: Array<{ file_id: string; image_url?: { url?: string } }>;
  }>;
}

export class UnresolvedUploadedImageError extends Error {
  constructor() {
    super('Unable to resolve referenced uploaded image.');
    this.name = 'UnresolvedUploadedImageError';
  }
}

function normalizeImageMime(value: unknown): SupportedImageMime | undefined {
  switch (typeof value === 'string' ? value.toLowerCase() : undefined) {
    case 'image/png':
      return 'image/png';
    case 'image/jpg':
    case 'image/jpeg':
      return 'image/jpeg';
    case 'image/webp':
      return 'image/webp';
  }
}

function getPlaceholder(value: ToolArgumentValue): UploadPlaceholder | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const match = value.match(UPLOAD_PLACEHOLDER);
  if (!match) {
    return undefined;
  }

  const index = Number(match[1]);
  const mimeType = normalizeImageMime(`image/${match[2]}`);
  return Number.isSafeInteger(index) && mimeType ? { index, mimeType } : undefined;
}

function placeholderKey({ index, mimeType }: UploadPlaceholder): string {
  return `${index}:${mimeType}`;
}

function isPlainObject(value: ToolArgumentValue): value is Record<string, ToolArgumentValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function collectPlaceholders(
  value: ToolArgumentValue,
  placeholders: Map<string, UploadPlaceholder>,
): void {
  const placeholder = getPlaceholder(value);
  if (placeholder) {
    placeholders.set(placeholderKey(placeholder), placeholder);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectPlaceholders(item, placeholders);
    }
    return;
  }

  if (isPlainObject(value)) {
    for (const item of Object.values(value)) {
      collectPlaceholders(item, placeholders);
    }
  }
}

function isCanonicalBase64(payload: string): boolean {
  if (
    payload.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)
  ) {
    return false;
  }

  let paddingLength = 0;
  if (payload.endsWith('==')) {
    paddingLength = 2;
  } else if (payload.endsWith('=')) {
    paddingLength = 1;
  }
  if (paddingLength === 0) {
    return true;
  }

  const sextet = BASE64_ALPHABET.indexOf(payload.charAt(payload.length - paddingLength - 1));
  return paddingLength === 2 ? (sextet & 0b1111) === 0 : (sextet & 0b11) === 0;
}

function parseImageDataUrl(
  value: unknown,
): { mimeType: SupportedImageMime; url: string } | undefined {
  const match = typeof value === 'string' ? value.match(DATA_URL) : null;
  const mimeType = normalizeImageMime(match?.[1]);
  const payload = match?.[2];
  if (!mimeType || !payload || !isCanonicalBase64(payload)) {
    return undefined;
  }

  return { mimeType, url: `data:${mimeType};base64,${payload}` };
}

function replacePlaceholders(
  value: ToolArgumentValue,
  replacementUrls: ReadonlyMap<string, string>,
): ToolArgumentValue {
  const placeholder = getPlaceholder(value);
  if (placeholder) {
    return replacementUrls.get(placeholderKey(placeholder)) ?? value;
  }

  if (Array.isArray(value)) {
    let copy: ToolArgumentValue[] | undefined;
    for (let index = 0; index < value.length; index++) {
      const replacement = replacePlaceholders(value[index], replacementUrls);
      if (replacement !== value[index]) {
        copy ??= value.slice();
        copy[index] = replacement;
      }
    }
    return copy ?? value;
  }

  if (isPlainObject(value)) {
    let copy: Record<string, ToolArgumentValue> | undefined;
    for (const [key, item] of Object.entries(value)) {
      const replacement = replacePlaceholders(item, replacementUrls);
      if (replacement !== item) {
        copy ??= { ...value };
        copy[key] = replacement;
      }
    }
    return copy ?? value;
  }

  return value;
}

export async function resolveUploadedImageArguments({
  forwardUploadedImages,
  toolArguments,
  request,
  user,
  dependencies,
}: {
  forwardUploadedImages?: boolean;
  toolArguments: ToolArgumentValue;
  request?: ImageToolRequest;
  user?: { id?: string };
  dependencies: ImageToolDependencies;
}): Promise<ToolArgumentValue> {
  if (forwardUploadedImages !== true) {
    return toolArguments;
  }

  const placeholders = new Map<string, UploadPlaceholder>();
  collectPlaceholders(toolArguments, placeholders);
  if (placeholders.size === 0) {
    return toolArguments;
  }

  if (!user?.id || !request?.body?.files) {
    throw new UnresolvedUploadedImageError();
  }

  const orderedPlaceholders = [...placeholders.values()].sort(
    (left, right) => left.index - right.index,
  );
  const requestFiles = new Map<string, { file_id: string; mimeType: SupportedImageMime }>();
  for (const placeholder of orderedPlaceholders) {
    const requestFile = request.body.files[placeholder.index];
    const mimeType = normalizeImageMime(requestFile?.type);
    const key = placeholderKey(placeholder);
    if (!requestFile?.file_id || mimeType !== placeholder.mimeType || requestFiles.has(key)) {
      throw new UnresolvedUploadedImageError();
    }
    requestFiles.set(key, { file_id: requestFile.file_id, mimeType });
  }

  const fileIds = [...new Set([...requestFiles.values()].map((file) => file.file_id))];
  if (fileIds.length !== requestFiles.size) {
    throw new UnresolvedUploadedImageError();
  }

  let foundFiles: readonly ImageToolFile[];
  let encodedImages: { image_urls?: Array<{ file_id: string; image_url?: { url?: string } }> };
  try {
    foundFiles = await dependencies.findFiles({ file_id: { $in: fileIds }, user: user.id });
    const filesById = new Map<string, ImageToolFile>();
    for (const file of foundFiles) {
      if (!fileIds.includes(file.file_id) || filesById.has(file.file_id)) {
        throw new UnresolvedUploadedImageError();
      }
      filesById.set(file.file_id, file);
    }
    if (filesById.size !== fileIds.length) {
      throw new UnresolvedUploadedImageError();
    }
    encodedImages = await dependencies.encodeImages(
      request,
      fileIds.map((fileId) => filesById.get(fileId)!),
    );

    const encodedById = new Map<string, { mimeType: SupportedImageMime; url: string }>();
    for (const encodedImage of encodedImages.image_urls ?? []) {
      const dataUrl = parseImageDataUrl(encodedImage.image_url?.url);
      if (
        !dataUrl ||
        !fileIds.includes(encodedImage.file_id) ||
        encodedById.has(encodedImage.file_id)
      ) {
        throw new UnresolvedUploadedImageError();
      }
      encodedById.set(encodedImage.file_id, dataUrl);
    }
    if (encodedById.size !== fileIds.length) {
      throw new UnresolvedUploadedImageError();
    }

    const replacementUrls = new Map<string, string>();
    for (const placeholder of orderedPlaceholders) {
      const key = placeholderKey(placeholder);
      const requestFile = requestFiles.get(key)!;
      const persistedFile = filesById.get(requestFile.file_id)!;
      const dataUrl = encodedById.get(requestFile.file_id)!;
      if (
        normalizeImageMime(persistedFile.type) !== requestFile.mimeType ||
        dataUrl.mimeType !== requestFile.mimeType
      ) {
        throw new UnresolvedUploadedImageError();
      }
      replacementUrls.set(key, dataUrl.url);
    }

    return replacePlaceholders(toolArguments, replacementUrls);
  } catch {
    throw new UnresolvedUploadedImageError();
  }
}
