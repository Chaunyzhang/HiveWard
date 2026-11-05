import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const SPEECH_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['speech', 'openai-key', 'status'],
    summary: 'Show whether this host has an OpenAI key for cloud voice dictation',
    usage: 'hiveward speech openai-key status [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['hiveward speech openai-key status --json']
  },
  {
    path: ['speech', 'openai-key', 'set'],
    summary: 'Save the OpenAI key cloud voice dictation uses on this host, read from stdin',
    usage: 'hiveward speech openai-key set [--json] < key-file',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Reads the key from stdin so it never lands in shell history or a process list.',
      'The host that runs dictation seals it, so a headless `hiveward serve` host can use it.'
    ],
    examples: [
      'printf %s "$OPENAI_API_KEY" | hiveward speech openai-key set',
      '$env:OPENAI_API_KEY | hiveward speech openai-key set'
    ]
  },
  {
    path: ['speech', 'openai-key', 'clear'],
    summary: 'Remove the OpenAI key cloud voice dictation uses on this host',
    usage: 'hiveward speech openai-key clear [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['hiveward speech openai-key clear']
  }
]
