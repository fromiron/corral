import { fileURLToPath } from 'node:url';
import { PackageInspection, PinnedPackageSource } from '@corral/contracts';
import { sdkProcessChannel } from './channel.ts';

const PACKAGE_ENTRY = fileURLToPath(new URL('./package-worker-main.ts', import.meta.url));

/** No SDK or native extension is imported into the server process. */
export async function inspectPiPackage(directory: string): Promise<PackageInspection> {
  return packageRequest({ type: 'inspect', directory }, 15_000);
}

/** Download into a quarantine directory. Does not trust, bind or import the result. */
export async function downloadPiPackage(
  source: string,
  directory: string,
): Promise<PackageInspection> {
  if (!PinnedPackageSource.safeParse(source).success)
    throw new Error('package source must be pinned and contain no credentials');
  return packageRequest({ type: 'install', source, directory }, 180_000);
}

function packageRequest(
  request: { type: 'inspect' | 'install'; directory: string; source?: string },
  timeoutMs: number,
): Promise<PackageInspection> {
  const channel = sdkProcessChannel(PACKAGE_ENTRY);
  return new Promise((resolve, reject) => {
    let result: PackageInspection | undefined;
    let failed = false;
    const timer = setTimeout(() => {
      failed = true;
      channel.kill();
    }, timeoutMs);
    channel.onFrame((raw) => {
      const frame = raw as { type?: string; inspection?: unknown };
      if (frame.type === 'ready') channel.send(request);
      else if (frame.type === 'inspected') {
        const parsed = PackageInspection.safeParse(frame.inspection);
        if (parsed.success) result = parsed.data;
        else {
          failed = true;
          channel.kill();
        }
      } else {
        failed = true;
        channel.kill();
      }
    });
    channel.onExit((code) => {
      clearTimeout(timer);
      if (failed || code !== 0 || !result) reject(new Error('Pi package inspection failed'));
      else resolve(result);
    });
  });
}
