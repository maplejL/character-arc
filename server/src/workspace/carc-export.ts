import JSZip from 'jszip'
import type { WorkspacePayload } from './json-store.js'

function countItems(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

export async function exportCarcBuffer(workspace: WorkspacePayload, projectId: string): Promise<Buffer> {
  const project = workspace.projects.find((item) => item.id === projectId)
  if (!project) throw new Error('项目不存在')

  const ws = workspace.workspaces[projectId]
  if (!ws) throw new Error('项目工作区不存在')

  const knowledgeDocuments = (workspace.knowledgeDocuments ?? []).filter(
    (doc) => (doc as { projectId?: string }).projectId === projectId || !(doc as { projectId?: string }).projectId,
  )
  const referenceWorks = (workspace.referenceWorks ?? []).filter((work) =>
    (project.selectedReferenceWorkIds ?? []).includes(work.id),
  )

  const assistantV2 = (ws as { assistantV2?: Record<string, unknown> }).assistantV2 ?? {
    sessions: [],
    turns: [],
    events: [],
    stagedChanges: [],
  }

  const manifest = {
    app: 'CharacterArc' as const,
    archiveVersion: '1.0',
    appVersion: '1.13.0-web',
    projectId,
    projectTitle: project.title,
    exportedAt: new Date().toISOString(),
    modules: {
      project: { count: 1 },
      worldview: { count: countItems(ws.worldviewEntries) },
      characters: { count: countItems(ws.characters) + countItems(ws.organizations) },
      relations: {
        count: countItems(ws.characterRelationships) + countItems(ws.organizationMemberships),
      },
      inspiration: { count: countItems(ws.inspirationEntries) },
      outline: { count: countItems(ws.outlineVolumes) + countItems(ws.outlineItems) },
      plotThreads: { count: countItems(ws.plotThreads) },
      chapters: { count: countItems(ws.chapters) },
      chapterVersions: { count: countItems(ws.chapterVersions) },
      workflowDocuments: { count: countItems(ws.workflowDocuments) },
      knowledgeDocuments: { count: knowledgeDocuments.length },
      referenceWorks: { count: referenceWorks.length },
      aiRuns: { count: countItems(ws.aiRuns) },
      assistantSessions: {
        count:
          countItems(ws.messages)
          + countItems(ws.globalAssistantSessions)
          + countItems(assistantV2.sessions),
      },
    },
  }

  const zip = new JSZip()
  zip.file('manifest.json', JSON.stringify(manifest, null, 2))
  zip.file('project.json', JSON.stringify(project, null, 2))
  zip.file('workspace/worldview.json', JSON.stringify(ws.worldviewEntries ?? [], null, 2))
  zip.file(
    'workspace/characters.json',
    JSON.stringify({ characters: ws.characters ?? [], organizations: ws.organizations ?? [] }, null, 2),
  )
  zip.file(
    'workspace/relations.json',
    JSON.stringify(
      {
        characterRelationships: ws.characterRelationships ?? [],
        organizationMemberships: ws.organizationMemberships ?? [],
      },
      null,
      2,
    ),
  )
  zip.file('workspace/inspiration.json', JSON.stringify(ws.inspirationEntries ?? [], null, 2))
  zip.file(
    'workspace/outline.json',
    JSON.stringify({ outlineVolumes: ws.outlineVolumes ?? [], outlineItems: ws.outlineItems ?? [] }, null, 2),
  )
  zip.file('workspace/chapters.json', JSON.stringify(ws.chapters ?? [], null, 2))
  zip.file('workspace/chapterVersions.json', JSON.stringify(ws.chapterVersions ?? [], null, 2))
  zip.file(
    'workspace/assistantSessions.json',
    JSON.stringify(
      {
        messages: ws.messages ?? [],
        globalAssistantSessions: ws.globalAssistantSessions ?? [],
        activeGlobalAssistantSessionId: ws.activeGlobalAssistantSessionId ?? '',
        assistantV2,
      },
      null,
      2,
    ),
  )
  zip.file('workspace/aiRuns.json', JSON.stringify(ws.aiRuns ?? [], null, 2))
  zip.file('workspace/workflowDocuments.json', JSON.stringify(ws.workflowDocuments ?? [], null, 2))
  zip.file('workspace/plotThreads.json', JSON.stringify(ws.plotThreads ?? [], null, 2))
  zip.file('workspace/knowledgeDocuments.json', JSON.stringify(knowledgeDocuments, null, 2))
  zip.file('workspace/referenceWorks.json', JSON.stringify(referenceWorks, null, 2))

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
