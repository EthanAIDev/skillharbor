# Run with Windows PowerShell 5.1. Only function definitions are evaluated; never run the installer.
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot '../files/install-workbuddy-skills.ps1'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
  if ($fn.Name -ne 'Log') { . ([scriptblock]::Create($fn.Extent.Text)) }
}
function Log($message) {}
function Assert($ok, $message) { if (-not $ok) { throw $message } }
$utf8 = New-Object System.Text.UTF8Encoding($false)
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('dt-stub-test-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($sandbox) | Out-Null
function Put($path, $content) {
  [IO.Directory]::CreateDirectory((Split-Path -Parent $path)) | Out-Null
  [IO.File]::WriteAllText($path, $content, $utf8)
}
try {
  $base = 'fixture://portal'; $store = $sandbox; $root = Join-Path $sandbox 'wb'; $ledger = Join-Path $sandbox 'managed.json'
  Put (Join-Path $root 'Mine/notes.txt') 'user notes'
  Sync-SkillStubs -items @(@{slug='one';folder='Mine';content='a stub'}) -roots @(@{path=$root;label='WorkBuddy'}) -managedFile $ledger
  Assert (-not (Test-Path -LiteralPath (Join-Path $root 'Mine/SKILL.md'))) 'Foreign directory without SKILL.md was overwritten'
  Assert (([IO.File]::ReadAllText((Join-Path $root 'Mine/notes.txt'))) -ceq 'user notes') 'User notes changed'
  Assert (-not ([IO.File]::ReadAllText($ledger) -match '"one"')) 'Foreign directory was registered'
  Write-Host 'PASS foreign directory without SKILL.md'
  # A blocked ledger update must not destroy the old, usable renamed stub.
  Sync-SkillStubs @(@{slug='safe';folder='Old';content='v1'}) @(@{path=$root;label='WorkBuddy'}) $ledger
  Assert (Test-Path -LiteralPath (Join-Path $root 'Old/SKILL.md')) 'Initial install missing'
  $snapshot = [IO.File]::ReadAllText($ledger) | ConvertFrom-Json
  Assert (Test-SkillOwned $root $snapshot.partitions[0].entries[0]) 'Initial install ownership missing'
  $lock = [IO.File]::Open($ledger, 'Open', 'Read', 'Read')
  try {
    $failed = $false
    try { Sync-SkillStubs @(@{slug='safe';folder='New';content='v2'}) @(@{path=$root;label='WorkBuddy'}) $ledger } catch { $failed = $true }
    Assert $failed 'Ledger lock should fail synchronization'
    Assert (Test-Path -LiteralPath (Join-Path $root 'Old/SKILL.md')) 'Ledger failure deleted old usable stub'
  } finally { $lock.Dispose() }
  Write-Host 'PASS ledger failure retains old stub'
  function Fixture($name) {
    $script:caseRoot = Join-Path $sandbox $name
    $script:caseLedger = Join-Path $caseRoot 'ledger.json'
    $script:wb = Join-Path $caseRoot 'wb'
    $script:trae = Join-Path $caseRoot 'trae'
    $script:wbRoots = @(@{path=$wb;label='WorkBuddy'})
  }
  function Stub($slug='a', $folder='Alpha', $content='original') { return @{slug=$slug;folder=$folder;content=$content} }
  function Sync($catalog, $source='fixture://portal', $targets=$wbRoots) { Sync-SkillStubs $catalog $targets $caseLedger $source }
  function Throws([scriptblock]$action) { $threw=$false; try { & $action } catch { $threw=$true }; Assert $threw 'Expected sync rejection' }
  function Text($path, $expected) { Assert (([IO.File]::ReadAllText($path)) -ceq $expected) ('File changed: ' + $path) }

  Fixture 'foreign-rounds'
  Put (Join-Path $wb 'Alpha/SKILL.md') 'A user discussing 壳技能 and slug="a"'
  Sync @(Stub)
  Sync @(Stub 'a' 'Beta' 'new')
  Sync @(Stub 'b' 'Other')
  Text (Join-Path $wb 'Alpha/SKILL.md') 'A user discussing 壳技能 and slug="a"'
  Assert (-not ([IO.File]::ReadAllText($caseLedger) -match 'Alpha')) 'Foreign stub registered'
  Write-Host 'PASS foreign multi-round rename/offboard and broad marker'

  Fixture 'managed'
  Sync @(Stub)
  Sync @(Stub 'a' 'Alpha' 'updated')
  Text (Join-Path $wb 'Alpha/SKILL.md') 'updated'
  Put (Join-Path $wb 'Alpha/notes.txt') 'keep'
  Sync @(Stub 'a' 'Beta' 'renamed')
  Assert (-not (Test-Path -LiteralPath (Join-Path $wb 'Alpha/SKILL.md'))) 'Old managed stub not removed'
  Text (Join-Path $wb 'Alpha/notes.txt') 'keep'
  Text (Join-Path $wb 'Beta/SKILL.md') 'renamed'
  Sync @(Stub 'b' 'Other')
  Assert (-not (Test-Path -LiteralPath (Join-Path $wb 'Beta'))) 'Offboarded empty directory remains'
  Write-Host 'PASS managed update/rename/offboard, preserves extra file'

  Fixture 'replacement'
  Sync @(Stub)
  Put (Join-Path $wb 'Alpha/SKILL.md') 'user replacement'
  Sync @(Stub 'a' 'Alpha' 'portal update')
  Sync @(Stub 'a' 'Beta' 'rename')
  Sync @(Stub 'b' 'Other')
  Text (Join-Path $wb 'Alpha/SKILL.md') 'user replacement'
  Write-Host 'PASS changed managed content becomes foreign'

  Fixture 'missing-file'
  Sync @(Stub)
  [IO.File]::Delete((Join-Path $wb 'Alpha/SKILL.md'))
  Put (Join-Path $wb 'Alpha/user.txt') 'keep'
  Sync @(Stub)
  Assert (-not (Test-Path -LiteralPath (Join-Path $wb 'Alpha/SKILL.md'))) 'Replaced directory was reclaimed'
  Text (Join-Path $wb 'Alpha/user.txt') 'keep'
  Write-Host 'PASS replaced managed directory without SKILL.md'

  Fixture 'root-source'
  Put (Join-Path $trae 'Alpha/SKILL.md') 'Trae user'
  Sync @(Stub) 'fixture://portal' @(@{path=$wb;label='WorkBuddy'},@{path=$trae;label='Trae'})
  Sync @(Stub 'a' 'Alpha' 'other source') 'fixture://other'
  Text (Join-Path $wb 'Alpha/SKILL.md') 'original'
  Sync @(Stub 'b' 'Other')
  Text (Join-Path $trae 'Alpha/SKILL.md') 'Trae user'
  $data = [IO.File]::ReadAllText($caseLedger) | ConvertFrom-Json
  Assert (@($data.partitions).Count -eq 3) 'Absent root/source partition lost'
  Write-Host 'PASS independent root/source ownership and absent Trae partition'

  Fixture 'partition-case'
  Sync @(Stub) 'https://portal/Team'
  Put (Join-Path $wb 'Alpha/user.txt') 'keep user file'
  Sync @((Stub 'a' 'Alpha' 'other source'),(Stub 'b' 'Beta' 'lower source')) 'https://portal/team'
  Text (Join-Path $wb 'Alpha/SKILL.md') 'original'
  $caseRoots = @(@{path=$wb.ToUpperInvariant();label='WorkBuddy'})
  Sync @((Stub 'a' 'Alpha' 'upper updated'),(Stub 'b' 'Beta' 'upper must not take over')) 'https://portal/Team' $caseRoots
  Text (Join-Path $wb 'Alpha/SKILL.md') 'upper updated'
  Text (Join-Path $wb 'Alpha/user.txt') 'keep user file'
  Text (Join-Path $wb 'Beta/SKILL.md') 'lower source'
  $data = [IO.File]::ReadAllText($caseLedger) | ConvertFrom-Json
  Assert (@($data.partitions).Count -eq 2) 'Root casing created another partition'
  Assert (@($data.partitions | Where-Object { $_.source -ceq 'https://portal/Team' }).Count -eq 1) 'Upper source partition lost'
  Assert (@($data.partitions | Where-Object { $_.source -ceq 'https://portal/team' }).Count -eq 1) 'Lower source partition lost'
  # Read the ledger again after changing root casing, proving it remains usable.
  Sync @((Stub 'a' 'Alpha' 'lower must not take over'),(Stub 'b' 'Beta' 'lower updated')) 'https://portal/team'
  Text (Join-Path $wb 'Alpha/SKILL.md') 'upper updated'
  Text (Join-Path $wb 'Alpha/user.txt') 'keep user file'
  Text (Join-Path $wb 'Beta/SKILL.md') 'lower updated'
  Assert (@(([IO.File]::ReadAllText($caseLedger) | ConvertFrom-Json).partitions).Count -eq 2) 'Partition count changed after reread'
  Write-Host 'PASS repeated source path casing and root casing preserve partition ownership'

  foreach ($version in @('v1','v2')) {
    Fixture ('legacy-' + $version)
    Put (Join-Path $wb 'Alpha/SKILL.md') 'original'
    Put (Join-Path $wb 'Inactive/SKILL.md') '壳技能 legacy orphan'
    if ($version -eq 'v1') { Put $caseLedger '["Alpha","Inactive"]' }
    else { Put $caseLedger '[{"slug":"a","folder":"Alpha"},{"slug":"gone","folder":"Inactive"}]' }
    Sync @(Stub)
    Sync @(Stub 'a' 'Beta' 'new')
    Assert (-not (Test-Path -LiteralPath (Join-Path $wb 'Alpha'))) 'Exact legacy stub not adopted'
    Text (Join-Path $wb 'Inactive/SKILL.md') '壳技能 legacy orphan'
  }
  Write-Host 'PASS v1/v2 exact active adoption; inactive orphan preserved'

  # Evaluate only the portal's template builder, never server.cjs's entry point.
  $serverPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../server.cjs'))
  $js = @'
const fs = require('node:fs');
const source = fs.readFileSync(process.argv[2], 'utf8');
const start = source.indexOf('function buildStub(skill) {');
const end = source.indexOf('\n}', start) + 2;
if (start < 0 || end <= start) throw new Error('Template boundary missing');
const build = new Function(source.slice(start, end) + '; return buildStub;')();
console.log(JSON.stringify(build({slug:'legacy-real', display_name:'Legacy template', description:'migration'})));
'@
  $realStub = ($js | node - $serverPath) | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or -not $realStub.content) { throw 'Could not load actual portal template' }
  Fixture 'actual-legacy-template'
  Put (Join-Path $wb ($realStub.folder + '/SKILL.md')) $realStub.content
  Put $caseLedger (ConvertTo-Json -InputObject @(@{slug=$realStub.slug;folder=$realStub.folder}))
  Sync @($realStub)
  $realStub.folder = 'Migrated'
  Sync @($realStub)
  Text (Join-Path $wb 'Migrated/SKILL.md') $realStub.content
  Assert (-not (Test-Path -LiteralPath (Join-Path $wb 'Legacy template'))) 'Actual legacy template not migrated'
  Write-Host 'PASS actual buildStub legacy template adoption and rename'

  Fixture 'conflict'
  Sync @(Stub)
  Put (Join-Path $wb 'Beta/user.txt') 'keep'
  Sync @(Stub 'a' 'Beta' 'new')
  Text (Join-Path $wb 'Alpha/SKILL.md') 'original'
  Sync @(Stub 'b' 'Alpha' 'reuse')
  Text (Join-Path $wb 'Alpha/SKILL.md') 'original'
  Text (Join-Path $wb 'Beta/user.txt') 'keep'
  Write-Host 'PASS rename conflict retains old stub; slug reuse cannot erase it'

  Fixture 'catalog'
  Sync @((Stub),(Stub 'b' 'Beta' 'second'))
  $before = [IO.File]::ReadAllText($caseLedger)
  foreach ($bad in @(
    @((Stub),(Stub 'a' 'Duplicate')),
    @((Stub 'a' 'Same/Name'),(Stub 'b' 'Same:Name')),
    @(@{slug='a';folder='Alpha'}),
    @((Stub '../escape' 'Evil')),
    @((Stub 'a' '..'))
  )) { Throws { Sync $bad }; Text $caseLedger $before }
  Sync @((Stub 'a' 'Beta' 'swap-a'),(Stub 'b' 'Alpha' 'swap-b'))
  Text (Join-Path $wb 'Alpha/SKILL.md') 'original'
  Text (Join-Path $wb 'Beta/SKILL.md') 'second'
  Sync @()
  Text (Join-Path $wb 'Alpha/SKILL.md') 'original'
  Write-Host 'PASS whole catalog validation, collision, name swap, empty catalog'

  Fixture 'bad-ledgers'
  Sync @(Stub)
  foreach ($bad in @('{broken','{"version":4,"partitions":[]}','{"surprise":true}',
    ('{"version":3,"partitions":[{"root":' + (ConvertTo-Json $wb) + ',"source":"fixture://portal","entries":[{"slug":"a","folder":"../outside","sha256":"' + ('a'*64) + '"}]}]}'))) {
    Put $caseLedger $bad
    Throws { Sync @(Stub 'b' 'Other') }
    Text (Join-Path $wb 'Alpha/SKILL.md') 'original'
    Text $caseLedger $bad
  }
  Write-Host 'PASS corrupt/unknown/path-escaping ledger fails closed'

  Fixture 'read-failure'
  Sync @(Stub)
  $file = Join-Path $wb 'Alpha/SKILL.md'
  $handle = [IO.File]::Open($file, 'Open', 'Read', 'None')
  try { Sync @(Stub 'a' 'Alpha' 'new') } finally { $handle.Dispose() }
  Text $file 'original'
  Write-Host 'PASS unreadable stub not overwritten'

  Fixture 'write-failure'
  Sync @(Stub)
  $file = Join-Path $wb 'Alpha/SKILL.md'
  $handle = [IO.File]::Open($file, 'Open', 'Read', 'Read')
  try { Throws { Sync @(Stub 'a' 'Alpha' 'new') } } finally { $handle.Dispose() }
  Text $file 'original'
  Write-Host 'PASS atomic replacement failure retains original'

  Fixture 'links'
  Sync @(Stub)
  $outside = Join-Path $caseRoot 'outside'
  Put (Join-Path $outside 'sentinel.txt') 'outside'
  $junction = Join-Path $wb 'Alpha/nested'
  $linkMade = $false
  try {
    try { New-Item -ItemType Junction -Path $junction -Value $outside -ErrorAction Stop | Out-Null; $linkMade=$true } catch { Write-Host ('SKIP junction creation unavailable: ' + $_.Exception.Message) }
    if ($linkMade) {
      Sync @(Stub 'b' 'Other')
      Text (Join-Path $wb 'Alpha/SKILL.md') 'original'
      Text (Join-Path $outside 'sentinel.txt') 'outside'
      Write-Host 'PASS nested junction rejects offboard'
    }
  } finally { if ($linkMade) { [IO.Directory]::Delete($junction) } }
  $junction = Join-Path $caseRoot 'linked-root'
  $linkMade=$false
  try {
    try { New-Item -ItemType Junction -Path $junction -Value $outside -ErrorAction Stop | Out-Null; $linkMade=$true } catch { Write-Host ('SKIP root junction creation unavailable: ' + $_.Exception.Message) }
    if ($linkMade) {
      Throws { Sync @(Stub) 'fixture://portal' @(@{path=(Join-Path $junction 'skills');label='Unsafe'}) }
      Assert (-not (Test-Path -LiteralPath (Join-Path $outside 'skills'))) 'Root ancestor link was followed'
      Text (Join-Path $outside 'sentinel.txt') 'outside'
      Write-Host 'PASS root ancestor junction rejects writes'
    }
  } finally { if ($linkMade) { [IO.Directory]::Delete($junction) } }

  Fixture 'directory-link'
  $outside = Join-Path $caseRoot 'outside'
  Put (Join-Path $outside 'SKILL.md') 'outside user'
  [IO.Directory]::CreateDirectory($wb) | Out-Null
  $junction = Join-Path $wb 'Alpha'
  $linkMade = $false
  try {
    try { New-Item -ItemType Junction -Path $junction -Value $outside -ErrorAction Stop | Out-Null; $linkMade=$true } catch { Write-Host ('SKIP directory junction unavailable: ' + $_.Exception.Message) }
    if ($linkMade) {
      Throws { Sync @(Stub) }
      Text (Join-Path $outside 'SKILL.md') 'outside user'
      Write-Host 'PASS incoming directory junction protects outside file'
    }
  } finally { if ($linkMade) { [IO.Directory]::Delete($junction) } }

  Fixture 'file-link'
  $outsideFile = Join-Path $caseRoot 'outside.txt'
  Put $outsideFile 'outside user'
  [IO.Directory]::CreateDirectory((Join-Path $wb 'Alpha')) | Out-Null
  $fileLink = Join-Path $wb 'Alpha/SKILL.md'
  $linkMade = $false
  try {
    try { New-Item -ItemType SymbolicLink -Path $fileLink -Value $outsideFile -ErrorAction Stop | Out-Null; $linkMade=$true } catch { Write-Host ('SKIP file symlink unavailable: ' + $_.Exception.Message) }
    if ($linkMade) {
      Sync @(Stub)
      Text $outsideFile 'outside user'
      Write-Host 'PASS file symlink protects outside file'
    }
  } finally { if ($linkMade) { [IO.File]::Delete($fileLink) } }

  Fixture 'hardlink'
  Sync @(Stub)
  $hard = Join-Path $caseRoot 'outside.txt'
  New-Item -ItemType HardLink -Path $hard -Value (Join-Path $wb 'Alpha/SKILL.md') | Out-Null
  Sync @(Stub 'a' 'Alpha' 'new')
  Text $hard 'original'
  Text (Join-Path $wb 'Alpha/SKILL.md') 'new'
  Write-Host 'PASS atomic stub replacement does not write through hardlink'
  Write-Host ('PASS Windows PowerShell ' + $PSVersionTable.PSVersion)


} finally {
  $resolved = [IO.Path]::GetFullPath($sandbox)
  if ((Split-Path -Parent $resolved) -ne [IO.Path]::GetTempPath().TrimEnd('\')) { throw 'Unsafe test cleanup boundary' }
  # Every link fixture unlinks in its own finally block before this recursive cleanup.
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
