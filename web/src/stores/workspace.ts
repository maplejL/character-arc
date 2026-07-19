import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../lib/api'

export interface ProjectSummary {
  id: string
  title: string
  genre: string
  wordCount: string
  lastEdited: string
  cover: string
}

export const useWorkspaceStore = defineStore('workspace', () => {
  const projects = ref<ProjectSummary[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function fetchProjects(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      projects.value = await api.get('projects').json<ProjectSummary[]>()
    } catch (e) {
      error.value = e instanceof Error ? e.message : '加载项目失败'
      throw e
    } finally {
      loading.value = false
    }
  }

  async function createProject(input: { title: string; genre?: string; wordCount?: string }): Promise<ProjectSummary> {
    error.value = null
    const created = await api
      .post('projects', {
        title: input.title,
        genre: input.genre ?? '',
        wordCount: input.wordCount ?? '',
      })
      .json<{ id: string; title: string; lastEdited: string }>()
    const summary: ProjectSummary = {
      id: created.id,
      title: created.title,
      genre: input.genre ?? '',
      wordCount: input.wordCount ?? '',
      lastEdited: created.lastEdited,
      cover: '',
    }
    projects.value = [summary, ...projects.value]
    return summary
  }

  async function importProject(file: File): Promise<ProjectSummary> {
    error.value = null
    const form = new FormData()
    form.append('file', file)
    const created = await api
      .postForm('projects/import', form)
      .json<{ id: string; title: string; lastEdited: string }>()
    const summary: ProjectSummary = {
      id: created.id,
      title: created.title,
      genre: '',
      wordCount: '',
      lastEdited: created.lastEdited,
      cover: '',
    }
    projects.value = [summary, ...projects.value.filter((p) => p.id !== summary.id)]
    return summary
  }

  return { projects, loading, error, fetchProjects, createProject, importProject }
})
