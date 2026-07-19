import { test, expect } from '@playwright/test'
import { E2E_API_BASE } from '../../playwright.config'

const INVITE = process.env.E2E_INVITE_CODE ?? 'CHARARC-BETA'

test.describe('剩余 IPC 模块（web-remaining-modules）', () => {
  test('skills 扫描 + 章节 commit-edit', async ({ request }) => {
    const email = `remaining-ui-${Date.now()}@test.local`
    const reg = await request.post(`${E2E_API_BASE}/api/character-arc/v1/auth/register`, {
      data: { email, password: 'TestPass123!', inviteCode: INVITE },
    })
    expect(reg.ok()).toBeTruthy()
    const { accessToken: token } = (await reg.json()) as { accessToken: string }
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

    const created = await request.post(`${E2E_API_BASE}/api/character-arc/v1/projects`, {
      headers,
      data: { title: 'Remaining Modules', genre: '科幻' },
    })
    expect(created.ok()).toBeTruthy()
    const project = (await created.json()) as { id: string }

    const skills = await request.get(`${E2E_API_BASE}/api/character-arc/v1/projects/${project.id}/skills`, { headers })
    expect(skills.ok()).toBeTruthy()
    const skillBody = (await skills.json()) as { skills?: unknown[] }
    expect((skillBody.skills ?? []).length).toBeGreaterThan(0)

    const chapterId = `chapter-e2e-${Date.now()}`
    const workspaceRes = await request.get(`${E2E_API_BASE}/api/character-arc/v1/workspace`, { headers })
    expect(workspaceRes.ok()).toBeTruthy()
    const workspace = (await workspaceRes.json()) as Record<string, unknown>
    const workspaces = (workspace.workspaces as Record<string, Record<string, unknown>>) ?? {}
    const ws = { ...(workspaces[project.id] ?? {}), chapters: [{ id: chapterId, title: 'E2E', summary: '', status: 'draft', content: '<p>A</p>', volumeId: '' }] }
    workspaces[project.id] = ws
    workspace.workspaces = workspaces

    const putRes = await request.put(`${E2E_API_BASE}/api/character-arc/v1/workspace`, { headers, data: workspace })
    expect(putRes.ok()).toBeTruthy()

    const commit = await request.post(
      `${E2E_API_BASE}/api/character-arc/v1/projects/${project.id}/chapters/${chapterId}/commit-edit`,
      { headers, data: { oldContent: '<p>A</p>', newContent: '<p>B</p>' } },
    )
    expect(commit.ok()).toBeTruthy()

    const read = await request.get(
      `${E2E_API_BASE}/api/character-arc/v1/projects/${project.id}/chapters/${chapterId}`,
      { headers },
    )
    const chapter = (await read.json()) as { result?: { content?: string } }
    expect(chapter.result?.content).toContain('B')
  })
})
