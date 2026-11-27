# Stores the Resend API key in OCI Vault as secret "traced-resend-api-key" (compartment TRACED, vault
# traced-vault, key traced-master-key). Run it yourself in PowerShell; the key is typed with hidden input,
# never echoed, logged or written to disk. Requires a valid OCI session (profile TRACED):
#   & "$env:USERPROFILE\oci-cli-venv\Scripts\oci.exe" session authenticate --region me-riyadh-1 --profile-name TRACED
# If the secret already exists, a new version is added (the old version stays for rollback).
$ErrorActionPreference = 'Stop'
$oci = Join-Path $env:USERPROFILE 'oci-cli-venv\Scripts\oci.exe'
$common = @('--profile', 'TRACED', '--auth', 'security_token')
function Invoke-Oci { param([string[]]$OciArgs) $out = & $oci @OciArgs @common; if ($LASTEXITCODE -ne 0) { throw "oci failed: $($OciArgs[0..2] -join ' ')" }; return $out }

$cfg = Get-Content (Join-Path $env:USERPROFILE '.oci\config')
$inProfile = $false; $tenancy = $null
foreach ($line in $cfg) {
  if ($line -match '^\[(.+)\]') { $inProfile = ($Matches[1] -eq 'TRACED'); continue }
  if ($inProfile -and $line -match '^\s*tenancy\s*=\s*(\S+)') { $tenancy = $Matches[1] }
}
if (-not $tenancy) { throw 'Profile TRACED not found in ~/.oci/config' }

$cmp   = Invoke-Oci @('iam', 'compartment', 'list', '--compartment-id', $tenancy, '--name', 'TRACED', '--query', 'data[0].id', '--raw-output')
$vault = Invoke-Oci @('kms', 'management', 'vault', 'list', '--compartment-id', $cmp, '--all', '--query', "data[?""display-name""=='traced-vault' && ""lifecycle-state""=='ACTIVE'].id | [0]", '--raw-output')
$ep    = Invoke-Oci @('kms', 'management', 'vault', 'get', '--vault-id', $vault, '--query', 'data."management-endpoint"', '--raw-output')
$key   = Invoke-Oci @('kms', 'management', 'key', 'list', '--compartment-id', $cmp, '--endpoint', $ep, '--all', '--query', "data[?""display-name""=='traced-master-key'].id | [0]", '--raw-output')

$secure = Read-Host -Prompt 'Paste the Resend API key (input hidden)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  if ($plain -notmatch '^re_[A-Za-z0-9_]+$') { throw 'That does not look like a Resend API key (expected re_...). Nothing was stored.' }
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($plain))
  $existing = Invoke-Oci @('vault', 'secret', 'list', '--compartment-id', $cmp, '--name', 'traced-resend-api-key', '--query', "data[?""lifecycle-state""=='ACTIVE'].id | [0]", '--raw-output')
  if ($existing) {
    Invoke-Oci @('vault', 'secret', 'update-base64', '--secret-id', $existing, '--secret-content-content', $b64, '--query', 'data."current-version-number"', '--raw-output') | Out-Null
    Write-Host 'Added a new version of traced-resend-api-key.'
  } else {
    Invoke-Oci @('vault', 'secret', 'create-base64', '--compartment-id', $cmp, '--vault-id', $vault, '--key-id', $key,
      '--secret-name', 'traced-resend-api-key', '--description', 'Resend send-only API key for TRACED (MAIL_TRANSPORT=resend)',
      '--secret-content-content', $b64, '--wait-for-state', 'ACTIVE', '--query', 'data."lifecycle-state"', '--raw-output') | Out-Null
    Write-Host 'Created secret traced-resend-api-key.'
  }
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Variable plain, b64 -ErrorAction SilentlyContinue
}
