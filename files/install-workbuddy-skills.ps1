# SkillHarbor Skill Center - one-click setup for WorkBuddy AND Trae
# Does three things: 1) configure skillharbor-ai-gateway MCP (WorkBuddy + any detected Trae install)
#                    2) install skill stubs (WorkBuddy skill folder + Trae skill folders)
#                    3) ensure auto-sync
# Run interactively via install-workbuddy-skills.bat, or -Silent via the registered mechanisms.
# NOTE: this file must be saved as UTF-8 WITH BOM (Chinese UI text below).
#
# Auto-sync fires at every logon AND every 15 minutes, so a skill published on the
# portal reaches this machine within ~15 min with no user action. WorkBuddy needs
# a restart to re-read the skill folder; Trae auto-discovers new skill folders live
# (verified 2026-10-28), only its MCP connector wants an app restart.
#
# ALL task actions go through the wscript hidden launcher (GUI-subsystem host, and
# WshShell.Run window-style 0 creates the console hidden from the very start).
# powershell.exe -WindowStyle Hidden alone STILL flashes a console window briefly -
# unacceptable for a task that fires every 15 minutes. If Windows Script Host is
# unavailable we fall back to the powershell-direct action (brief flash possible).
#
# Persistence chain (registration is idempotent - /F overwrites - and runs on every
# pass, which also migrates older logon-only installs to the 15-min schedule):
#   4a. schtasks.exe ONLOGON task + separate every-15-min task
#   4b. Task Scheduler service API (Register-ScheduledTask) - one task, both triggers
#   4c. HKCU registry Run key (wscript hidden launcher) - no Task Scheduler involved
#   4d. Startup folder .vbs copy - pure filesystem, always available
# The chain also self-heals: every run (including silent ones) re-registers if all
# mechanisms were removed, so one execution really does keep skills updated forever.
param([switch]$Silent, [string]$GatewayToken = '')
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$base = $env:SKILLHARBOR_PORTAL
if (-not $base) { $base = 'http://127.0.0.1:8900' }
$taskName = $env:SKILLHARBOR_TASK
if (-not $taskName) { $taskName = 'SkillHarborSkillCenterSync' }
$wbHome = $env:SKILLHARBOR_WB_HOME
if (-not $wbHome) { $wbHome = Join-Path $env:USERPROFILE '.workbuddy' }
$skillsRoot = Join-Path $wbHome 'skills'
$mcpPath = Join-Path $wbHome 'mcp.json'
$store = Join-Path $env:LOCALAPPDATA 'SkillHarborSkillCenter'
$managedFile = Join-Path $store 'managed.json'
$logFile = Join-Path $store 'sync.log'
$runKeyPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$ascii = New-Object System.Text.UTF8Encoding($false)
$taskName15 = $taskName + '-Every15Min'

# 进程互斥：登录触发的多机制实例与 15 分钟任务可能并发，同时写 mcp.json 会撕裂文件
# （撕裂 → 下轮"坏 JSON"分支 → 每轮一个 .bak）。抢不到锁 = 已有实例在跑，本次直接退出。
$singleLock = New-Object System.Threading.Mutex($false, 'Local\SkillHarborSkillCenterSync')
if (-not $singleLock.WaitOne(0)) {
  if (-not $Silent) { Write-Host '已有同步进程在运行，本次跳过（下次定时任务自动补上）。' }
  exit 0
}

function Log($msg) {
  # 防线③：单条消息硬截断——任何来源（门户数据、异常详情）都不允许产出巨型日志行
  if ($msg -and $msg.Length -gt 1000) {
    $msg = $msg.Substring(0, 1000) + (' …[+' + ($msg.Length - 1000) + ' chars omitted]')
  }
  $line = ('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $msg)
  if (-not $Silent) { Write-Host $line }
  try {
    New-Item -ItemType Directory -Force -Path $store | Out-Null
    # AppendAllText（显式 UTF-8 无 BOM）：字节级确定性写入，编码行为不随宿主/控制台状态变化
    [System.IO.File]::AppendAllText($logFile, $line + [Environment]::NewLine, $ascii)
  } catch {}
}

# keep sync.log bounded。事故教训（2026-10）：网关侧曾出现巨型乱码技能名，技能名单日志行
# 单条几 MB、每 15 分钟一条，sync.log 涨到 25GB 撑爆 C 盘。防线：
#   ① >64MB 直接删除重建，绝不扫描（Get-Content 在 GB 级文件上会卡死），顺带清理事故残留
#   ② 常规限幅按字节预算从尾部回收（旧逻辑按行数 Tail 400，遇巨行截完依然巨大）
#   ③ Log() 单条截断（见上），根治写入端
try {
  if (Test-Path -LiteralPath $logFile) {
    $logLen = (Get-Item -LiteralPath $logFile).Length
    if ($logLen -gt 64MB) {
      Remove-Item -LiteralPath $logFile -Force
      Log ('sync.log was ' + [math]::Round($logLen / 1MB) + 'MB (giant-line incident remnant) - deleted, starting fresh')
    } elseif ($logLen -gt 262144) {
      $lines = @(Get-Content -LiteralPath $logFile -Tail 400)
      $out = New-Object System.Collections.Generic.List[string]
      $budget = 0
      for ($i = $lines.Count - 1; $i -ge 0; $i--) {
        $budget += ($lines[$i].Length * 3) + 8   # UTF-8 每字最多 3 字节 + 换行，粗上界即可
        if ($budget -gt 131072) { break }
        $out.Insert(0, $lines[$i])
      }
      [System.IO.File]::WriteAllLines($logFile, $out, $ascii)
    }
  }
} catch {}

# Upsert one server entry in an mcp.json ("mcpServers" map, other servers preserved).
# $fields is an ordered hashtable of the entry's own fields. Returns $true when the file changed.
function Remove-McpServer([string]$jsonPath, [string[]]$names) {
  # 迁移清理：删除指定旧名条目（如 dt-skills → skillharbor-ai-gateway 时避免重复连接器）
  if (-not (Test-Path -LiteralPath $jsonPath)) { return }
  try { $cfg = [System.IO.File]::ReadAllText($jsonPath) | ConvertFrom-Json } catch { return }
  $servers = $cfg.PSObject.Properties['mcpServers'].Value
  if ($null -eq $servers) { return }
  $changed = $false
  foreach ($n in $names) {
    if ($null -ne $servers.PSObject.Properties[$n].Value) {
      $servers.PSObject.Properties.Remove($n)
      $changed = $true
      Log ('  removed legacy MCP entry: ' + $n)
    }
  }
  if ($changed) {
    $cfg | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $jsonPath -Encoding utf8
  }
}

function Upsert-McpServer([string]$jsonPath, [string]$name, [System.Collections.Specialized.OrderedDictionary]$fields) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $jsonPath) | Out-Null
  $cfg = $null
  if (Test-Path -LiteralPath $jsonPath) {
    try { $cfg = [System.IO.File]::ReadAllText($jsonPath) | ConvertFrom-Json } catch { $cfg = $null }
  }
  $changed = $false
  if ($null -eq $cfg) {
    if (Test-Path -LiteralPath $jsonPath) {
      Copy-Item -LiteralPath $jsonPath -Destination ($jsonPath + '.bak-' + $stamp) -Force
      Log ('  ' + $jsonPath + ' was not valid JSON - backed up, recreating.')
    }
    $cfg = New-Object PSObject
    $changed = $true
  }
  $servers = $cfg.PSObject.Properties['mcpServers'].Value
  if ($null -eq $servers) {
    $servers = New-Object PSObject
    Add-Member -InputObject $cfg -NotePropertyName mcpServers -NotePropertyValue $servers -Force
  }
  $entry = $servers.PSObject.Properties[$name].Value
  if ($null -eq $entry) {
    $entry = New-Object PSObject
    foreach ($k in $fields.Keys) { Add-Member -InputObject $entry -NotePropertyName $k -NotePropertyValue $fields[$k] }
    Add-Member -InputObject $servers -NotePropertyName $name -NotePropertyValue $entry
    $changed = $true
    Log ('  added "' + $name + '" -> ' + $fields['url'] + ' (' + $fields['type'] + ')')
  } else {
    foreach ($k in $fields.Keys) {
      $p = $entry.PSObject.Properties[$k]
      if ($null -eq $p) {
        Add-Member -InputObject $entry -NotePropertyName $k -NotePropertyValue $fields[$k] -Force
        $changed = $true
      } elseif ($p.Value -ne $fields[$k]) {
        $p.Value = $fields[$k]
        $changed = $true
        Log ('  updated "' + $name + '".' + $k + ' -> ' + $fields[$k])
      }
    }
  }
  if ($changed) {
    if ((Test-Path -LiteralPath $jsonPath) -and -not (Test-Path -LiteralPath ($jsonPath + '.bak-' + $stamp))) {
      Copy-Item -LiteralPath $jsonPath -Destination ($jsonPath + '.bak-' + $stamp) -Force
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($jsonPath, ($cfg | ConvertTo-Json -Depth 10) + [Environment]::NewLine, $utf8NoBom)
  } else {
    Log ('  "' + $name + '" already up to date')
  }
  # .bak 滚动：秒级时间戳命名永不复用，不清理则无限累积（坏 JSON 分支下每轮一个）→ 保留最近 3 份
  try {
    $oldBaks = @(Get-ChildItem -Path (Split-Path -Parent $jsonPath) -Filter ((Split-Path -Leaf $jsonPath) + '.bak-*') -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -Skip 3)
    if ($oldBaks.Count -gt 0) { $oldBaks | Remove-Item -Force -ErrorAction SilentlyContinue }
  } catch {}
  return $changed
}

# 1. fetch portal data (mcp connection info + generated stubs)
try {
  $resp = Invoke-RestMethod -Uri ($base + '/api/skill-stubs/all') -TimeoutSec 20
} catch {
  Log ('ERROR: cannot reach portal ' + $base + ' : ' + $_.Exception.Message)
  exit 1
}
$items = @($resp.stubs)
$mcpName = 'skillharbor-ai-gateway'
$mcpUrl = 'http://127.0.0.1:8765/mcp'
if ($resp.mcp -and $resp.mcp.name) { $mcpName = $resp.mcp.name }
if ($resp.mcp -and $resp.mcp.url) { $mcpUrl = $resp.mcp.url }

# p10 personal token in the MCP url (?k=): the gateway resolves the SkillHarbor account from it.
# When re-running WITHOUT -GatewayToken (self-update channel / manual sync / shared script),
# preserve the k= already present in mcp.json so a generic re-run never strips someone's identity.
if ($GatewayToken) {
  $mcpUrl = $mcpUrl + '?k=' + $GatewayToken
} elseif (Test-Path -LiteralPath $mcpPath) {
  try {
    $existingUrl = ([System.IO.File]::ReadAllText($mcpPath) | ConvertFrom-Json).mcpServers.$mcpName.url
    if ($existingUrl -match '[?]k=([A-Za-z0-9_-]+)') {
      $mcpUrl = $mcpUrl + '?k=' + $Matches[1]
      Log ('  preserving personal gateway token in MCP url')
    }
  } catch {}
}

# 2a. ensure the skillharbor-ai-gateway MCP entry in ~/.workbuddy/mcp.json (preserve other servers)
Log ('MCP -> WorkBuddy: ' + $mcpPath)
$wbFields = [ordered]@{ type = 'http'; url = $mcpUrl; disabled = $false }
if ($mcpName -ne 'dt-skills') { Remove-McpServer -jsonPath $mcpPath -names @('dt-skills') }
Upsert-McpServer -jsonPath $mcpPath -name $mcpName -fields $wbFields | Out-Null

# 2b. Trae (global config only - Trae does not load project-level mcp.json).
#     Configure every detected install; skip silently when Trae is not installed.
$traeUserDirs = @(
  (Join-Path $env:APPDATA 'Trae SOLO CN\User'),
  (Join-Path $env:APPDATA 'Trae CN\User'),
  (Join-Path $env:APPDATA 'Trae\User')
)
$traeFields = [ordered]@{ url = $mcpUrl; type = 'streamableHttp' }
$traeDone = 0
foreach ($ud in $traeUserDirs) {
  if (-not (Test-Path -LiteralPath $ud)) { continue }
  $tPath = Join-Path $ud 'mcp.json'
  Log ('MCP -> Trae: ' + $tPath)
  if ($mcpName -ne 'dt-skills') { Remove-McpServer -jsonPath $tPath -names @('dt-skills') }
  Upsert-McpServer -jsonPath $tPath -name $mcpName -fields $traeFields | Out-Null
  $traeDone++
}
if ($traeDone -eq 0) {
  Log 'MCP -> Trae: not installed on this machine, skipped.'
}

# Sync functions are loaded by the isolated regression via AST, never by running this script.
function Test-SkillLeaf([string]$Name) {
  return ($Name -and $Name.Length -le 100 -and $Name -notmatch '[\x00-\x1f\x7f\\/:*?"<>|]' -and
    $Name -ne '.' -and $Name -ne '..' -and $Name -ceq $Name.Trim().TrimEnd('.') -and
    $Name -notmatch '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)')
}

function Test-SkillSafePath([string]$Path) {
  # Check each existing ancestor without traversing junctions/symlinks.
  $cursor = [IO.Path]::GetFullPath($Path)
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $node = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
      if ($node.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
    } else {
      # Get-Item also detects dangling reparse points on Windows.
      $node = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
      if ($null -ne $node) { return $false }
    }
    $parent = Split-Path -Parent $cursor
    if ($parent -eq $cursor) { break }
    $cursor = $parent
  }
  return $true
}

function Get-SkillPath([string]$Root, [string]$Folder) {
  if (-not (Test-SkillLeaf $Folder)) { throw 'Unsafe skill folder name' }
  $path = [IO.Path]::GetFullPath((Join-Path $Root $Folder))
  if ((Split-Path -Parent $path) -ne $Root -or -not (Test-SkillSafePath $path)) { throw 'Unsafe skill directory' }
  return $path
}

function Get-SkillHash([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
}

function Test-SkillOwned([string]$Root, $Entry) {
  try {
    if (-not $Entry -or $Entry.sha256 -notmatch '^[a-fA-F0-9]{64}$') { return $false }
    $dir = Get-SkillPath $Root ([string]$Entry.folder)
    $file = Join-Path $dir 'SKILL.md'
    if (-not (Test-SkillSafePath $file) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) { return $false }
    # Refuse nested links as well; never follow them while inspecting the tree.
    $pending = New-Object System.Collections.Generic.Stack[string]
    $pending.Push($dir)
    while ($pending.Count) {
      foreach ($child in @(Get-ChildItem -LiteralPath $pending.Pop() -Force -ErrorAction Stop)) {
        if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
        if ($child.PSIsContainer) { $pending.Push($child.FullName) }
      }
    }
    return ((Get-SkillHash $file) -eq $Entry.sha256)
  } catch { return $false }
}

function Write-SkillAtomic([string]$Path, [string]$Content, [scriptblock]$Guard) {
  if (-not (Test-SkillSafePath $Path)) { throw 'Unsafe write path' }
  $temp = $Path + '.tmp-' + [guid]::NewGuid().ToString('N')
  try {
    [IO.File]::WriteAllText($temp, $Content, (New-Object System.Text.UTF8Encoding($false)))
    if (-not (Test-SkillSafePath $Path) -or -not (& $Guard)) { throw 'Write ownership changed' }
    if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temp, $Path, [System.Management.Automation.Language.NullString]::Value) }
    else { [IO.File]::Move($temp, $Path) }
  } finally {
    if ((Test-SkillSafePath $temp) -and (Test-Path -LiteralPath $temp)) { [IO.File]::Delete($temp) }
  }
}

function Remove-SkillOwned([string]$Root, $Entry) {
  if (-not (Test-SkillOwned $Root $Entry)) { return }
  $dir = Get-SkillPath $Root $Entry.folder
  # Never recursively remove a directory: adjacent user files remain intact.
  [IO.File]::Delete((Join-Path $dir 'SKILL.md'))
  if ((Test-SkillSafePath $dir) -and @(Get-ChildItem -LiteralPath $dir -Force).Count -eq 0) { [IO.Directory]::Delete($dir) }
}

# Use the same identity rule for duplicate detection, lookup and replacement.
# Windows roots ignore case; portal source paths retain ordinal case distinctions.
function Test-SkillPartition($Partition, [string]$Root, [string]$Source) {
  return ([StringComparer]::OrdinalIgnoreCase.Equals([string]$Partition.root, $Root) -and
    [StringComparer]::Ordinal.Equals([string]$Partition.source, $Source))
}

function Sync-SkillStubs($items, $roots, [string]$managedFile, [string]$Source = $base) {
  if (@($items).Count -eq 0) { Log 'No enabled skills - stubs skipped.'; return }
  if (-not $Source) { throw 'Missing skill portal source' }
  # Validate the whole catalog BEFORE touching disk. Ambiguous input cannot authorize offboarding.
  $entries = @(); $slugs = @{}; $folders = @{}
  foreach ($s in $items) {
    if (-not $s.slug -or -not $s.folder -or -not $s.content) { throw 'Incomplete skill catalog' }
    $slug = [string]$s.slug
    if (-not (Test-SkillLeaf $slug) -or $slug -match '\s') { throw 'Invalid skill slug' }
    $folder = ([string]$s.folder -replace '[\\/:*?"<>|\r\n\t]', ' ').Trim()
    if ($folder.Length -gt 80) { $folder = $folder.Substring(0, 80).Trim() }
    $folder = $folder.TrimEnd([char[]]('.',' '))
    if (-not (Test-SkillLeaf $folder) -or $slugs.ContainsKey($slug) -or $folders.ContainsKey($folder)) { throw 'Ambiguous skill catalog' }
    $slugs[$slug] = $true; $folders[$folder] = $slug
    $entries += @{slug=$slug;folder=$folder;content=[string]$s.content}
  }
  $managedFile = [IO.Path]::GetFullPath($managedFile)
  if (-not (Test-SkillSafePath $managedFile)) { throw 'Unsafe skill ledger path' }
  $partitions = @(); $legacy = @()
  if (Test-Path -LiteralPath $managedFile) {
    try { $raw = [IO.File]::ReadAllText($managedFile) | ConvertFrom-Json -ErrorAction Stop } catch { throw 'Invalid skill ledger JSON; sync skipped' }
    if ($null -ne $raw -and $raw.PSObject.Properties['version']) {
      if ($raw.version -ne 3 -or $null -eq $raw.partitions) { throw 'Unknown skill ledger schema' }
      $partitions = @($raw.partitions)
      $validatedPartitions = @()
      foreach ($p in $partitions) {
        if (-not $p.root -or -not $p.source -or $null -eq $p.entries) { throw 'Invalid ledger partition' }
        if (@($validatedPartitions | Where-Object { Test-SkillPartition $_ $p.root $p.source }).Count) { throw 'Duplicate ledger partition' }
        $validatedPartitions += $p
        $pslugs = @{}; $pfolders = @{}
        foreach ($e in @($p.entries)) {
          if (-not (Test-SkillLeaf $e.slug) -or -not (Test-SkillLeaf $e.folder) -or $e.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $pslugs.ContainsKey($e.slug) -or $pfolders.ContainsKey($e.folder)) { throw 'Invalid ledger entry' }
          $pslugs[$e.slug] = $true; $pfolders[$e.folder] = $true
        }
      }
    } elseif ($null -eq $raw -or $raw -is [string] -or $raw -is [array] -or ($raw.slug -and $raw.folder)) {
      $legacy = @($raw)
      Log 'Legacy ledger: only exact active portal stubs can migrate; other folders are preserved.'
      foreach ($e in $legacy) {
        if ($e -isnot [string] -and (-not $e.slug -or -not $e.folder)) { throw 'Unknown legacy ledger schema' }
      }
    } else { throw 'Unknown skill ledger schema' }
  }
  $removals = @()
  foreach ($r in $roots) {
    $root = [IO.Path]::GetFullPath([string]$r.path).TrimEnd('\')
    if (-not (Test-SkillSafePath $root)) { throw 'Unsafe skill root' }
    [IO.Directory]::CreateDirectory($root) | Out-Null
    $partition = @($partitions | Where-Object { Test-SkillPartition $_ $root $Source })
    $previous = @{}; $next = @{}
    if ($partition.Count) { foreach ($e in @($partition[0].entries)) { $previous[$e.slug] = $e } }
    # A legacy ledger conveys NO deletion rights. Adopt only active, byte-identical portal stubs.
    foreach ($e in $entries) {
      if ($previous.ContainsKey($e.slug)) { continue }
      $legacyMatch = @($legacy | Where-Object { ($_ -is [string] -and $_ -eq $e.folder) -or ($_.slug -eq $e.slug -and $_.folder -eq $e.folder) })
      if (-not $legacyMatch.Count) { continue }
      $dir = Get-SkillPath $root $e.folder; $file = Join-Path $dir 'SKILL.md'
      if ((Test-SkillSafePath $file) -and (Test-Path -LiteralPath $file -PathType Leaf)) {
        $candidate = @{slug=$e.slug;folder=$e.folder;sha256=(Get-SkillHash $file)}
        if ((Test-SkillOwned $root $candidate) -and [IO.File]::ReadAllText($file) -ceq $e.content) { $previous[$e.slug] = $candidate }
      }
    }
    foreach ($e in $entries) {
      $old = $previous[$e.slug]
      if ($old -and (Test-SkillOwned $root $old)) { $next[$e.slug] = $old }
      $dir = Get-SkillPath $root $e.folder; $file = Join-Path $dir 'SKILL.md'
      $exists = Test-Path -LiteralPath $dir
      $owned = $old -and $old.folder -eq $e.folder -and (Test-SkillOwned $root $old)
      if ($exists -and -not $owned) { Log ('  foreign/conflicting folder skipped: ' + $e.folder); continue }
      if (-not $exists) { [IO.Directory]::CreateDirectory($dir) | Out-Null }
      $guard = { if ($owned) { Test-SkillOwned $root $old } else { (Test-SkillSafePath $dir) -and @(Get-ChildItem -LiteralPath $dir -Force | Where-Object { $_.FullName -ne $temp }).Count -eq 0 } }
      if (-not $owned -or [IO.File]::ReadAllText($file) -cne $e.content) { Write-SkillAtomic $file $e.content $guard }
      $newEntry = @{slug=$e.slug;folder=$e.folder;sha256=(Get-SkillHash $file)}
      $next[$e.slug] = $newEntry
      # Destination is durable first. A conflict or failed write leaves the old usable stub intact.
      if ($old -and $old.folder -ne $e.folder) { $removals += @{root=$root;entry=$old} }
    }
    foreach ($old in $previous.Values) {
      if (-not $slugs.ContainsKey($old.slug) -and -not $folders.ContainsKey($old.folder)) { $removals += @{root=$root;entry=$old} }
    }
    $partitions = @($partitions | Where-Object { -not (Test-SkillPartition $_ $root $Source) })
    $partitions += @{root=$root;source=$Source;entries=@($next.Values)}
    Log ('Skills [' + $r.label + ']: ' + $next.Count + ' owned stubs')
  }
  [IO.Directory]::CreateDirectory((Split-Path -Parent $managedFile)) | Out-Null
  $json = ConvertTo-Json -InputObject @{version=3;partitions=@($partitions)} -Depth 8
  Write-SkillAtomic $managedFile $json { Test-SkillSafePath $managedFile }
  # Never remove a usable old stub until ownership of replacements is durably recorded.
  foreach ($removal in $removals) { Remove-SkillOwned $removal.root $removal.entry }
}

$roots = @( @{ path = $skillsRoot; label = 'WorkBuddy' } )
foreach ($h in @((Join-Path $env:USERPROFILE '.trae-cn'), (Join-Path $env:USERPROFILE '.trae'))) {
  if (Test-Path -LiteralPath $h) { $roots += @{ path = (Join-Path $h 'skills'); label = 'Trae' } }
}
try { Sync-SkillStubs -items $items -roots $roots -managedFile $managedFile -Source $base }
catch { Log ('ERROR: skill sync skipped/failed: ' + $_.Exception.Message) }

# 4. ensure the auto-sync mechanism (self-copy + idempotent registration chain, never fatal)
$syncCopy = Join-Path $store 'sync.ps1'
$vbsCopy = Join-Path $store 'sync.vbs'
$selfPath = $MyInvocation.MyCommand.Path
if ($selfPath -and (Test-Path -LiteralPath $selfPath)) {
  try {
    $selfResolved = (Resolve-Path -LiteralPath $selfPath -ErrorAction SilentlyContinue).Path
    $copyResolved = (Resolve-Path -LiteralPath $syncCopy -ErrorAction SilentlyContinue).Path
    if ($selfResolved -ne $copyResolved) { Copy-Item $selfPath -Destination $syncCopy -Force }
  } catch {}
}

function Test-WshAvailable {
  # Windows Script Host: binary present and not disabled by policy (Enabled=0 in any of these keys)
  if (-not (Test-Path (Join-Path $env:SystemRoot 'System32\wscript.exe'))) { return $false }
  foreach ($k in @('HKLM:\SOFTWARE\Microsoft\Windows Script Host\Settings', 'HKCU:\SOFTWARE\Microsoft\Windows Script Host\Settings', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows Script Host\Settings')) {
    try { if ((Get-ItemProperty -Path $k -Name Enabled -ErrorAction SilentlyContinue).Enabled -eq 0) { return $false } } catch {}
  }
  return $true
}

function Register-AutoSync {
  # writes the hidden vbs launcher, then walks the chain; returns how it was registered ('' on total failure).
  # every method below is idempotent (/Force overwrite), so this is safe to re-run on every sync pass -
  # which is also how older logon-only installs get upgraded to the 15-minute schedule.
  New-Item -ItemType Directory -Force -Path $store | Out-Null
  $vbsLine = 'CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""' + $syncCopy + '"" -Silent", 0, False'
  [System.IO.File]::WriteAllText($vbsCopy, $vbsLine + [Environment]::NewLine, $ascii)

  function Remove-LegacyAutostart {
    # schtasks / Task Scheduler API 任一注册成功后调用：清掉降级链遗留的旧自启
    # （HKCU Run key、启动文件夹 .vbs）。不清则登录时多实例并发写 mcp.json → 撕裂 → 坏 JSON 分支。
    try { Remove-ItemProperty -Path $runKeyPath -Name $taskName -ErrorAction SilentlyContinue } catch {}
    try { Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Startup')) ($taskName + '.vbs')) -Force -ErrorAction SilentlyContinue } catch {}
  }

  # task action: wscript hidden launcher when possible - zero window flash (see header note)
  $useWsh = Test-WshAvailable
  if ($useWsh) {
    $tr = 'wscript.exe "' + $vbsCopy + '"'
  } else {
    Log 'Note: Windows Script Host unavailable - task runs powershell directly (brief console flash possible).'
    $tr = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $syncCopy + '" -Silent'
  }

  # 4a. schtasks.exe (usual path): logon task (DAILY fallback), then the 15-minute companion task
  $global:LASTEXITCODE = 1
  try {
    schtasks /Create /F /TN $taskName /TR $tr /SC ONLOGON 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      schtasks /Create /F /TN $taskName /TR $tr /SC DAILY /ST 09:05 2>&1 | Out-Null
    }
    if ($LASTEXITCODE -eq 0) {
      $periodic = $false
      try {
        schtasks /Create /F /TN $taskName15 /TR $tr /SC MINUTE /MO 15 2>&1 | Out-Null
        $periodic = ($LASTEXITCODE -eq 0)
      } catch {}
      if ($periodic) { Remove-LegacyAutostart; return 'Task Scheduler (schtasks, wscript hidden, logon + every 15 min)' }
      Remove-LegacyAutostart
      return 'Task Scheduler (schtasks, wscript hidden, logon only - 15-min task failed)'
    }
  } catch {
    Log ('Note: schtasks.exe failed on this machine - falling back to the Task Scheduler API.')
  }

  # 4b. Task Scheduler service API: one task carrying both triggers (logon + every 15 min)
  try {
    if ($useWsh) {
      $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbsCopy + '"')
    } else {
      $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $syncCopy + '" -Silent')
    }
    $logonTrigger = New-ScheduledTaskTrigger -AtLogOn
    $repeatTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration ([TimeSpan]::MaxValue)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($logonTrigger, $repeatTrigger) -Force | Out-Null
    Remove-LegacyAutostart
    return 'Task Scheduler (API, wscript hidden, logon + every 15 min)'
  } catch {
    Log ('Note: Task Scheduler API registration failed - falling back to the registry Run key.')
  }

  # 4c. HKCU Run key (per-user, hidden vbs launcher, no Task Scheduler involved; logon-only)
  try {
    $runVal = 'wscript.exe "' + $vbsCopy + '"'
    if (-not (Test-Path $runKeyPath)) { New-Item -Path $runKeyPath -Force | Out-Null }
    Set-ItemProperty -Path $runKeyPath -Name $taskName -Value $runVal
    $v = (Get-ItemProperty -Path $runKeyPath -Name $taskName -ErrorAction Stop).$taskName
    if ($v -eq $runVal) { return 'registry Run key (logon only)' }
  } catch {
    Log ('Note: registry Run key failed - falling back to the Startup folder.')
  }

  # 4d. Startup folder .vbs copy (pure filesystem, works on any Windows; logon-only)
  try {
    $startup = [Environment]::GetFolderPath('Startup')
    Copy-Item -LiteralPath $vbsCopy -Destination (Join-Path $startup ($taskName + '.vbs')) -Force
    if (Test-Path -LiteralPath (Join-Path $startup ($taskName + '.vbs'))) { return 'Startup folder (logon only)' }
  } catch {}

  return ''
}

$syncHow = ''
try {
  $syncHow = Register-AutoSync
} catch {
  Log ('Note: auto-sync registration skipped: ' + $_.Exception.Message)
}

if ($syncHow) {
  Log ('Auto-sync ensured via ' + $syncHow + ': skills stay fresh at logon and every 15 min, no need to re-run this installer.')
} else {
  Log 'WARNING: all auto-sync registration methods failed. MCP and skills ARE installed; skills will not auto-update until Windows is repaired (try: sfc /scannow).'
}

# 5. self-update (runs LAST): refresh the local scheduled-task copy from the portal so future
#    script changes propagate through the 15-min channel without anyone re-running the bat.
#    When we ARE the local copy, swap after exit - never overwrite the executing file.
try {
  $web = New-Object System.Net.WebClient
  $web.Encoding = [System.Text.Encoding]::UTF8
  $latest = $web.DownloadString($base + '/files/install-workbuddy-skills.ps1')
  if ($latest) {
    $mine = [System.IO.File]::ReadAllText($syncCopy)
    if ($latest -ne $mine) {
      $staged = $syncCopy + '.new'
      [System.IO.File]::WriteAllText($staged, $latest, (New-Object System.Text.UTF8Encoding($true)))
      $selfResolved = (Resolve-Path -LiteralPath $selfPath -ErrorAction SilentlyContinue).Path
      $copyResolved = (Resolve-Path -LiteralPath $syncCopy -ErrorAction SilentlyContinue).Path
      if ($selfResolved -and $selfResolved -eq $copyResolved) {
        Start-Process -WindowStyle Hidden -FilePath 'cmd.exe' -ArgumentList '/c', ('ping -n 4 127.0.0.1 >nul & move /y "' + $staged + '" "' + $syncCopy + '"')
        Log 'Self-update: staged newer script from portal, swaps in ~3s (takes effect on next run).'
      } else {
        Move-Item -LiteralPath $staged -Destination $syncCopy -Force
        Log 'Self-update: local copy refreshed from portal.'
      }
    }
  }
} catch {}

if (-not $Silent) {
  Write-Host ''
  if ($syncHow) {
    Write-Host '================================================' -ForegroundColor Green
    Write-Host '  安装完成！AI Gateway已连接。' -ForegroundColor Green
    Write-Host ('  WorkBuddy 与检测到的 Trae 均已连接AI Gateway，平台技能已同步到技能列表；') -ForegroundColor Green
    Write-Host '  如果它们正在运行，请先重启；' -ForegroundColor Green
    Write-Host '  重启后技能与知识库工具已就绪：技能菜单里可看到全部技能，' -ForegroundColor Green
    Write-Host '  对话中可直接下任务用技能，也可用自然语言检索知识库（如「查一下知识库里可研模板」）。' -ForegroundColor Green
    Write-Host '  之后新增技能每 15 分钟自动同步（含每次登录），无需重跑本脚本；' -ForegroundColor Green
    Write-Host '  急用时可在门户下载「立即手动同步」脚本，双击马上拉取最新技能。' -ForegroundColor Green
    Write-Host '================================================' -ForegroundColor Green
  } else {
    Write-Host '================================================' -ForegroundColor Yellow
    Write-Host '  技能已安装完成！' -ForegroundColor Yellow
    Write-Host '  如果 WorkBuddy / Trae 正在运行，请先重启即可使用技能。' -ForegroundColor Yellow
    Write-Host '  注意：自动同步注册失败（建议以管理员运行 sfc /scannow 修复系统后再重跑本脚本）。' -ForegroundColor Yellow
    Write-Host '================================================' -ForegroundColor Yellow
  }
}
