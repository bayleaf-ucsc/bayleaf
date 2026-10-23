/** Inline Windows PowerShell 5.1 bootstrap, derived from the HTTPS-qualified fixture.
 * No downloaded code, profile, execution-policy override, disk cookie jar or TLS bypass.
 * Keep this small: it is only a transport for the existing two-code claim flow.
 */
export function windowsClaimCommand(apiBase: string, mode: 'standard' | 'sealed'): string[] {
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const script = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$WarningPreference='SilentlyContinue'
$VerbosePreference='SilentlyContinue'
$DebugPreference='SilentlyContinue'
$InformationPreference='SilentlyContinue'
$origin=${literal(apiBase)}
$baseUrl=$origin+'/auth/claim/curl'
$cookies=New-Object System.Net.CookieContainer
$clock=[Diagnostics.Stopwatch]::StartNew()
$waitMilliseconds=600000
function Remaining {
  return [Math]::Max(0,$waitMilliseconds-$clock.ElapsedMilliseconds)
}
function Request([string]$url) {
  if ((Remaining) -le 0) { throw 'Deadline reached' }
  $request=[System.Net.HttpWebRequest]::Create($url)
  $request.Method='GET'
  $request.CookieContainer=$cookies
  $request.AllowAutoRedirect=$false
  $request.Timeout=[int][Math]::Max(1,[Math]::Min(30000,(Remaining)))
  $request.ReadWriteTimeout=[Math]::Max(1,$request.Timeout)
  try { return $request.GetResponse() }
  catch [System.Net.WebException] {
    if ($null -ne $_.Exception.Response) { return $_.Exception.Response }
    throw
  }
}
try {
  $response=Request ($baseUrl+'/start/${mode}/Windows_NT')
  try {
    if ([int]$response.StatusCode -ne 204) { throw 'Start failed' }
    $url=$response.Headers['X-BayLeaf-Claim-URL']
    if ([string]::IsNullOrWhiteSpace($url)) { throw 'Missing approval URL' }
    $approval=[Uri]$url
    if ($approval.GetLeftPart([UriPartial]::Authority) -cne $origin -or
        $approval.AbsolutePath -cne '/auth/claim' -or
        $approval.Query -cnotmatch '^\?c=[A-Z0-9]{4}-[A-Z0-9]{4}$' -or
        $approval.Fragment -ne '' -or $approval.UserInfo -ne '') { throw 'Invalid approval URL' }
  } finally { $response.Close() }
  [Console]::Error.WriteLine('')
  [Console]::Error.WriteLine('Open this URL to approve access:')
  [Console]::Error.WriteLine($url)
  [Console]::Error.WriteLine('')
  while ((Remaining) -gt 0) {
    $response=Request ($baseUrl+'/poll')
    try {
      $status=[int]$response.StatusCode
      if ($status -eq 200) {
        $stream=$response.GetResponseStream()
        $stream.ReadTimeout=[int][Math]::Max(1,[Math]::Min(30000,(Remaining)))
        $reader=New-Object System.IO.StreamReader($stream)
        try {
          $buffer=New-Object char[] 44
          $read=$reader.ReadBlockAsync($buffer,0,$buffer.Length)
          if (-not $read.Wait([int][Math]::Max(1,(Remaining)))) { throw 'Deadline reached' }
          $count=$read.Result
          if ($count -ne 43) { throw 'Invalid credential length' }
          $credential=-join $buffer[0..($count-1)]
        } finally { $reader.Dispose() }
        if ((Remaining) -le 0) { break }
        if ($credential -cnotmatch '^sk-bayleaf-[0-9a-f]{32}$') { throw 'Invalid credential' }
        [Console]::Out.Write($credential)
        exit 0
      }
      if ($status -eq 403) { [Console]::Error.WriteLine('Access denied.'); exit 1 }
      if ($status -ne 429) { throw 'Unexpected poll status' }
    } finally { $response.Close() }
    $delay=[int][Math]::Min(1000,(Remaining))
    if ($delay -gt 0) { Start-Sleep -Milliseconds $delay }
  }
  [Console]::Error.WriteLine('Approval timed out.')
  exit 1
} catch {
  if ((Remaining) -le 0) { [Console]::Error.WriteLine('Approval timed out.') }
  else { [Console]::Error.WriteLine('BayLeaf authentication failed (transport or protocol error).') }
  exit 1
}`.trim();
  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script];
}
