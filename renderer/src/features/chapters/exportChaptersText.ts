import { getPlainTextFromEditorContent } from '@/features/chapters/editorContent'
import type { ChapterDraft, OutlineVolume, ProjectSummary } from '@/types/app'

type Project = Pick<ProjectSummary, 'title'>

export type ChaptersExportPayload = {
  project?: Pick<Project, 'title'> | null
  outlineVolumes?: OutlineVolume[]
  chapters?: Array<{
    volumeId?: string
    title?: string
    content?: string
  }>
}

export function buildChaptersExportFileStem(projectTitle?: string | null, suffix = 'chapters'): string {
  const safeTitle = (projectTitle?.trim() || 'characterarc')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
  return `${safeTitle}-${suffix}`
}

export function buildChaptersExportText(payload: ChaptersExportPayload): string {
  const volumeTitleMap = new Map(
    (payload.outlineVolumes ?? []).map((volume) => [volume.id, volume.title?.trim() || '未命名分卷'])
  )
  let activeVolumeId = ''
  const chapters = payload.chapters ?? []

  return [
    payload.project?.title ? `# ${payload.project.title}` : '# CharacterArc 导出',
    '',
    ...chapters.flatMap((chapter, index) => {
      const shouldPrintVolume = Boolean(chapter.volumeId && chapter.volumeId !== activeVolumeId)
      if (chapter.volumeId) {
        activeVolumeId = chapter.volumeId
      }

      return [
        ...(shouldPrintVolume ? [`## ${volumeTitleMap.get(chapter.volumeId ?? '') || '未命名分卷'}`, ''] : []),
        `第${index + 1}章 ${chapter.title ?? '未命名章节'}`,
        '',
        chapter.content?.trim() || '（暂无正文内容）',
        '',
        ''.padEnd(48, '-'),
        ''
      ]
    })
  ].join('\n')
}

export function buildChaptersExportPayloadFromStore(input: {
  project?: Pick<Project, 'title'> | null
  outlineVolumes: OutlineVolume[]
  chapters: ChapterDraft[]
}): ChaptersExportPayload {
  return {
    project: input.project,
    outlineVolumes: input.outlineVolumes,
    chapters: input.chapters.map((chapter) => ({
      volumeId: chapter.volumeId,
      title: chapter.title,
      content: getPlainTextFromEditorContent(chapter.content)
    }))
  }
}
