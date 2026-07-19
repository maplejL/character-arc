import { api } from './api'

export type ParsedChapterCandidate = {
  index: number
  detectedNumber: number | null
  title: string
  plainText: string
  sourceName?: string
  charCount: number
  isPartial?: boolean
}

export type ManuscriptParseResult = {
  detectedTitle?: string
  chapters: ParsedChapterCandidate[]
  warnings: string[]
}

export type ContinuationBreakpoint = {
  projectId: string
  volumeId: string
  completedThroughIndex: number
  lastCompletedChapterId: string | null
  nextChapterId: string | null
  lastChapterPartial: boolean
  importedAt: string
  sourceSummary: string
}

export type ContinuationSeedResult = {
  projectId: string
  volumeId: string
  chapterIds: string[]
  breakpoint: ContinuationBreakpoint
  chapterCount: number
  totalChars: number
}

export async function parseManuscriptFiles(
  files: Array<{ name: string; text: string }>,
  mode: 'auto' | 'force-single-book' = 'auto',
): Promise<ManuscriptParseResult> {
  const body = await api
    .post('continuation/parse', { files, mode })
    .json<{ success?: boolean; result?: ManuscriptParseResult; message?: string }>()
  if (!body.result) throw new Error(body.message ?? '解析失败')
  return body.result
}

export async function seedContinuationProject(input: {
  title: string
  genre?: string
  wordCount?: string
  chapters: Array<{ title: string; plainText: string; isPartial?: boolean }>
  markLastAsPartial?: boolean
  sourceSummary?: string
}): Promise<ContinuationSeedResult> {
  const body = await api
    .post('continuation/seed', input)
    .json<{ success?: boolean; result?: ContinuationSeedResult; message?: string; code?: string }>()
  if (!body.result) throw new Error(body.message ?? '创建续写项目失败')
  return body.result
}

export async function fetchContinuationBreakpoint(
  projectId: string,
): Promise<ContinuationBreakpoint | null> {
  const body = await api
    .get(`projects/${encodeURIComponent(projectId)}/continuation/breakpoint`)
    .json<{ success?: boolean; result?: ContinuationBreakpoint | null }>()
  return body.result ?? null
}

export type ReverseExtractResult = {
  projectId: string
  sample: {
    totalChapters: number
    sampledBodyCount: number
    warnings: string[]
  }
  counts: {
    worldview: number
    characters: number
    relationships: number
    volumes: number
    outlineItems: number
  }
  warnings: string[]
}

export async function reverseExtractContinuationProject(
  projectId: string,
  options: {
    maxBodyChapters?: number
    maxCharacters?: number
    maxOutlineItems?: number
    maxWorldview?: number
    maxRelations?: number
    rebuildImportedOutline?: boolean
  } = {},
): Promise<ReverseExtractResult> {
  const body = await api
    .post(`projects/${encodeURIComponent(projectId)}/continuation/reverse-extract`, {
      rebuildImportedOutline: true,
      ...options,
    })
    .json<{ success?: boolean; result?: ReverseExtractResult; message?: string; code?: string }>()
  if (!body.result) throw new Error(body.message ?? '反推设定失败')
  return body.result
}

export async function readFilesAsText(fileList: FileList | File[]): Promise<Array<{ name: string; text: string }>> {
  const files = Array.from(fileList)
  const out: Array<{ name: string; text: string }> = []
  for (const file of files) {
    const text = await file.text()
    out.push({ name: file.name, text })
  }
  return out
}
