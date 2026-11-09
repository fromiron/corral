// The Files tree, built from the server's file listing. A listing is recursive: the files under
// one folder (or the root), at most 500, with `truncated` when there were more. A folder is
// complete once a listing at it or above it was not truncated; only an incomplete folder needs
// its own listing when it is expanded.

export interface FolderListing {
  files: readonly { path: string; bytes: number }[];
  truncated: boolean;
}

export interface TreeRow {
  kind: 'folder' | 'file';
  path: string;
  name: string;
  /** 1 at the root. */
  level: number;
  /** The containing folder, or null at the root. */
  parent: string | null;
  posInSet: number;
  setSize: number;
  expanded?: boolean;
  /** This folder's own listing hit the limit. */
  truncated?: boolean;
  loading?: boolean;
  failed?: boolean;
}

interface Folder {
  folders: Set<string>;
  files: Set<string>;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const parentOf = (path: string) => {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
};
const byName = (a: string, b: string) => collator.compare(nameOf(a), nameOf(b)) || (a < b ? -1 : 1);

function index(listings: ReadonlyMap<string, FolderListing>) {
  const folders = new Map<string, Folder>([['', { folders: new Set(), files: new Set() }]]);
  const folder = (path: string): Folder => {
    let found = folders.get(path);
    if (!found) {
      found = { folders: new Set(), files: new Set() };
      folders.set(path, found);
      folder(parentOf(path)).folders.add(path);
    }
    return found;
  };
  for (const listing of listings.values())
    for (const { path } of listing.files) folder(parentOf(path)).files.add(path);
  return folders;
}

/** Whether expanding `folder` must read its own listing to show everything the server has. */
export function needsListing(folder: string, listings: ReadonlyMap<string, FolderListing>) {
  if (listings.has(folder)) return false;
  for (let at = folder; ; at = parentOf(at)) {
    const listing = listings.get(at);
    if (listing && !listing.truncated) return false;
    if (!at) return true;
  }
}

/**
 * The rows on screen, depth first: folders before files, by name. A query shows only files whose
 * path contains it, with their folders open unless closed while filtering (`collapsed`).
 */
export function visibleRows(
  listings: ReadonlyMap<string, FolderListing>,
  {
    expanded,
    query = '',
    collapsed = new Set(),
    loading = new Set(),
    failed = new Set(),
  }: {
    expanded: ReadonlySet<string>;
    query?: string;
    collapsed?: ReadonlySet<string>;
    loading?: ReadonlySet<string>;
    failed?: ReadonlySet<string>;
  },
): TreeRow[] {
  const folders = index(listings);
  const needle = query.trim().toLowerCase();
  // While filtering, the folders on the way to a match.
  const matched = needle ? new Set<string>() : null;
  if (matched)
    for (const [, folder] of folders)
      for (const path of folder.files)
        if (path.toLowerCase().includes(needle))
          for (let at = parentOf(path); at; at = parentOf(at)) matched.add(at);
  const rows: TreeRow[] = [];
  const walk = (path: string, level: number) => {
    const folder = folders.get(path);
    if (!folder) return;
    const children = [
      ...[...folder.folders].filter((child) => !matched || matched.has(child)).sort(byName),
      ...[...folder.files]
        .filter((child) => !needle || child.toLowerCase().includes(needle))
        .sort(byName),
    ];
    children.forEach((child, position) => {
      const isFolder = folder.folders.has(child);
      const open = isFolder && (matched ? !collapsed.has(child) : expanded.has(child));
      rows.push({
        kind: isFolder ? 'folder' : 'file',
        path: child,
        name: nameOf(child),
        level,
        parent: path || null,
        posInSet: position + 1,
        setSize: children.length,
        ...(isFolder
          ? {
              expanded: open,
              truncated: Boolean(listings.get(child)?.truncated),
              loading: loading.has(child),
              failed: failed.has(child),
            }
          : {}),
      });
      if (open) walk(child, level + 1);
    });
  };
  walk('', 1);
  return rows;
}
