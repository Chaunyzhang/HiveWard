import { RuntimeClientError } from '../../runtime-client'

export function resolveCompatibilityCliCommand(): 'hiveward' | 'hiveward-dev' {
  const configured = process.env.HIVEWARD_CLI_COMMAND
  if (configured === 'hiveward' || configured === 'hiveward-dev') {
    return configured
  }
  return 'hiveward'
}

export function resolvePackagedWindowsCompatibilityCommand(): 'hiveward' | undefined {
  if (process.env.HIVEWARD_WINDOWS_PACKAGED_CLI_LAUNCHER !== '1') {
    return undefined
  }
  const command = process.env.HIVEWARD_CLI_COMMAND
  if (command === 'hiveward') {
    return command
  }
  throw new RuntimeClientError(
    'invalid_argument',
    'The packaged HiveWard launcher did not provide a valid resume command. No question was created.'
  )
}

export async function flushOrchestrationStdout(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write('', (error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}

export function isDevCliInvocation(): boolean {
  return (
    process.env.HIVEWARD_DEV_CLI_INVOCATION === '1' ||
    (process.env.HIVEWARD_USER_DATA_PATH?.includes('hiveward-dev') ?? false)
  )
}
