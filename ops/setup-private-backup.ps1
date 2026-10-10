param([string]$RuntimeRoot = (Join-Path $env:USERPROFILE 'KnowLadderRuntime'))
$ErrorActionPreference='Stop'
$RuntimeRoot=[IO.Path]::GetFullPath($RuntimeRoot)
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($RuntimeRoot -eq $repo -or $RuntimeRoot.StartsWith($repo+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'BACKUP_OUTSIDE_REPOSITORY_REQUIRED' }
$forbiddenRoots=@([IO.Path]::GetPathRoot($RuntimeRoot),[IO.Path]::GetFullPath($env:USERPROFILE),[IO.Path]::GetFullPath($env:SystemRoot),[IO.Path]::GetFullPath($env:ProgramFiles))
foreach ($forbidden in $forbiddenRoots) {
 if ($RuntimeRoot.TrimEnd('\') -eq $forbidden.TrimEnd('\')) { throw 'DEDICATED_RUNTIME_DIRECTORY_REQUIRED' }
}
foreach ($forbidden in @($env:SystemRoot,$env:ProgramFiles)) {
 $base=[IO.Path]::GetFullPath($forbidden)
 if ($RuntimeRoot.StartsWith($base+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'DEDICATED_RUNTIME_DIRECTORY_REQUIRED' }
}
$ancestor=$RuntimeRoot
while ($ancestor) {
 if (Test-Path -LiteralPath $ancestor) { $item=Get-Item -LiteralPath $ancestor -Force; if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'UNSAFE_RUNTIME_ANCESTOR' } }
 $parent=[IO.Directory]::GetParent($ancestor)
 if ($null -eq $parent) { break }
 $ancestor=$parent.FullName
}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
foreach ($directory in @($RuntimeRoot,(Join-Path $RuntimeRoot 'backup-keys'),(Join-Path $RuntimeRoot 'file-backups'))) {
 if (!(Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory | Out-Null }
 $item=Get-Item -LiteralPath $directory -Force
 if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'UNSAFE_BACKUP_DIRECTORY' }
 $acl=New-Object Security.AccessControl.DirectorySecurity
 $acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
 foreach ($value in @($sid.Value,'S-1-5-18','S-1-5-32-544')) {
  $identity=New-Object Security.Principal.SecurityIdentifier($value)
  $rule=New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule)
 }
 Set-Acl -LiteralPath $directory -AclObject $acl
}
$keyFile=Join-Path $RuntimeRoot 'backup-keys/private-files.key'
if (!(Test-Path -LiteralPath $keyFile)) {
 $bytes=New-Object byte[] 32;$rng=[Security.Cryptography.RandomNumberGenerator]::Create()
 try {$rng.GetBytes($bytes);$handle=New-Object IO.FileStream($keyFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try {$handle.Write($bytes,0,$bytes.Length);$handle.Flush($true)} finally {$handle.Dispose()}} finally {$rng.Dispose();[Array]::Clear($bytes,0,$bytes.Length)}
} else {
 $item=Get-Item -LiteralPath $keyFile -Force
 if ($item.PSIsContainer -or $item.Length -ne 32 -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'BACKUP_KEY_INVALID' }
}
Write-Output 'PRIVATE_FILE_BACKUP_KEY_AND_DIRECTORY_READY'
