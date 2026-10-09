import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'src')
const allowedDirectives = [
  '// @ts-expect-error',
  '/// <reference',
  '/* @vite-ignore */',
  '/*#__PURE__*/',
  '/* @__PURE__ */',
]
const previewLength = 60

function listSources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return listSources(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

function leafTokens(node, out = []) {
  if (node.kind === ts.SyntaxKind.JsxText) return out
  const children = node.getChildren()
  if (children.length === 0) out.push(node)
  else for (const child of children) leafTokens(child, out)
  return out
}

export function findComments(fileName, text) {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind)
  const seen = new Set()
  const found = []
  for (const token of leafTokens(source)) {
    const ranges = [
      ...(ts.getLeadingCommentRanges(text, token.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(text, token.end) ?? []),
    ]
    for (const range of ranges) {
      if (seen.has(range.pos)) continue
      seen.add(range.pos)
      const comment = text.slice(range.pos, range.end)
      if (allowedDirectives.some((directive) => comment.trim().startsWith(directive))) continue
      const { line, character } = source.getLineAndCharacterOfPosition(range.pos)
      found.push({ line: line + 1, col: character + 1, text: comment })
    }
  }
  return found
}

function main() {
  const problems = []
  const files = listSources(srcDir).map((path) => relative(root, path).split('\\').join('/')).sort()

  for (const file of files) {
    for (const { line, col, text } of findComments(file, readFileSync(join(root, file), 'utf8'))) {
      const preview = text.replace(/\s+/g, ' ').slice(0, previewLength)
      problems.push(`${file}:${line}:${col}  ${preview}`)
    }
  }

  if (problems.length > 0) {
    console.error(problems.join('\n'))
    console.error(`\n${problems.length} problem(s). src/ takes no comments: make the code say it (names, small functions, named constants, types).`)
    process.exitCode = 1
    return
  }
  console.log(`OK (${files.length} files checked)`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
