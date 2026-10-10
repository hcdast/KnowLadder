param([string]$RuntimeRoot = (Join-Path $env:USERPROFILE 'KnowLadderRuntime'))
$ErrorActionPreference = 'Stop'
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($RuntimeRoot.StartsWith($repoRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or $RuntimeRoot -eq $repoRoot) { throw 'RUNTIME_OUTSIDE_REPOSITORY_REQUIRED' }
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
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
function PrivateDirectory([string]$targetPath) {
 if (!(Test-Path -LiteralPath $targetPath)) { New-Item -ItemType Directory -Path $targetPath | Out-Null }
 $item = Get-Item -LiteralPath $targetPath -Force
 if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'UNSAFE_RUNTIME_DIRECTORY' }
 $acl = New-Object Security.AccessControl.DirectorySecurity
 $acl.SetOwner($currentSid); $acl.SetAccessRuleProtection($true,$false)
 foreach ($sid in @($currentSid.Value,'S-1-5-18','S-1-5-32-544')) {
  $identity = New-Object Security.Principal.SecurityIdentifier($sid)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  $acl.AddAccessRule($rule)
 }
 Set-Acl -LiteralPath $targetPath -AclObject $acl
}
PrivateDirectory $RuntimeRoot
$scannerRoot = Join-Path $RuntimeRoot 'clamav'
$databaseRoot = Join-Path $RuntimeRoot 'clamav-db'
$storageRoot = Join-Path $RuntimeRoot 'files'
foreach ($targetPath in @($scannerRoot,$databaseRoot,$storageRoot)) { PrivateDirectory $targetPath }
foreach ($area in @('tmp','quarantine','ready')) { PrivateDirectory (Join-Path $storageRoot $area) }
$scanner = Get-ChildItem -LiteralPath $scannerRoot -Filter 'clamscan.exe' -Recurse | Select-Object -First 1
if (!$scanner) {
 & node (Join-Path $PSScriptRoot 'download-clamav.cjs') $RuntimeRoot
 if ($LASTEXITCODE -ne 0) { throw 'OFFICIAL_CLAMAV_DOWNLOAD_FAILED' }
 $scanner = Get-ChildItem -LiteralPath $scannerRoot -Filter 'clamscan.exe' -Recurse | Select-Object -First 1
 if (!$scanner) { throw 'CLAMSCAN_EXECUTABLE_MISSING' }
}
$freshclam = Join-Path $scanner.DirectoryName 'freshclam.exe'
$config = Join-Path $RuntimeRoot 'freshclam.conf'
[IO.File]::WriteAllText($config,'DatabaseDirectory "'+$databaseRoot+'"'+[Environment]::NewLine+'DatabaseMirror database.clamav.net'+[Environment]::NewLine+'ConnectTimeout 10'+[Environment]::NewLine+'ReceiveTimeout 120'+[Environment]::NewLine+'MaxAttempts 2'+[Environment]::NewLine)
& $freshclam '--quiet' '--stdout' ('--config-file='+$config)
if ($LASTEXITCODE -ne 0) { throw 'FRESHCLAM_UPDATE_FAILED' }
Write-Output 'CLAMAV_AND_OFFICIAL_DATABASE_READY'
