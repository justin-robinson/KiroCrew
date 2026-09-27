import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { api } from '../api/client'
import { createTestStore, renderWithProviders } from './helpers'
import SessionDashboardsPage from '../pages/chat/command-center/SessionDashboardsPage'

function store(count = 3) {
  const initial = createTestStore().getState()
  return createTestStore({ ...initial, dashboard: { ...initial.dashboard, connected: true, slotsLoaded: true, slots: Array.from({ length: count }, (_, i) => ({
    key: `slot-${i}`, title: `Session ${i}`, messages: 2, running: i === 0, needs_input: i === 1,
  })) } })
}

describe('all session dashboards', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(api, 'pendingQuestions').mockResolvedValue([{ slot: 'slot-1', ask_id: 'question-1', questions: [{ question: 'Which release?', options: [{ label: 'Stable' }] }] }])
    vi.spyOn(api, 'approvals').mockResolvedValue([{ id: 'approval-2', slot: 'slot-2', tool: 'shell', tool_input: 'git status' }])
    vi.spyOn(api, 'workflowRuns').mockResolvedValue({ runs: [] })
    vi.spyOn(api, 'artifacts').mockResolvedValue({ artifacts: [] })
    vi.spyOn(api, 'sessionSummary').mockImplementation(async slot => ({ enabled: true, stale: false, constraints: [], generated_at: null, user_turns: 2, last_activity: null, intents: [{
      title: `Summary for ${slot}`, initial_intent: 'Ship the release', progress: ['Tests passed'], next_steps: [], ranges: [[1, 2]], status: 'active', verified: null, state: 'in-progress', last_touched_turn: 2, origin_turn: 1,
    }] }))
  })

  it('surfaces exact-session inputs first with saved summaries and no automatic writes', async () => {
    const answer = vi.spyOn(api, 'answerQuestion').mockResolvedValue({})
    const approve = vi.spyOn(api, 'resolveApproval').mockResolvedValue({})
    const generate = vi.spyOn(api, 'generateSessionSummary')
    renderWithProviders(<SessionDashboardsPage />, { store: store() })
    await screen.findByText('Summary for slot-1')
    const cards = screen.getAllByTestId('session-dashboard-card')
    expect(cards.map(c => c.getAttribute('data-slot')).slice(0, 2)).toEqual(['slot-1', 'slot-2'])
    const question = cards.find(c => c.getAttribute('data-slot') === 'slot-1')!
    fireEvent.click(within(question).getByText('Stable'))
    fireEvent.click(within(question).getByRole('button', { name: 'Submit' }))
    await waitFor(() => expect(answer).toHaveBeenCalledWith('question-1', { 'Which release?': 'Stable' }))
    expect(approve).not.toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()
    const approval = cards.find(c => c.getAttribute('data-slot') === 'slot-2')!
    fireEvent.click(within(approval).getByRole('button', { name: 'Approve once' }))
    await waitFor(() => expect(approve).toHaveBeenCalledWith('approval-2', 'approve'))
  })

  it('preserves answer drafts when filtering sessions out and back in', async () => {
    renderWithProviders(<SessionDashboardsPage />, { store: store() })
    fireEvent.click(await screen.findByText('Stable'))
    const search = screen.getByPlaceholderText('Search sessions…')
    fireEvent.change(search, { target: { value: 'Session 0' } })
    expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument()
    fireEvent.change(search, { target: { value: '' } })
    expect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled()
  })

  it('bounds summary reads to the shown cards, and reveals the rest explicitly', async () => {
    renderWithProviders(<SessionDashboardsPage />, { store: store(20) })
    await waitFor(() => expect(api.sessionSummary).toHaveBeenCalledTimes(12))
    fireEvent.click(screen.getByRole('button', { name: 'Show more sessions' }))
    await waitFor(() => expect(api.sessionSummary).toHaveBeenCalledTimes(20))
  })

  it('filters to actionable inputs rather than every running session', async () => {
    renderWithProviders(<SessionDashboardsPage />, { store: store() })
    await screen.findByText('Summary for slot-1')
    fireEvent.click(screen.getByRole('button', { name: 'Needs you (2)' }))
    expect(screen.getByText('Summary for slot-0')).not.toBeVisible()
    expect(screen.getByText('Summary for slot-1')).toBeVisible()
    expect(screen.getByText('Summary for slot-2')).toBeVisible()
  })

  it('distinguishes disabled summaries from a failed read and keeps retry explicit', async () => {
    vi.mocked(api.sessionSummary).mockImplementation(async slot => {
      if (slot === 'slot-1') throw new Error('Offline')
      return { enabled: false, stale: false, constraints: [], generated_at: null, user_turns: null, last_activity: null, intents: [] }
    })
    renderWithProviders(<SessionDashboardsPage />, { store: store(2) })
    expect(await screen.findByText('Session summaries are off')).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the summary')
    expect(screen.queryByRole('button', { name: /Ask the agent/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(vi.mocked(api.sessionSummary).mock.calls.filter(([slot]) => slot === 'slot-1')).toHaveLength(2))
  })

  it('marks an out-of-date saved summary instead of presenting it as current', async () => {
    const original = vi.mocked(api.sessionSummary).getMockImplementation()!
    vi.mocked(api.sessionSummary).mockImplementation(async slot => ({ ...await original(slot), stale: true, generated_at: 1_700_000_000 }))
    renderWithProviders(<SessionDashboardsPage />, { store: store(1) })
    expect(await screen.findByText(/behind the conversation/)).toBeInTheDocument()
  })
})
