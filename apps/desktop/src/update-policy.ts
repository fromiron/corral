export interface UpdateChannel {
  url: string;
  channel: string;
  publisherName?: string;
}

/** A release owner supplies the feed; Corral never selects a public service itself. */
export function updateChannel(value: unknown, platform: string): UpdateChannel {
  if (!value || typeof value !== 'object') throw new Error('Update channel is not configured');
  const input = value as Record<string, unknown>;
  const url = new URL(String(input.url));
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('The update feed must be an HTTPS URL without credentials');
  if (typeof input.channel !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(input.channel))
    throw new Error('Invalid update channel');
  if (
    platform === 'win32' &&
    (typeof input.publisherName !== 'string' ||
      !input.publisherName.trim() ||
      input.publisherName.length > 200 ||
      /[\r\n]/.test(input.publisherName))
  )
    throw new Error('Windows updates require the release publisher name');
  return {
    url: url.href,
    channel: input.channel,
    ...(platform === 'win32' ? { publisherName: String(input.publisherName).trim() } : {}),
  };
}

/** Unknown storage compatibility must be resolved by the release owner before restart. */
export function compatibleUpdate(value: unknown, storageVersion: number): boolean {
  if (!value || typeof value !== 'object') return false;
  const info = value as {
    corralSchemaVersions?: unknown;
    files?: unknown;
    corralStorage?: { minVersion?: unknown; maxVersion?: unknown };
  };
  const minimum = info.corralStorage?.minVersion;
  const maximum = info.corralStorage?.maxVersion;
  if (
    !Number.isSafeInteger(storageVersion) ||
    storageVersion < 0 ||
    !Number.isSafeInteger(minimum) ||
    !Number.isSafeInteger(maximum) ||
    Number(minimum) < 0 ||
    Number(maximum) < Number(minimum) ||
    storageVersion < Number(minimum) ||
    storageVersion > Number(maximum)
  )
    return false;
  return (
    Array.isArray(info.corralSchemaVersions) &&
    info.corralSchemaVersions.includes('0.1') &&
    Array.isArray(info.files) &&
    info.files.length > 0 &&
    info.files.every((file) => {
      if (
        !file ||
        typeof file !== 'object' ||
        typeof file.url !== 'string' ||
        typeof file.sha512 !== 'string' ||
        !file.sha512
      )
        return false;
      try {
        const url = new URL(file.url, 'https://release.invalid/');
        return url.protocol === 'https:' && !url.username && !url.password;
      } catch {
        return false;
      }
    })
  );
}
