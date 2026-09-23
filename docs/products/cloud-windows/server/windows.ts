import type { Sandbox } from '@alibaba-group/opensandbox'

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

export async function execCommand(
  sandbox: Sandbox,
  command: string,
): Promise<ExecResult> {
  const exec = await sandbox.commands.run(command)
  return {
    stdout: exec.logs.stdout.map((m) => m.text).join(''),
    stderr: exec.logs.stderr.map((m) => m.text).join(''),
    exitCode: exec.exitCode ?? null,
  }
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

export async function execPowerShell(
  sandbox: Sandbox,
  script: string,
): Promise<ExecResult> {
  const encoded = encodePowerShell(script)
  return execCommand(sandbox, `powershell -EncodedCommand ${encoded}`)
}

const SCREENSHOT_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$b = New-Object System.Drawing.Bitmap($s.Width, $s.Height)
$g = [System.Drawing.Graphics]::FromImage($b)
$g.CopyFromScreen($s.Location, [System.Drawing.Point]::Empty, $s.Size)
$b.Save('C:\\screenshot.jpg', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$g.Dispose()
$b.Dispose()
`

export async function screenshot(sandbox: Sandbox): Promise<string> {
  await execPowerShell(sandbox, SCREENSHOT_SCRIPT)
  const result = await execPowerShell(
    sandbox,
    `[Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\\screenshot.jpg'))`,
  )
  return result.stdout.replace(/\s/g, '')
}

export async function listFiles(
  sandbox: Sandbox,
  dirPath: string,
): Promise<Array<{ name: string; size: number; modifiedAt: string; isDir: boolean }>> {
  const safePath = dirPath.replace(/'/g, "''")
  const result = await execPowerShell(
    sandbox,
    `Get-ChildItem -Path '${safePath}' | ForEach-Object { "$($_.Name)\`t$($_.Length)\`t$($_.LastWriteTime.ToString('o'))\`t$($_.PSIsContainer)" }`,
  )
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, size, modifiedAt, isDir] = line.split('\t')
      return {
        name,
        size: Number(size) || 0,
        modifiedAt,
        isDir: isDir === 'True',
      }
    })
}

export async function readFileBase64(
  sandbox: Sandbox,
  filePath: string,
): Promise<{ contentBase64: string; size: number }> {
  const safePath = filePath.replace(/'/g, "''")
  const result = await execPowerShell(
    sandbox,
    `$bytes = [IO.File]::ReadAllBytes('${safePath}'); $size = $bytes.Length; $b64 = [Convert]::ToBase64String($bytes); Write-Output "$size\`t$b64"`,
  )
  const line = result.stdout.trim()
  const tabIdx = line.indexOf('\t')
  if (tabIdx < 0) throw new Error('read file failed: invalid output')
  const size = Number(line.slice(0, tabIdx))
  const contentBase64 = line.slice(tabIdx + 1).replace(/\s/g, '')
  return { contentBase64, size }
}

export async function writeFile(
  sandbox: Sandbox,
  filePath: string,
  contentBase64: string,
): Promise<void> {
  const safePath = filePath.replace(/'/g, "''")
  await execPowerShell(
    sandbox,
    `$bytes = [Convert]::FromBase64String('${contentBase64}'); [IO.File]::WriteAllBytes('${safePath}', $bytes)`,
  )
}
