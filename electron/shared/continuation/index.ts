export type {
  ManuscriptImportSourceKind,
  ParsedChapterCandidate,
  ManuscriptParseResult,
  ManuscriptFileInput,
  ContinuationBreakpoint,
} from './types.js'

export {
  CONTINUATION_BREAKPOINT_SOURCE_LABEL,
  CONTINUATION_DEFAULT_VOLUME_TITLE,
} from './types.js'

export {
  parseChapterNumberToken,
  detectChapterNumberFromFilename,
  parseSingleBookText,
  parseManuscriptFiles,
  parseManuscriptFromInputs,
} from './manuscript-parse.js'

export {
  serializePlainTextToHtml,
  ensureEditorHtmlContent,
} from './editor-html.js'

export {
  buildReverseSamplePlan,
  formatSamplePlanForPrompt,
} from './reverse-sample.js'
export type {
  ReverseSampleChapter,
  ReverseSampleOptions,
  ReverseSamplePlan,
} from './reverse-sample.js'

export {
  buildReverseCoverageChunks,
  formatCoverageChunkForPrompt,
  mergeReverseExtractPartials,
} from './reverse-chunk.js'
export type {
  ReverseCoverageChunk,
  ReverseCoverageOptions,
  ReverseExtractPartial,
} from './reverse-chunk.js'
