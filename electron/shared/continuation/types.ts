/** 作品续写：原稿解析与断点类型（Web / 桌面共享） */

export type ManuscriptImportSourceKind = 'files' | 'folder' | 'single-book'

export interface ParsedChapterCandidate {
  index: number
  detectedNumber: number | null
  title: string
  plainText: string
  sourceName?: string
  charCount: number
  isPartial?: boolean
}

export interface ManuscriptParseResult {
  detectedTitle?: string
  chapters: ParsedChapterCandidate[]
  warnings: string[]
}

export interface ManuscriptFileInput {
  name: string
  text: string
}

export interface ContinuationBreakpoint {
  projectId: string
  volumeId: string
  completedThroughIndex: number
  lastCompletedChapterId: string | null
  nextChapterId: string | null
  lastChapterPartial: boolean
  importedAt: string
  sourceSummary: string
}

export const CONTINUATION_BREAKPOINT_SOURCE_LABEL = 'continuation-breakpoint'
export const CONTINUATION_DEFAULT_VOLUME_TITLE = '第一卷'
