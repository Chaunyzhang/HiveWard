import { describe, expect, it } from 'vitest'
import { NATIVE_CHAT_VISUAL_MAX_PER_MESSAGE } from '../../../src/shared/native-chat/native-chat-visual-directive'
import { parseMobileMarkdownTree, plainText } from './mobile-markdown-tree'
import {
  mobileMarkdownVisualPlaceholderIndex,
  protectMobileMarkdownVisualLines
} from './mobile-markdown-visual-lines'

/** The top-level blocks drawn, with a lone placeholder paragraph read as its visual. */
function topLevelBlocks(text: string, visualCount: number) {
  return parseMobileMarkdownTree(text, false).children.map((node) => {
    const visual =
      node.type === 'paragraph'
        ? mobileMarkdownVisualPlaceholderIndex(plainText(node), visualCount)
        : null
    if (visual !== null) {
      return { type: 'visual', index: visual }
    }
    return node.type === 'code'
      ? { type: 'code', text: node.value, language: node.lang }
      : { type: node.type, text: plainText(node) }
  })
}

/** The same steps MobileMarkdown runs when a transcript renders visuals. */
function blocksOf(content: string) {
  const { text, directives } = protectMobileMarkdownVisualLines(content)
  return { directives, blocks: topLevelBlocks(text, directives.length) }
}

describe('native-chat visual lines in mobile markdown', () => {
  it('turns a directive line into its own block between prose', () => {
    const { directives, blocks } = blocksOf(
      'Here is the chart.\n::hiveward-visual{file="usage-3f2a.html" title="Usage"}\nIt shows a dip.'
    )
    expect(directives).toEqual([{ file: 'usage-3f2a.html', title: 'Usage' }])
    expect(blocks).toEqual([
      { type: 'paragraph', text: 'Here is the chart.' },
      { type: 'visual', index: 0 },
      { type: 'paragraph', text: 'It shows a dip.' }
    ])
  })

  it('keeps the title exactly as written, before entity decoding and tag stripping', () => {
    const { directives } = blocksOf('::hiveward-visual{file="a.html" title="<b>Q1</b> &amp; Q2"}')
    expect(directives).toEqual([{ file: 'a.html', title: '<b>Q1</b> &amp; Q2' }])
  })

  it('accepts CRLF line endings and up to three leading spaces', () => {
    const { blocks } = blocksOf('intro\r\n   ::hiveward-visual{file="a.html"}\r\nend')
    expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'visual', 'paragraph'])
  })

  it('leaves directives inside fenced code, quotes, list items and inline code as text', () => {
    const fenced = blocksOf('```md\n::hiveward-visual{file="a.html"}\n```')
    expect(fenced.directives).toEqual([])
    expect(fenced.blocks).toEqual([
      { type: 'code', text: '::hiveward-visual{file="a.html"}', language: 'md' }
    ])
    expect(blocksOf('> ::hiveward-visual{file="a.html"}').directives).toEqual([])
    expect(blocksOf('- ::hiveward-visual{file="a.html"}').directives).toEqual([])
    expect(blocksOf('see `::hiveward-visual{file="a.html"}`').directives).toEqual([])
    expect(blocksOf('    ::hiveward-visual{file="a.html"}').directives).toEqual([])
  })

  it('resumes recognizing directives after a fence closes', () => {
    const { directives } = blocksOf('```\ncode\n```\n::hiveward-visual{file="after.html"}')
    expect(directives).toEqual([{ file: 'after.html', title: null }])
  })

  it('leaves malformed or path-like directives as literal text', () => {
    for (const line of [
      '::hiveward-visual{file="../secret.html"}',
      '::hiveward-visual{file="a.html" file="b.html"}',
      '::hiveward-visual{file="a.htm"}',
      '::hiveward-visual{file="a.html"',
      '::hiveward-visual{file="a.html"} trailing words'
    ]) {
      const { directives, blocks } = blocksOf(line)
      expect(directives, line).toEqual([])
      expect(blocks, line).toEqual([{ type: 'paragraph', text: line }])
    }
  })

  it('renders directives past the per-message cap as text', () => {
    const lines = Array.from(
      { length: NATIVE_CHAT_VISUAL_MAX_PER_MESSAGE + 1 },
      (_, index) => `::hiveward-visual{file="v${index}.html"}`
    )
    const { directives, blocks } = blocksOf(lines.join('\n'))
    expect(directives).toHaveLength(NATIVE_CHAT_VISUAL_MAX_PER_MESSAGE)
    expect(blocks.at(-1)).toEqual({ type: 'paragraph', text: lines.at(-1) })
  })

  it('renders no visuals for text that already spells a placeholder', () => {
    const { directives } = blocksOf('\uE000HIVEWARD_VISUAL_0\uE000\n::hiveward-visual{file="a.html"}')
    expect(directives).toEqual([])
  })

  it('never treats a placeholder-looking line as a visual when none were protected', () => {
    expect(topLevelBlocks('\uE000HIVEWARD_VISUAL_0\uE000', 0)).toEqual([
      { type: 'paragraph', text: '\uE000HIVEWARD_VISUAL_0\uE000' }
    ])
  })
})
