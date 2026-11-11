import { useCallback, useEffect, useRef, useState } from 'react';
import { ZbModal } from '../../components/ZbModal';
import RuntimeRequirements from '../../components/RuntimeRequirements';
import { api, type DeployRow, type UploadRow } from '../../services/api';
import {
  FUNCTION_STATUS,
  isReviewToken,
  isReviewSnapshot,
  REVIEW_TYPE_LABELS,
  reviewResourceType,
  reviewTargetName,
  type UploadReview,
} from '../../services/uploadReview';

const KIND_LABEL: Record<string, string> = {
  web: '网页工具',
  skill: 'AI 技能',
  file: '文件下载',
  link: '外部链接',
  service: '服务型工具',
};
const STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: '草稿', cls: 'bg-soft text-t3' },
  pending: { label: '待审核', cls: 'bg-warnSoft text-warn' },
  deploying: { label: '部署中', cls: 'bg-accentSoft text-accentText' },
  deploy_failed: { label: '部署失败', cls: 'bg-dangerSoft text-danger' },
  online: { label: '已上线', cls: 'bg-okSoft text-ok' },
  rejected: { label: '已驳回', cls: 'bg-dangerSoft text-danger' },
  offline: { label: '已下线', cls: 'bg-soft text-t3' },
};
const CHECK_LABEL = {
  complete: '核查完成',
  attention: '有提醒项，请确认',
  blocked: '存在阻断项',
  unknown: '暂无法核实',
};
const REASONS = ['含外网请求', '资源过大', '描述不实', '重复工具', '其他'];
const fmtDT = (t?: number) =>
  t
    ? new Date(t).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
const isPending = (r: UploadRow) => r.status === 'pending' || r.status === 'deploy_failed';
const nameOf = (r: UploadRow) => r.name || r.filename || '未填写名称';
const focusClass =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';
type Tab = 'agent' | 'skill' | 'tool' | 'all';
interface Props {
  onOpenAlerts: () => void;
  onChanged?: () => void;
}

export default function ReviewCenter({ onOpenAlerts, onChanged }: Props) {
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [tab, setTab] = useState<Tab>('agent');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [filesBase, setFilesBase] = useState('');
  const [alertCount, setAlertCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const listSequence = useRef(0);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const filterRef = useRef<HTMLButtonElement | null>(null);
  const hadDialog = useRef(false);
  const applyReviewedRecord = useCallback((record: UploadRow) => {
    setRows((current) => current.map((row) => (row.id === record.id ? record : row)));
  }, []);
  const load = async () => {
    const request = ++listSequence.current;
    setLoading(true);
    setError('');
    try {
      const result = await api.uploads.adminList('');
      if (request !== listSequence.current) return;
      if (!result.ok) {
        setError('无法读取审核队列，请重试');
        return;
      }
      setRows((result.rows || []).filter((r) => r.status !== 'draft'));
      setFilesBase(result.filesBase || '');
    } catch {
      if (request === listSequence.current) setError('无法读取审核队列，请检查网络后重试');
    } finally {
      if (request === listSequence.current) setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    let current = true;
    api.gateway
      .alerts({ status: 'open' })
      .then((a) => {
        if (current && Array.isArray(a)) setAlertCount(a.length);
      })
      .catch(() => {});
    return () => {
      current = false;
      listSequence.current++;
    };
  }, []);
  const queues = {
    agent: rows.filter((r) => isPending(r) && reviewResourceType(r) === 'agent'),
    skill: rows.filter((r) => isPending(r) && reviewResourceType(r) === 'skill'),
    tool: rows.filter((r) => isPending(r) && reviewResourceType(r) === 'tool'),
  };
  const list = tab === 'all' ? rows : queues[tab];
  const active = rows.find((r) => r.id === activeId);
  const dialogOpen = !!active;
  useEffect(() => {
    if (dialogOpen) {
      hadDialog.current = true;
      return;
    }
    if (!hadDialog.current) return;
    hadDialog.current = false;
    let canceled = false;
    let timer: number | undefined;
    // ZbModal has no Dialog.Trigger. Restore this screen's opener after Radix's
    // deferred focus-scope cleanup, including when a refresh removes the dialog.
    queueMicrotask(() => {
      if (canceled) return;
      timer = window.setTimeout(() => {
        if (canceled) return;
        const opener = openerRef.current;
        const target = opener?.isConnected && !opener.disabled ? opener : filterRef.current;
        target?.focus();
      }, 0);
    });
    return () => {
      canceled = true;
      window.clearTimeout(timer);
    };
  }, [dialogOpen]);
  const weekOnline = rows.filter((r) => r.approvedAt && r.approvedAt > Date.now() - 7 * 86400000).length;
  const counts = [
    { label: '待审智能体', value: queues.agent.length },
    { label: '待审AI技能', value: queues.skill.length },
    { label: '待审工具', value: queues.tool.length },
    { label: '本周上线', value: weekOnline },
  ];

  return (
    <div className="p-6 flex flex-col gap-4 min-w-0">
      <div className="grid grid-cols-4 gap-3">
        {counts.map((k) => (
          <div key={k.label} className="card p-4">
            <div className="text-xs text-t3">{k.label}</div>
            <div className="text-2xl font-semibold tabular-nums mt-1">{k.value}</div>
          </div>
        ))}
      </div>
      <div className="flex gap-2 flex-wrap items-center" aria-label="审核队列筛选">
        {(['agent', 'skill', 'tool', 'all'] as const).map((k) => (
          <button
            key={k}
            ref={tab === k ? filterRef : undefined}
            aria-pressed={tab === k}
            onClick={() => setTab(k)}
            className={`tab ${focusClass} ${tab === k ? 'tab-active' : 'tab-idle'}`}
          >
            {k === 'all'
              ? `全部记录 ${rows.length}`
              : `待审${k === 'agent' ? '智能体' : k === 'skill' ? 'AI技能' : '工具'} ${queues[k].length}`}
          </button>
        ))}
        <span className="flex-1" />
        <button className={`btn-ghost !text-xs ${focusClass}`} onClick={onOpenAlerts}>
          查看待处理告警 {alertCount}
        </button>
        <button className={`btn-ghost !text-xs ${focusClass}`} disabled={loading} onClick={() => void load()}>
          刷新队列
        </button>
      </div>
      <p className="text-xs text-t3">
        打开记录后核查当前提交与技能状态。更新提交通过后会替换线上版本，保留统计与评价。
      </p>
      {error && (
        <div role="alert" className="rounded-xl bg-dangerSoft text-danger p-3 text-sm">
          {error}
          <button className={`ms-3 underline ${focusClass}`} onClick={() => void load()}>
            重试
          </button>
        </div>
      )}
      <div className="card w-full min-w-0 overflow-x-auto">
        <table className="w-full table-fixed text-sm text-start">
          <caption className="sr-only">上传审核队列</caption>
          <colgroup>
            <col />
            <col className="w-[100px]" />
            <col className="w-[132px]" />
            <col className="w-[112px]" />
            <col className="w-[98px]" />
            <col className="w-[102px]" />
          </colgroup>
          <thead className="bg-soft text-xs text-t3">
            <tr>
              {['提交名称', '类型', '申请人', '提交时间', '状态', '操作'].map((label) => (
                <th key={label} scope="col" className="text-start font-medium px-4 py-3 border-b border-line">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0 hover:bg-soft/60">
                <td className="px-4 py-3 break-words">
                  <span className="font-medium">{nameOf(r)}</span>
                  {r.updateOf && <span className="pill bg-accentSoft text-accentText ms-2">更新</span>}
                  {r.filename && <div className="text-xs text-t3 mt-1 break-all">{r.filename}</div>}
                </td>
                <td className="px-4 py-3">{REVIEW_TYPE_LABELS[reviewResourceType(r)]}</td>
                <td className="px-4 py-3 break-words">
                  {r.n}
                  <div className="text-xs text-t3 mt-1">{r.d}</div>
                </td>
                <td className="px-4 py-3 text-xs tabular-nums text-t2">
                  {fmtDT(r.submittedAt || r.createdAt)}
                </td>
                <td className="px-4 py-3">
                  <span className={`pill whitespace-nowrap ${STATUS[r.status].cls}`}>
                    {STATUS[r.status].label}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <button
                    className={`btn-ghost !px-3 !text-xs whitespace-nowrap ${focusClass}`}
                    aria-label={`${isPending(r) ? '审核' : '查看'} ${nameOf(r)}`}
                    onClick={(event) => {
                      openerRef.current = event.currentTarget;
                      setActiveId(r.id);
                    }}
                  >
                    {isPending(r) ? '去审核' : '查看'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!list.length && (
          <div role="status" className="p-12 text-center text-sm text-t3">
            {loading ? '正在读取审核队列…' : '当前队列没有记录，可切换到全部记录查看历史提交。'}
          </div>
        )}
        <div role="status" className="px-4 py-3 text-xs text-t3 border-t border-line">
          显示 {list.length} 条
        </div>
      </div>
      {active && (
        <ReviewDialog
          key={active.id}
          record={active}
          filesBase={filesBase}
          onClose={() => setActiveId(null)}
          onRefresh={load}
          onChanged={onChanged}
          onReviewedRecord={applyReviewedRecord}
        />
      )}
    </div>
  );
}

function ReviewDialog({
  record: queuedRecord,
  filesBase,
  onClose,
  onRefresh,
  onChanged,
  onReviewedRecord,
}: {
  record: UploadRow;
  filesBase: string;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onChanged?: () => void;
  onReviewedRecord: (record: UploadRow) => void;
}) {
  const [review, setReview] = useState<UploadReview | null>(null);
  const record = review?.record ?? queuedRecord;
  const [checking, setChecking] = useState(true);
  const [checkError, setCheckError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const sequence = useRef(0);
  const [rejecting, setRejecting] = useState(false);
  const reasonRef = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (rejecting) reasonRef.current?.focus();
  }, [rejecting]);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState('');
  const [reasonNote, setReasonNote] = useState('');
  const [reasonNoteError, setReasonNoteError] = useState('');
  const reasonNoteRef = useRef<HTMLTextAreaElement>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [history, setHistory] = useState<DeployRow[]>([]);
  const [historyError, setHistoryError] = useState('');
  const [historyAttempt, setHistoryAttempt] = useState(0);

  const inspect = async () => {
    const request = ++sequence.current;
    setChecking(true);
    setCheckError('');
    setReview(null);
    setPreviewUrl('');
    try {
      const result = await api.uploads.review(queuedRecord.id);
      if (!alive.current || request !== sequence.current) return;
      if (!result.ok) {
        setCheckError(result.message || '无法完成当前核查，请重试');
        return;
      }
      if (!isReviewSnapshot(result, queuedRecord.id)) {
        setCheckError('核查记录不完整或与当前提交不一致，请重新核查后处理');
        return;
      }
      if (!isReviewToken(result.reviewToken)) {
        setCheckError('核查凭据不完整，请重新核查后处理');
        return;
      }
      setReview(result);
      onReviewedRecord(result.record);
    } catch {
      if (alive.current && request === sequence.current) setCheckError('当前核查失败，请检查网络后重试');
    } finally {
      if (alive.current && request === sequence.current) setChecking(false);
    }
  };
  useEffect(() => {
    alive.current = true;
    void inspect();
    return () => {
      alive.current = false;
      sequence.current++;
    };
  }, [queuedRecord.id]);
  const deploymentKey =
    review && record.status === 'online'
      ? (/\/files\/uploads\/sites\/(u[a-z0-9]+)\//.exec(record.deployedUrl || '') || [])[1] ||
        (record.kind === 'service' ? `u${record.id}` : '')
      : '';
  useEffect(() => {
    let current = true;
    setHistory([]);
    setHistoryError('');
    if (deploymentKey)
      api.uploads
        .deployments(deploymentKey)
        .then((result) => {
          if (!current) return;
          if (!result.ok) setHistoryError('无法读取部署历史，请重试');
          else setHistory(result.rows || []);
        })
        .catch(() => {
          if (current) setHistoryError('无法读取部署历史，请检查网络后重试');
        });
    return () => {
      current = false;
    };
  }, [deploymentKey, historyAttempt, review?.reviewToken]);

  const mutate = async (action: () => Promise<any>, success: string) => {
    if (
      busyRef.current ||
      checking ||
      !review ||
      !isReviewToken(review.reviewToken) ||
      !isReviewSnapshot(review, queuedRecord.id)
    )
      return;
    busyRef.current = true;
    setBusy(true);
    setActionError('');
    setNotice('');
    try {
      const result = await action();
      if (!alive.current) return;
      if (!result?.ok) {
        if (result?.status === 409) {
          setActionError('提交内容或状态已变化，请查看最新核查后重新确认操作。');
          await onRefresh();
          if (alive.current) await inspect();
        } else setActionError(result?.message || '操作失败，请重试');
        return;
      }
      setNotice(result.message || success);
      setRejecting(false);
      setPreviewUrl('');
      await onRefresh();
      onChanged?.();
      if (alive.current) {
        setHistoryAttempt((n) => n + 1);
        await inspect();
      }
    } catch {
      if (alive.current) setActionError('操作失败，请检查网络后重试');
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const type = review?.resourceType || reviewResourceType(record);
  const canDecide =
    !!review &&
    isReviewToken(review.reviewToken) &&
    isReviewSnapshot(review, queuedRecord.id) &&
    !checking &&
    !busy;
  const canApprove =
    canDecide && !!review && (review.check.state === 'complete' || review.check.state === 'attention');
  const approvalBlock = checking
    ? '当前核查完成后可处理审核。'
    : checkError
      ? '当前核查未完成，请重新核查后处理审核。'
      : !canApprove && !busy
        ? '当前核查尚未通过，请处理阻断项或重新核查。驳回仍可使用。'
        : '';
  const approveLabel =
    record.status === 'deploy_failed'
      ? '重试部署'
      : record.updateOf
        ? '通过并更新线上版本'
        : type === 'agent'
          ? '通过并发布智能体'
          : type === 'skill'
            ? '通过并发布技能'
            : '通过并自动部署';
  const doReject = () => {
    if (!canDecide || !review) return;
    if (!reason) {
      setReasonError('请选择驳回原因');
      reasonRef.current?.focus();
      return;
    }
    if (reason === '其他' && !reasonNote.trim()) {
      setReasonNoteError('请填写补充说明后确认驳回');
      reasonNoteRef.current?.focus();
      return;
    }
    void mutate(
      () =>
        api.uploads.reject(
          record.id,
          reason === '其他' ? `其他：${reasonNote.trim()}` : reason,
          review.revision,
          review.reviewToken,
        ),
      '已驳回',
    );
  };
  return (
    <ZbModal
      open
      onClose={() => {
        if (!busyRef.current) onClose();
      }}
      label="审核详情"
      dismissible={!busy}
      maxWidth="max-w-[1040px]"
      className="!p-0 h-[760px] max-h-[calc(100vh-48px)] flex flex-col overflow-hidden"
    >
      <div data-review-shell className="h-full flex flex-col min-h-0 text-sm">
        <header className="shrink-0 px-6 py-5 border-b border-line flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-xl leading-snug font-semibold break-words">{nameOf(record)}</h2>
            <div className="flex flex-wrap gap-x-3 gap-y-2 items-center mt-2 text-xs text-t2">
              <span className="pill bg-soft text-t2">{REVIEW_TYPE_LABELS[type]}</span>
              <span className={`pill ${STATUS[record.status].cls}`}>{STATUS[record.status].label}</span>
              <span>
                申请人：{record.n}（{record.d}）
              </span>
              <span>{fmtDT(record.submittedAt || record.createdAt)} 提交</span>
            </div>
          </div>
          <button
            className={`btn-ghost !w-10 !h-10 !p-0 shrink-0 ${focusClass}`}
            disabled={busy}
            onClick={onClose}
            aria-label="关闭审核详情"
          >
            ✕
          </button>
        </header>
        <div
          data-review-scroll
          className="relative flex-1 min-h-0 overflow-y-auto overscroll-contain px-6 py-5 space-y-6"
        >
          {checking && (
            <div role="status" className="rounded-xl bg-soft p-5 text-t2">
              正在核查提交内容…
            </div>
          )}
          {checkError && (
            <div role="alert" className="rounded-xl bg-dangerSoft text-danger p-4">
              {checkError}
            </div>
          )}
          {review && (
            <>
              <section aria-labelledby="review-purpose">
                <h3 id="review-purpose" className="font-semibold mb-2">
                  业务用途
                </h3>
                <p className="text-t2 leading-relaxed whitespace-pre-wrap break-words">
                  {review.summary.purpose || '未提供业务用途，请结合提交材料核实。'}
                </p>
                {!!record.departments?.length && (
                  <p className="text-xs text-t3 mt-2">适用部门：{record.departments.join('、')}</p>
                )}
                {!!record.tags?.length && (
                  <p className="text-xs text-t3 mt-2">业务标签：{record.tags.join('、')}</p>
                )}
              </section>
              <RuntimeRequirements requirements={review.summary.runtimeRequirements} />
              <section aria-labelledby="review-check">
                <div className="flex gap-3 items-center mb-2">
                  <h3 id="review-check" className="font-semibold">
                    当前核查
                  </h3>
                  <span
                    className={`pill ${review.check.state === 'complete' ? 'bg-okSoft text-ok' : review.check.state === 'blocked' ? 'bg-dangerSoft text-danger' : 'bg-warnSoft text-warn'}`}
                  >
                    {CHECK_LABEL[review.check.state]}
                  </span>
                </div>
                <p className="text-xs text-t3">
                  核查时间：{fmtDT(review.check.checkedAt)} · 提交修订 {review.revision}
                </p>
                {!review.check.sourceAvailable && (
                  <p className="text-warn mt-2">历史源文件不可用，暂无法核实提交内容。</p>
                )}
                {!!review.check.issues.length && (
                  <ul className="mt-3 space-y-2">
                    {review.check.issues.map((issue, i) => (
                      <li
                        key={i}
                        className={`leading-relaxed break-words ${issue.level === 'error' ? 'text-danger' : 'text-t2'}`}
                      >
                        <span className="font-medium">
                          {issue.level === 'error' ? '阻断' : issue.level === 'warn' ? '提醒' : '说明'}：
                        </span>
                        {issue.message}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section aria-labelledby="review-functions">
                <h3 id="review-functions" className="font-semibold mb-3">
                  功能与来源
                </h3>
                {review.summary.functions.length ? (
                  <div className="border border-line rounded-xl overflow-hidden">
                    <table className="w-full table-fixed text-sm">
                      <caption className="sr-only">当前提交的功能、来源和状态</caption>
                      <colgroup>
                        <col />
                        <col className="w-[140px]" />
                        <col className="w-[190px]" />
                      </colgroup>
                      <thead className="text-xs text-t3 bg-soft">
                        <tr>
                          <th scope="col" className="text-start px-4 py-2.5 font-medium">
                            功能
                          </th>
                          <th scope="col" className="text-start px-4 py-2.5 font-medium">
                            来源
                          </th>
                          <th scope="col" className="text-start px-4 py-2.5 font-medium">
                            当前状态
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {review.summary.functions.map((fn) => (
                          <tr key={`${fn.source}:${fn.id}`} className="border-t border-line">
                            <td className="px-4 py-3 break-words">
                              {fn.name}
                              {type !== 'tool' && fn.kind === 'script' && (
                                <span className="text-xs text-t3 ms-2">脚本</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-t2">
                              {fn.source === 'package' ? '包内功能' : '技能中心'}
                            </td>
                            <td className="px-4 py-3">
                              <span className={fn.status === 'ready' ? 'text-t2' : 'text-warn'}>
                                {FUNCTION_STATUS[fn.status] || '暂无法核实'}
                              </span>
                              <span className="text-xs text-t3 ms-2">{fn.required ? '必需' : '可选'}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-t3">
                    {type === 'tool'
                      ? '工具通过页面或服务提供功能，请结合用途与预览核实。'
                      : '未提取到可核实的功能清单。'}
                  </p>
                )}
                {!!review.summary.steps.length && (
                  <ol className="mt-3 space-y-2 text-t2">
                    {review.summary.steps.map((step, index) => (
                      <li key={step.id} className="break-words leading-relaxed">
                        {index + 1}. {step.task}
                        <span className="text-xs text-t3 ms-2">
                          {step.executor === 'self'
                            ? '自行处理'
                            : `交由功能：${step.targets.map((id) => reviewTargetName(id, review.summary.functions)).join('、')}`}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
              {(review.update || record.updateOf) && (
                <section aria-labelledby="review-update">
                  <h3 id="review-update" className="font-semibold mb-3">
                    本次变化
                  </h3>
                  {review.update ? (
                    <>
                      <p className="text-t2">
                        更新对象：<span className="font-medium text-t1">{review.update.target.name}</span>
                        {review.update.target.version && (
                          <span className="ms-2">当前版本 {review.update.target.version}</span>
                        )}
                        {review.update.proposedVersion && (
                          <span className="ms-2">→ {review.update.proposedVersion}</span>
                        )}
                      </p>
                      {review.update.state === 'unavailable' ? (
                        <p className="text-warn mt-2">暂无法读取线上版本，无法核实本次变化。请重新核查。</p>
                      ) : review.update.changes.length ? (
                        <div className="mt-3 border border-line rounded-xl overflow-hidden">
                          <table className="w-full table-fixed text-sm">
                            <caption className="sr-only">线上版本与本次提交的差异</caption>
                            <colgroup>
                              <col className="w-[108px]" />
                              <col />
                              <col />
                            </colgroup>
                            <thead className="text-xs text-t3 bg-soft">
                              <tr>
                                {['项目', '线上版本', '本次提交'].map((t) => (
                                  <th key={t} scope="col" className="text-start px-4 py-2.5 font-medium">
                                    {t}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {review.update.changes.map((change) => (
                                <tr key={change.field} className="border-t border-line align-top">
                                  <th scope="row" className="text-start px-4 py-3 font-medium">
                                    {change.label}
                                  </th>
                                  {[change.before, change.after].map((values, i) => (
                                    <td
                                      key={i}
                                      className="px-4 py-3 text-t2 break-words whitespace-pre-wrap leading-relaxed"
                                    >
                                      {values.length
                                        ? values.map((value, n) => <p key={n}>{value}</p>)
                                        : '无'}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <p className="text-t3 mt-2">
                          已核对用途、功能与执行步骤，未发现变化；请继续核实包内材料。
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-warn">暂无法读取线上版本，无法核实本次变化。</p>
                  )}
                </section>
              )}
            </>
          )}
          {review && record.updateNote && (
            <section aria-labelledby="review-note">
              <h3 id="review-note" className="font-semibold mb-2">
                开发者更新说明
              </h3>
              <p className="whitespace-pre-wrap break-words leading-relaxed text-t2">{record.updateNote}</p>
            </section>
          )}
          {review && record.kind === 'web' && record.report?.entry && (
            <section aria-label="提交预览">
              <button
                className={`btn-ghost !text-xs ${focusClass}`}
                disabled={busy}
                onClick={() =>
                  setPreviewUrl(
                    `${filesBase}/files/uploads-preview/${record.id}/${record.report!.entry}?t=${Date.now()}`,
                  )
                }
              >
                {previewUrl ? '刷新预览' : '试运行预览'}
              </button>
              {previewUrl && (
                <iframe
                  src={previewUrl}
                  className="w-full h-[300px] mt-3 border border-line rounded-xl bg-card"
                  title="提交内容预览"
                  sandbox="allow-scripts allow-forms"
                />
              )}
              <p className="text-xs text-t3 mt-2">预览在沙箱中运行，不授予门户同源访问权限。</p>
            </section>
          )}
          {review && record.kind === 'link' && record.url && (
            <p className="break-all text-t2">提交链接：{record.url}</p>
          )}
          {review && record.status === 'online' && (
            <section
              aria-label="上线信息"
              className="rounded-xl bg-okSoft text-ok p-4 leading-relaxed break-words"
            >
              已上线{record.deployedUrl ? ` · ${record.deployedUrl}` : ''}
              {record.kind === 'skill' &&
                (record.publishSlug ? ` · 已上架技能中心（${record.publishSlug}）` : ' · 未上架技能中心')}
              {record.healthCheck ? ` · 部署探活 ${record.healthCheck.status}` : ''}
            </section>
          )}
          {deploymentKey && (
            <details className="border border-line rounded-xl p-4">
              <summary className={`cursor-pointer font-medium ${focusClass}`}>部署历史</summary>
              {historyError ? (
                <div className="mt-3 text-danger">
                  {historyError}
                  <button
                    disabled={busy}
                    className={`ms-3 underline ${focusClass}`}
                    onClick={() => setHistoryAttempt((n) => n + 1)}
                  >
                    重试读取历史
                  </button>
                </div>
              ) : history.length ? (
                <ul className="mt-3 space-y-2 text-xs text-t2">
                  {history.slice(0, 5).map((d) => (
                    <li key={d.id}>
                      {fmtDT(d.at)} · {d.version} · {d.type === 'rollback' ? '回滚' : '部署'} · {d.by || '—'}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-t3">暂无部署历史</p>
              )}
              <button
                disabled={!canDecide}
                className={`btn-ghost !text-xs mt-3 ${focusClass}`}
                onClick={() => {
                  if (confirm('确认回滚到上一版本？对外 URL 保持不变。'))
                    void mutate(() => api.uploads.rollback(record.id), '已回滚');
                }}
              >
                回滚上一版
              </button>
            </details>
          )}
          {review && record.status === 'rejected' && (
            <p className="rounded-xl bg-dangerSoft text-danger p-4">
              已驳回 · 原因：{record.rejectReason || '未填写'}
            </p>
          )}
          {review && record.status === 'deploy_failed' && (
            <p className="rounded-xl bg-dangerSoft text-danger p-4">
              部署失败 · {record.deployError || '未返回失败原因'}。可重新核查后重试部署，或驳回申请。
            </p>
          )}
          {review && (record.report || !!review.summary.steps.length) && (
            <details className="border border-line rounded-xl p-4">
              <summary className={`cursor-pointer font-medium ${focusClass}`}>技术解析报告</summary>
              <p className="text-xs text-t3 mt-3">以下为提交时的解析记录，当前状态以上方核查为准。</p>
              <div className="mt-3 space-y-2 text-xs text-t2 break-words">
                {record.report?.rules?.map((rule, index) => (
                  <p key={index} className={rule.level === 'error' ? 'text-danger' : 'text-t2'}>
                    {rule.level === 'error' ? '阻断' : '提醒'}：{rule.msg}
                    {rule.fix && `；处理建议：${rule.fix}`}
                  </p>
                ))}
                {record.report?.lines?.map((line, index) => (
                  <p key={index}>{line}</p>
                ))}
                {record.report?.entry && <p>入口：{record.report.entry}</p>}
                {review?.summary.steps.map((step) => (
                  <p key={step.id}>
                    步骤标识：{step.id} · 原始目标：{step.targets.join('、') || '无'}
                  </p>
                ))}
              </div>
            </details>
          )}
          {review &&
            isPending(record) &&
            !record.updateOf &&
            ['web', 'service', 'skill', 'file'].includes(record.kind) && (
              <details className="border border-line rounded-xl p-4">
                <summary className={`cursor-pointer font-medium ${focusClass}`}>类型改判</summary>
                <p className="text-xs text-t3 mt-3">
                  自动识别为{KIND_LABEL[record.kind]}。改判后会重新核查提交内容。
                </p>
                <div className="flex flex-wrap gap-3 mt-3">
                  {(['web', 'service', 'skill'] as const).map((kind) => (
                    <button
                      key={kind}
                      className={`btn-ghost !text-xs ${focusClass}`}
                      disabled={!canDecide || kind === record.kind}
                      onClick={() => void mutate(() => api.uploads.rekind(record.id, kind), '已改判类型')}
                    >
                      {KIND_LABEL[kind]}
                    </button>
                  ))}
                </div>
                {record.rekindNote && <p className="text-xs text-t3 mt-3">改判记录：{record.rekindNote}</p>}
              </details>
            )}
          {rejecting && (
            <section className="rounded-xl border border-line p-4 space-y-3" aria-labelledby="reject-heading">
              <h3 id="reject-heading" className="font-semibold">
                驳回原因（申请人可见）
              </h3>
              <div>
                <label htmlFor="review-reason" className="block text-xs text-t2 mb-2">
                  驳回原因
                </label>
                <select
                  ref={reasonRef}
                  id="review-reason"
                  disabled={busy}
                  value={reason}
                  aria-invalid={!!reasonError}
                  aria-describedby={reasonError ? 'review-reason-error' : undefined}
                  onChange={(e) => {
                    setReason(e.target.value);
                    setReasonError('');
                  }}
                  className={`h-10 w-full rounded-lg bg-soft border border-line px-3 text-sm text-t1 ${focusClass}`}
                >
                  <option value="" disabled>
                    请选择驳回原因
                  </option>
                  {REASONS.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
                {reasonError && (
                  <p id="review-reason-error" role="alert" className="text-xs text-danger mt-2">
                    {reasonError}
                  </p>
                )}
              </div>
              {reason === '其他' && (
                <div>
                  <label htmlFor="review-reason-note" className="block text-xs text-t2 mb-2">
                    补充说明
                  </label>
                  <textarea
                    ref={reasonNoteRef}
                    id="review-reason-note"
                    disabled={busy}
                    value={reasonNote}
                    aria-invalid={!!reasonNoteError}
                    aria-describedby={`review-reason-note-limit${reasonNoteError ? ' review-reason-note-error' : ''}`}
                    onChange={(e) => {
                      setReasonNote(e.target.value.slice(0, 117));
                      setReasonNoteError('');
                    }}
                    maxLength={117}
                    rows={3}
                    className={`w-full rounded-lg bg-soft border border-line p-3 text-sm text-t1 ${focusClass}`}
                  />
                  <p id="review-reason-note-limit" className="text-xs text-t3 mt-2">
                    最多117字 · {reasonNote.length}/117
                  </p>
                  {reasonNoteError && (
                    <p id="review-reason-note-error" role="alert" className="text-xs text-danger mt-2">
                      {reasonNoteError}
                    </p>
                  )}
                </div>
              )}
              <p className="text-xs text-t3">驳回更新提交不会影响当前线上版本。</p>
            </section>
          )}
        </div>
        <footer className="shrink-0 border-t border-line px-6 py-4 space-y-3 bg-card">
          {actionError && (
            <div
              role="alert"
              className="rounded-lg bg-dangerSoft text-danger px-3 py-2 leading-relaxed max-h-24 overflow-y-auto"
            >
              {actionError}
              <button
                className={`ms-3 underline text-xs ${focusClass}`}
                disabled={busy}
                onClick={() => setActionError('')}
              >
                关闭提示
              </button>
            </div>
          )}
          <div role="status" className={notice ? 'rounded-lg bg-okSoft text-ok px-3 py-2' : 'sr-only'}>
            {notice}
          </div>
          {isPending(record) && approvalBlock && (
            <p id="approval-block" className="text-xs text-t2">
              {approvalBlock}
            </p>
          )}
          <div className="flex items-center gap-3 flex-wrap">
            <button
              disabled={busy || checking}
              className={`btn-ghost !text-xs ${focusClass}`}
              onClick={() => {
                setNotice('');
                void inspect();
              }}
            >
              重新核查
            </button>
            <span className="flex-1" />
            {isPending(record) ? (
              rejecting ? (
                <>
                  <button
                    disabled={busy}
                    className={`btn-ghost !text-xs ${focusClass}`}
                    onClick={() => setRejecting(false)}
                  >
                    取消驳回
                  </button>
                  <button
                    aria-busy={busy}
                    disabled={!canDecide}
                    className={`btn-primary !bg-danger !border-danger !text-xs ${focusClass}`}
                    onClick={doReject}
                  >
                    <ActionLabel label="确认驳回" busyLabel="正在驳回…" busy={busy} />
                  </button>
                </>
              ) : (
                <>
                  <button
                    disabled={!canDecide}
                    className={`btn-ghost !text-xs ${focusClass}`}
                    onClick={() => setRejecting(true)}
                  >
                    驳回
                  </button>
                  <button
                    aria-busy={busy}
                    disabled={!canApprove}
                    aria-describedby={approvalBlock ? 'approval-block' : undefined}
                    className={`btn-primary !text-xs ${focusClass}`}
                    onClick={() => {
                      if (canApprove)
                        void mutate(
                          () => api.uploads.approve(record.id, review!.revision, review!.reviewToken),
                          record.updateOf ? '已通过，正在替换线上版本' : '已通过',
                        );
                    }}
                  >
                    <ActionLabel label={approveLabel} busyLabel="正在处理…" busy={busy} />
                  </button>
                </>
              )
            ) : (
              <>
                {record.status === 'online' && record.kind === 'skill' && !record.publishSlug && (
                  <button
                    disabled={!canDecide}
                    className={`btn-primary !text-xs ${focusClass}`}
                    onClick={() => void mutate(() => api.uploads.publish(record.id), '已上架技能中心')}
                  >
                    上架到技能中心
                  </button>
                )}
                {record.status === 'online' && (
                  <button
                    disabled={!canDecide}
                    className={`btn-ghost !text-xs ${focusClass}`}
                    onClick={() => {
                      if (confirm('确认下线？门户将隐藏此资源，保留部署文件。'))
                        void mutate(() => api.uploads.offline(record.id), '已下线');
                    }}
                  >
                    下线
                  </button>
                )}
              </>
            )}
          </div>
        </footer>
      </div>
    </ZbModal>
  );
}

/** Both labels occupy one grid cell so async feedback cannot move neighboring actions. */
function ActionLabel({ label, busyLabel, busy }: { label: string; busyLabel: string; busy: boolean }) {
  return (
    <span className="inline-grid place-items-center">
      <span aria-hidden="true" className="invisible col-start-1 row-start-1 whitespace-nowrap">
        {label}
      </span>
      <span aria-hidden="true" className="invisible col-start-1 row-start-1 whitespace-nowrap">
        {busyLabel}
      </span>
      <span className="col-start-1 row-start-1 whitespace-nowrap">{busy ? busyLabel : label}</span>
    </span>
  );
}
