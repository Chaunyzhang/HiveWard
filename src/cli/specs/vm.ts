import type { CommandSpec } from '../args'
import { LOCAL_COMMAND_FLAGS } from '../args'

export const VM_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['vm', 'recipe', 'doctor'],
    summary: 'Validate a per-workspace environment recipe without provisioning by default',
    usage:
      'hiveward vm recipe doctor <recipe-id> [--repo-path <path>] [--provision|--connect] [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'recipe-id', 'repo-path', 'provision', 'connect'],
    positionalArgs: ['recipe-id'],
    notes: [
      'Reads environmentRecipes from hiveward.yaml in the repo path, validates the selected recipe, and reports agent-friendly checks.',
      'This default mode is non-destructive and does not run the recipe command.',
      'Use --provision or --connect to run the recipe, validate its result, and run cleanup when configured.'
    ],
    examples: [
      'hiveward vm recipe doctor cloud-sandbox',
      'hiveward vm recipe doctor cloud-sandbox --repo-path /path/to/repo --json',
      'hiveward vm recipe doctor cloud-sandbox --provision --json'
    ]
  }
]
