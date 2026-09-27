import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, Check, ShieldCheck } from 'lucide-react'
import { Link } from 'react-router-dom'
import { api } from '../../../api/client'
import { useAppDispatch, useAppSelector } from '../../../store'
import { clearQuestionCard, resolveQuestionCard, selectComposerBusy } from '../../../store/chatSlice'
import { sendTurn } from '../../../chat-core/transport/sendTurn'
import { Btn } from '../../../components/ui'
import QuestionCard from '../../../components/QuestionCard'
import ErrorNotice from '../../../components/ErrorNotice'
import { APPROVAL_MODE_KEYS, type AttentionItem } from './model'
import { toApiDecision } from '../../../utils/approvalDecision'
import { isTerminalApprovalRefusal } from '../../../api/apiError'
import ToolInputPreview from '../../../components/ToolInputPreview'
import { deriveToolCallTitle } from '../../../utils/toolCallTitle'

/** Kept mounted while other inbox items are selected, preserving each answer draft. */
export default function AttentionCard({ item, title, embedded = false }: { item: AttentionItem; title: string; embedded?: boolean }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const dispatch = useAppDispatch()
  const busy = useAppSelector(state => selectComposerBusy(state, item.slot))
  const locked = useRef(false)
  const [delivered, setDelivered] = useState(false)
  const mutation = useMutation({
    retry: false,
    mutationFn: async (action: { answers: Record<string, string> } | { approval: 'approve' | 'reject_once' }) => {
      if ('approval' in action && item.approval) {
        if (item.native) await api.approveChatSlot(item.slot, action.approval === 'approve' ? 'approved' : 'rejected', { request_id: item.approval.id })
        else await api.resolveApproval(item.approval.id, toApiDecision(action.approval === 'approve' ? 'approved' : 'rejected_once'))
      } else if ('answers' in action && item.question) {
        const q = item.question
        if (q.ask_id) {
          await api.answerQuestion(q.ask_id, action.answers)
          dispatch(resolveQuestionCard({ ask_id: q.ask_id }))
        } else {
          const receipt = await sendTurn({ slot: item.slot, message: Object.entries(action.answers).map(([question, answer]) => `${question}: ${answer}`).join('\n'), ...(q.native && busy ? { steer: true } : {}) })
          if (receipt.status !== 'dispatched' && receipt.status !== 'queued') {
            throw new Error(receipt.status === 'refused' ? receipt.reason || t('commandCenter.send_refused') : t('commandCenter.send_unknown'))
          }
          // Never resend after a confirmed acceptance, even if retiring the
          // visual card fails. The next inventory poll reconciles server state.
          setDelivered(true)
          if (q.card_id) {
            await api.dismissQuestionCard(item.slot, q.card_id)
            dispatch(clearQuestionCard({ slot: item.slot, card_id: q.card_id }))
          }
        }
      }
      setDelivered(true)
    },
    onSettled: () => {
      locked.current = false
      void queryClient.invalidateQueries({ queryKey: ['command-center'] })
    },
  })
  const expired = !!item.approval && isTerminalApprovalRefusal(mutation.error)
  const approvalTitle = item.approval ? deriveToolCallTitle({ title: item.approval.tool || '', rawInput: item.approval.tool_input }).title : ''
  const submit = (action: Parameters<typeof mutation.mutate>[0]) => {
    if (locked.current || delivered || expired) return
    locked.current = true
    mutation.mutate(action)
  }
  return <section className={embedded ? 'space-y-3' : 'rounded-lg border border-border bg-card p-3 space-y-3'}>
    {!embedded && <div className="flex items-center gap-2 min-w-0">
      <span className="text-sm font-semibold truncate flex-1">{title}</span>
      <Link to={`/chat?sid=${encodeURIComponent(item.slot)}`} className="text-accent text-[12px] inline-flex items-center gap-1">{t('commandCenter.open_session')}<ArrowUpRight size={13} /></Link>
    </div>}
    {item.kind === 'approval' && <p className="text-[12px] text-warn">{t('commandCenter.approval_needed')}{item.approvalMode ? ` · ${t(APPROVAL_MODE_KEYS[item.approvalMode])}` : ''}</p>}
    <p className="text-[12px] text-muted">{t('commandCenter.explicit_input')}</p>
    {/* No hand-off: QuestionCard holds this session's unsent answer draft. */}
    <ErrorNotice message={expired ? t('components.approvalCard.approval_no_longer_pending') : mutation.error?.message} />
    {delivered ? <p role="status" className="text-sm text-ok flex items-center gap-2"><Check size={15} />{t('commandCenter.recorded')}</p>
      : item.question ? <QuestionCard questions={item.question.questions} busy={mutation.isPending} onSubmit={answers => submit({ answers })} />
      : item.approval ? <>
        <div className="text-sm font-medium flex items-center gap-2"><ShieldCheck size={15} />{approvalTitle || item.approval.tool}</div>
        <ToolInputPreview toolInput={typeof item.approval.tool_input === 'string' ? item.approval.tool_input : JSON.stringify(item.approval.tool_input, null, 2) || ''} threshold={200} />
        {!expired && <div className="flex gap-2">
          <Btn primary className="min-h-11" disabled={mutation.isPending} onClick={() => submit({ approval: 'approve' })}>{t('commandCenter.approve')}</Btn>
          <Btn className="min-h-11" disabled={mutation.isPending} onClick={() => submit({ approval: 'reject_once' })}>{t('commandCenter.reject')}</Btn>
        </div>}
      </> : <p className="text-sm text-muted">{t('commandCenter.open_to_answer')}</p>}
  </section>
}
