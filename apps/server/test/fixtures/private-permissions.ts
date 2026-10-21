import { execFileSync } from 'node:child_process';
import { chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { protectPrivatePaths } from '../../src/private-files.ts';

// Independent OS readback; chmod/stat do not represent a Windows DACL.
function windowsAcl(path: string, worldReadable = false) {
  const script = `
$ErrorActionPreference = 'Stop'
$path = $env:CORRAL_ACL_TEST_PATH
$directory = [IO.Directory]::Exists($path)
if ($directory) { $acl = [IO.Directory]::GetAccessControl($path) }
else { $acl = [IO.File]::GetAccessControl($path) }
if ($env:CORRAL_ACL_TEST_SHARED -eq 'yes') {
  $everyone = New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
    $everyone, [Security.AccessControl.FileSystemRights]::Read,
    [Security.AccessControl.AccessControlType]::Allow)))
  [IO.File]::SetAccessControl($path, $acl)
  $acl = [IO.File]::GetAccessControl($path)
}
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) |
  Where-Object { $_.AccessControlType -eq 'Allow' } |
  ForEach-Object { $_.IdentityReference.Value })
@{current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; allow=$rules} |
  ConvertTo-Json -Compress
`;
  return JSON.parse(
    execFileSync(
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
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          CORRAL_ACL_TEST_PATH: path,
          CORRAL_ACL_TEST_SHARED: worldReadable ? 'yes' : 'no',
        },
      },
    ),
  ) as { current: string; allow: string[] };
}

export function fixturePermissions(path: string, mode: number) {
  if (process.platform !== 'win32') return chmodSync(path, mode);
  protectPrivatePaths([path]);
  if ((mode & 0o077) !== 0) {
    const { allow } = windowsAcl(path, true);
    // A real non-owner grant makes the negative meaningful on Windows.
    expect(allow.includes('S-1-1-0')).toBe(true);
  }
}

export function expectPrivatePermissions(path: string, mode: number) {
  if (process.platform !== 'win32') {
    expect(statSync(path).mode & 0o777).toBe(mode);
    return;
  }
  const { current, allow } = windowsAcl(path);
  const permitted = new Set([current, 'S-1-5-18', 'S-1-5-32-544']);
  // Do not print local identity SIDs even when the assertion fails.
  expect(allow.includes(current)).toBe(true);
  expect(allow.every((sid) => permitted.has(sid))).toBe(true);
}
