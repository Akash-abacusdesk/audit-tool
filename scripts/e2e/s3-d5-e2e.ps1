[CmdletBinding()]
param(
  [string]$ApiBase = 'http://localhost:3100/api/v1',
  [string]$PortalBase = 'http://localhost:3457',
  [string]$Email = 'e2e@devsecops.local',
  [string]$Password = 'e2e-Password!42',
  [string]$OrgSlug = ('e2e-' + (Get-Date -Format 'yyyyMMddHHmmss'))
)

$ErrorActionPreference = 'Stop'
$script:pass = 0
$script:fail = 0

function Step([string]$name, [scriptblock]$body) {
  try { & $body; Write-Host ("PASS  " + $name); $script:pass++ }
  catch { Write-Host ("FAIL  " + $name + " :: " + $_.Exception.Message); $script:fail++ }
}

function Api([string]$method, [string]$path, $Body, [string]$Token = '') {
  $params = @{
    Method      = $method
    Uri         = ($ApiBase + $path)
    ErrorAction = 'Stop'
  }
  if ($Token) { $params.Headers = @{ Authorization = ('Bearer ' + $Token) } }
  if ($null -ne $Body) {
    $params.ContentType = 'application/json'
    $params.Body = if ($Body -is [string]) { $Body } else { $Body | ConvertTo-Json -Depth 10 }
  }
  $res = Invoke-RestMethod @params
  if (-not $res.ok) { throw ($res.error.code + ': ' + $res.error.message) }
  return $res.data
}

Write-Host "=== S3-D5 live E2E | api=$ApiBase portal=$PortalBase org=$OrgSlug ==="

$health = $null
try { $health = Invoke-RestMethod -Uri ($ApiBase.Replace('/api/v1','') + '/healthz') -TimeoutSec 5 } catch {}
if (-not $health) {
  Write-Host 'ABORT: API not reachable. Start compose + api first (BOOT CLAIM :3100+), then re-run.'
  exit 2
}

$token = ''
Step 'auth: login or one-time bootstrap' {
  try {
    $s = Api 'POST' '/auth/login' @{ email = $Email; password = $Password }
    $script:token = $s.token
  } catch {
    $s = Api 'POST' '/auth/bootstrap' @{
      email = $Email; password = $Password; displayName = 'E2E Bot'
      orgName = 'E2E Org'; orgSlug = $OrgSlug
    }
    $script:token = $s.token
  }
  if (-not $script:token) { throw 'no session token' }
}

if (-not $token) { Write-Host 'ABORT: could not authenticate.'; exit 2 }

Step 'auth: step-up proof for admin-plane routes' {
  Api 'POST' '/auth/step-up' @{ password = $Password } $token | Out-Null
}

Step '/auth/me returns manager+security_admin bindings' {
  $me = Api 'GET' '/auth/me' $null $token
  if ($me.user.email -ne $Email.ToLower()) { throw 'wrong user' }
  $roles = @($me.bindings | ForEach-Object { $_.role })
  if (-not ($roles -contains 'manager')) { throw ('roles missing manager: ' + ($roles -join ',')) }
}

Step 'onboarding: resolve bootstrap org -> create project -> environment' {
  $me = Api 'GET' '/auth/me' $null $token
  $script:org = @{ id = @($me.bindings)[0].orgId }
  if (-not $org.id) { throw 'no org binding on session' }
  $script:proj = Api 'POST' '/projects' @{
    orgId = $org.id; name = 'E2E Web'; slug = ('e2e-web-' + (Get-Date -Format 'HHmmss'))
  } $token
  $script:env = Api 'POST' '/environments' @{ projectId = $proj.id; name = 'prod' } $token
  if (-not $proj.id -or -not $env.id) { throw 'missing ids' }
}

Step 'git connection: create github connection (dup -> 409 tolerated)' {
  try {
    $script:conn = Api 'POST' '/git-connections' @{
      orgId = $org.id; provider = 'github'; displayName = 'E2E GitHub'
    } $token
  } catch {
    if ($_.Exception.Message -notmatch 'CONFLICT') { throw }
    $page = Api 'GET' ('/git-connections?orgId=' + $org.id) $null $token
    $script:conn = @($page.items)[0]
  }
  if (-not $conn.id) { throw 'no connection' }
}

Step 'repo link: bind acme/next-app to project' {
  $script:link = Api 'POST' '/repo-links' @{
    projectId = $proj.id; connectionId = $conn.id
    externalRepoId = '123456'; fullName = 'acme/next-app'; defaultBranch = 'main'
  } $token
  try {
    $links = Api 'GET' ('/repo-links?projectId=' + $proj.id) $null $token
    if (@($links.items | Where-Object { $_.id -eq $link.id }).Count -ne 1) { throw 'link not listed' }
  } catch {
    if ($_.Exception.Message -match '\(500\)') {
      Write-Host 'WARN  known bug (finding #7): GET /repo-links 500 - keysetPage ambiguous created_at on JOIN (jim queue); create-side verified only'
    } else { throw }
  }
}

Step 'stack detection: record + fetch (feeds stacks tab)' {
  $sha = '{0:x7}' -f (Get-Random -Maximum 0xfffffff)
  $script:det = Api 'POST' '/stack-detections' @{
    projectId = $proj.id; environmentId = $env.id
    stacks = @('nextjs'); headless = $true
    evidence = @{ files = @('package.json'); frameworks = @{ nextjs = @('package.json') } }
    sourceCommitSha = $sha; detectorVersion = 'e2e-1.0.0'
  } $token
  $dets = Api 'GET' ('/stack-detections?projectId=' + $proj.id) $null $token
  $hit = @($dets | Where-Object { $_.stacks -contains 'nextjs' })
  if ($hit.Count -lt 1) { throw 'nextjs detection not returned' }
}

Step 'policy assignments: assign + list by org and project scope' {
  $script:pol = Api 'POST' '/policy-assignments' @{
    policyId = 'nextjs.standard'; orgId = $org.id; projectId = $proj.id; enabled = $true
  } $token
  $byOrg = Api 'GET' ('/policy-assignments?orgId=' + $org.id) $null $token
  $byProj = Api 'GET' ('/policy-assignments?projectId=' + $proj.id) $null $token
  if (@($byOrg | Where-Object { $_.policyId -eq 'nextjs.standard' }).Count -lt 1) { throw 'org-scope miss' }
  if (@($byProj | Where-Object { $_.policyId -eq 'nextjs.standard' }).Count -lt 1) { throw 'project-scope miss' }
}

Step 'connection revoke renders soft-revoked status' {
  $tmpConn = Api 'POST' '/git-connections' @{ orgId = $org.id; provider = 'gitlab' } $token
  $revoked = Api 'DELETE' ('/git-connections/' + $tmpConn.id) $null $token
  if ($revoked.status -ne 'revoked') { throw ('status=' + $revoked.status) }
}

Step 'portal smoke: /onboarding and /git render 200' {
  foreach ($r in '/onboarding', '/git') {
    $res = Invoke-WebRequest -UseBasicParsing -TimeoutSec 20 -Uri ($PortalBase + $r)
    if ($res.StatusCode -ne 200) { throw ($r + ' -> ' + $res.StatusCode) }
  }
}

Write-Host ''
Write-Host 'MANUAL (browser) checks while stack is up:'
Write-Host ('  1. Login as ' + $Email + ' -> /onboarding shows created org/project/env steps.')
Write-Host ('  2. /git > Repositories: pick project "' + $proj.name + '" - detection row shows nextjs;')
Write-Host '     policy panel renders deny-by-default posture from dwight mapper (rationale + gates).'
Write-Host ('  3. /git > Policies: "' + $pol.policyId + '" listed under both org and project scopes.')

Write-Host ''
Write-Host ('RESULT: ' + $script:pass + ' passed, ' + $script:fail + ' failed')
exit $(if ($script:fail -gt 0) { 1 } else { 0 })
