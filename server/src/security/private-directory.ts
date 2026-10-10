import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

export async function assertWindowsPrivateDirectory(parent: string, children: readonly string[] = []): Promise<void> {
  if (children.some(name => !/^[A-Za-z0-9_-]+$/.test(name))) throw new Error('无效私有子目录');
  // Conservative ACL allow-list, not an effective-permissions approximation:
  // unknown principals are rejected even when another deny ACE might restrict them.
  const script = `
$ErrorActionPreference = 'Stop'
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted = @($currentSid, 'S-1-5-18', 'S-1-5-32-544')
$trustedOwners = $trusted + @('S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$path = $env:KNOWLADDER_SECRET_PARENT
if ($path.StartsWith('\\\\')) { throw 'Network paths are not supported' }
$first = $true
$destructive = [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
while ($path) {
  $item = Get-Item -LiteralPath $path -Force
  if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe directory' }
  $acl = Get-Acl -LiteralPath $path
  if ($trustedOwners -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'Untrusted owner' }
  if ($first -and !$acl.AreAccessRulesProtected) { throw 'Private directory requires protected DACL' }
  $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
  if ($rules.Count -eq 0) { throw 'Empty ACL' }
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
    if ($trusted -contains $rule.IdentityReference.Value) { continue }
    if ($first) { throw 'Private directory permits an untrusted principal' }
    if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and ($rule.FileSystemRights -band $destructive)) { throw 'Ancestor permits path replacement' }
  }
  $first = $false
  $next = [IO.Directory]::GetParent($path)
  if ($null -eq $next) { break }
  $path = $next.FullName
}
foreach ($name in (ConvertFrom-Json $env:KNOWLADDER_PRIVATE_CHILDREN)) {
  $child = Join-Path $env:KNOWLADDER_SECRET_PARENT $name
  $item = Get-Item -LiteralPath $child -Force
  if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe private child' }
  $acl = Get-Acl -LiteralPath $child
  if ($trusted -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'Untrusted private child owner' }
  $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
  if ($rules.Count -eq 0) { throw 'Empty private child ACL' }
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $trusted -notcontains $rule.IdentityReference.Value) { throw 'Private child permits an untrusted principal' }
  }
}
`;
  try {
    await promisify(execFile)(
      resolve(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        timeout: 10000,
        env: { ...process.env, PSModulePath: resolve(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/Modules"), KNOWLADDER_SECRET_PARENT: parent, KNOWLADDER_PRIVATE_CHILDREN: JSON.stringify(children) },
      },
    );
  } catch {
    throw new Error("Windows目录不满足受保护私密ACL及可信祖先要求，或无法核验");
  }
}
