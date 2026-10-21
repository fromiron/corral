import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Node's chmod only changes the read-only flag on Windows, not its DACL.
// Use the OS ACL API with literal paths in an environment value, never shell text.
// SYSTEM and Administrators retain the access already implicit in their OS privileges.
const aclScript = `
$ErrorActionPreference = 'Stop'
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed = @($current.Value, 'S-1-5-18', 'S-1-5-32-544')
$results = @()
foreach ($encodedPath in $env:CORRAL_PRIVATE_PATHS.Split(';')) {
  $path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedPath))
  $attributes = [IO.File]::GetAttributes($path)
  if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Unsupported credential path' }
  $directory = ($attributes -band [IO.FileAttributes]::Directory) -ne 0
  if ($env:CORRAL_PRIVATE_ACTION -eq 'protect') {
    if ($directory) {
      $acl = [System.Security.AccessControl.DirectorySecurity]::new()
      $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    } else {
      $acl = [System.Security.AccessControl.FileSecurity]::new()
      $inheritance = [Security.AccessControl.InheritanceFlags]::None
    }
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($current)
    foreach ($sid in $allowed) {
      $identity = [System.Security.Principal.SecurityIdentifier]::new($sid)
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $identity, [Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance, [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow)
      $acl.AddAccessRule($rule)
    }
    if ($directory) { [IO.Directory]::SetAccessControl($path, $acl) }
    else { [IO.File]::SetAccessControl($path, $acl) }
  }
  if ($directory) { $readback = [IO.Directory]::GetAccessControl($path) }
  else { $readback = [IO.File]::GetAccessControl($path) }
  $owner = $readback.GetOwner([Security.Principal.SecurityIdentifier]).Value
  $private = $allowed -contains $owner
  $currentAllowed = $false
  foreach ($rule in $readback.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
      if ($allowed -notcontains $rule.IdentityReference.Value) { $private = $false }
      if ($rule.IdentityReference.Value -eq $current.Value) { $currentAllowed = $true }
    }
  }
  $results += ($private -and $currentAllowed).ToString().ToLowerInvariant()
}
'[' + [string]::Join(',', $results) + ']'
`;

function windowsPermissions(paths: string[], protect: boolean): boolean[] {
  try {
    const output = execFileSync(
      join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-EncodedCommand',
        Buffer.from(aclScript, 'utf16le').toString('base64'),
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 4096,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          CORRAL_PRIVATE_PATHS: paths
            .map((path) => Buffer.from(resolve(path), 'utf8').toString('base64'))
            .join(';'),
          CORRAL_PRIVATE_ACTION: protect ? 'protect' : 'inspect',
        },
      },
    );
    const result: unknown = JSON.parse(output);
    if (
      !Array.isArray(result) ||
      result.length !== paths.length ||
      result.some((value) => typeof value !== 'boolean')
    )
      throw new Error();
    return result;
  } catch {
    // Child process errors contain command/environment paths. Do not expose those.
    throw new Error('Private credential permissions could not be verified.');
  }
}

/** Read-only check. Null means inspection failed; it never means verified private. */
export function privatePermissions(path: string): boolean | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() && !stat.isDirectory()) return null;
    return process.platform === 'win32'
      ? (windowsPermissions([path], false)[0] ?? null)
      : (stat.mode & 0o077) === 0;
  } catch {
    return null;
  }
}

/** Only for Corral-owned credential paths, never a borrowed login or workspace. */
export function protectPrivatePaths(paths: string[]): void {
  for (const path of paths) {
    const stat = lstatSync(path);
    if (!stat.isFile() && !stat.isDirectory())
      throw new Error('Unsupported private credential path.');
  }
  if (process.platform === 'win32') {
    if (!windowsPermissions(paths, true).every(Boolean))
      throw new Error('Private credential permissions could not be established.');
  } else {
    for (const path of paths) chmodSync(path, lstatSync(path).isDirectory() ? 0o700 : 0o600);
  }
}

export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  protectPrivatePaths([path]);
}
