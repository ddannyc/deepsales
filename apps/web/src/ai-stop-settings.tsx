import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '#components/ui/button'
import { Input } from '#components/ui/input'
import { Textarea } from '#components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select'

export type AiStopCondition =
  | { kind: 'PROPERTY'; definitionId: string; value: string | number }
  | { kind: 'TAG'; tagId: string }
  | { kind: 'REPLIES'; minimum: number }
export type AiStopRules = {
  groups: AiStopCondition[][]
  periods: { day: number; start: string; end: string }[]
  endingText: string
  endingMediaAssetId: string | null
}
export const emptyStopRules: AiStopRules = {
  groups: [],
  periods: [],
  endingText: '',
  endingMediaAssetId: null,
}
type Options = {
  properties: { id: string; name: string; level: string; type: string; options: string[] }[]
  tags: { id: string; name: string; level: string }[]
}

export function AiStopSettings({
  workspaceId,
  rules,
  onChange,
  busy,
  audienceOnly = false,
}: {
  workspaceId: string
  rules: AiStopRules
  onChange: (rules: AiStopRules) => void
  busy: boolean
  audienceOnly?: boolean
}) {
  const titleId = useId()
  const [options, setOptions] = useState<Options>()
  const [assets, setAssets] = useState<{ id: string; title: string; kind: string }[]>()
  const [error, setError] = useState('')
  const groupKeys = useRef<string[]>([])
  const conditionKeys = useRef<string[][]>([])
  const periodKeys = useRef<string[]>([])
  for (let i = 0; i < rules.groups.length; i++) {
    groupKeys.current[i] ??= crypto.randomUUID()
    conditionKeys.current[i] ??= []
    for (let j = 0; j < rules.groups[i].length; j++)
      conditionKeys.current[i][j] ??= crypto.randomUUID()
  }
  for (let i = 0; i < rules.periods.length; i++) periodKeys.current[i] ??= crypto.randomUUID()
  useEffect(() => {
    let cancelled = false
    setOptions(undefined)
    setAssets(undefined)
    setError('')
    void Promise.all([
      fetch(`/api/workspaces/${workspaceId}/inbox-filter-options`),
      fetch(`/api/workspaces/${workspaceId}/media-assets`),
    ])
      .then(async (responses) => {
        if (responses.some((r) => !r.ok)) throw new Error('读取停止条件和素材失败；请刷新重试。')
        const [definitions, media] = await Promise.all(responses.map((r) => r.json()))
        if (!cancelled) {
          setOptions(definitions)
          setAssets(media.assets.filter((a: { kind: string }) => a.kind === 'IMAGE'))
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(cause.message)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId])
  function condition(groupIndex: number, conditionIndex: number, value: AiStopCondition) {
    onChange({
      ...rules,
      groups: rules.groups.map((g, i) =>
        i === groupIndex ? g.map((c, j) => (j === conditionIndex ? value : c)) : g,
      ),
    })
  }
  const firstProperty = options?.properties[0]
  const defaultCondition: AiStopCondition | undefined = audienceOnly
    ? firstProperty
      ? {
          kind: 'PROPERTY',
          definitionId: firstProperty.id,
          value: firstProperty.type === 'NUMBER' ? 0 : (firstProperty.options[0] ?? ''),
        }
      : options?.tags[0]
        ? { kind: 'TAG', tagId: options.tags[0].id }
        : undefined
    : { kind: 'REPLIES', minimum: 1 }
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return (
    <section className="ai-config-section" aria-labelledby={titleId}>
      <div className="section-heading">
        <div>
          <h2 id={titleId}>{audienceOnly ? '回访客户条件' : '停止回复'}</h2>
          <p>
            {audienceOnly
              ? '条件为空面向全部合格客户；组内 AND，组间 OR。失效条件不会匹配，保存和执行时重新校验。'
              : '保存草稿后发布生效。组内全部匹配（AND），组间任一匹配（OR）；停止不自动转人工。'}
          </p>
        </div>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {rules.groups.map((group, i) => (
        <fieldset key={groupKeys.current[i]} disabled={busy}>
          <legend>条件组 {i + 1}</legend>
          {group.map((c, j) => (
            <div className="form-grid-two" key={conditionKeys.current[i][j]}>
              <Select
                value={
                  c.kind === 'PROPERTY'
                    ? `property:${c.definitionId}`
                    : c.kind === 'TAG'
                      ? `tag:${c.tagId}`
                      : 'REPLIES'
                }
                onValueChange={(value) => {
                  if (value === 'REPLIES') condition(i, j, { kind: 'REPLIES', minimum: 1 })
                  else if (value.startsWith('tag:'))
                    condition(i, j, { kind: 'TAG', tagId: value.slice(4) })
                  else {
                    const id = value.slice(9)
                    const d = options?.properties.find((p) => p.id === id)
                    condition(i, j, {
                      kind: 'PROPERTY',
                      definitionId: id,
                      value: d?.type === 'NUMBER' ? 0 : (d?.options[0] ?? ''),
                    })
                  }
                }}
              >
                <SelectTrigger aria-label={`条件组 ${i + 1} 条件 ${j + 1}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {!audienceOnly && <SelectItem value="REPLIES">AI 逻辑回复轮次达到</SelectItem>}
                  {options?.properties.map((d) => (
                    <SelectItem key={d.id} value={`property:${d.id}`}>
                      {d.level === 'CUSTOMER' ? '客户' : '会话'}属性：{d.name} 等于
                    </SelectItem>
                  ))}
                  {options?.tags.map((d) => (
                    <SelectItem key={d.id} value={`tag:${d.id}`}>
                      {d.level === 'CUSTOMER' ? '客户' : '会话'}标签：{d.name}
                    </SelectItem>
                  ))}
                  {c.kind === 'PROPERTY' &&
                    options &&
                    !options.properties.some((d) => d.id === c.definitionId) && (
                      <SelectItem value={`property:${c.definitionId}`}>
                        已删除属性，请移除或重新选择
                      </SelectItem>
                    )}
                  {c.kind === 'TAG' && options && !options.tags.some((d) => d.id === c.tagId) && (
                    <SelectItem value={`tag:${c.tagId}`}>已删除标签，请移除或重新选择</SelectItem>
                  )}
                </SelectContent>
              </Select>
              {c.kind === 'REPLIES' ? (
                <Input
                  aria-label={`条件组 ${i + 1} 回复轮次`}
                  type="number"
                  min={0}
                  max={10000}
                  value={c.minimum}
                  onChange={(e) => condition(i, j, { ...c, minimum: Number(e.target.value) })}
                />
              ) : c.kind === 'PROPERTY' ? (
                (() => {
                  const d = options?.properties.find((p) => p.id === c.definitionId)
                  return d?.type === 'OPTION' ? (
                    <Select
                      value={String(c.value)}
                      onValueChange={(value) => condition(i, j, { ...c, value })}
                    >
                      <SelectTrigger aria-label={`条件组 ${i + 1} 属性值`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {d.options.map((o) => (
                          <SelectItem key={o} value={o}>
                            {o}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      aria-label={`条件组 ${i + 1} 属性值`}
                      type={d?.type === 'NUMBER' ? 'number' : 'text'}
                      value={c.value}
                      maxLength={2000}
                      onChange={(e) =>
                        condition(i, j, {
                          ...c,
                          value: d?.type === 'NUMBER' ? Number(e.target.value) : e.target.value,
                        })
                      }
                    />
                  )
                })()
              ) : (
                <span className="field-description">已添加此标签</span>
              )}
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  conditionKeys.current[i].splice(j, 1)
                  if (group.length === 1) {
                    groupKeys.current.splice(i, 1)
                    conditionKeys.current.splice(i, 1)
                  }
                  onChange({
                    ...rules,
                    groups: rules.groups
                      .map((g, k) => (k === i ? g.filter((_, n) => n !== j) : g))
                      .filter((g) => g.length),
                  })
                }}
              >
                移除条件
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            disabled={group.length >= 10 || !defaultCondition}
            onClick={() =>
              onChange({
                ...rules,
                groups: rules.groups.map((g, k) =>
                  k === i && defaultCondition ? [...g, defaultCondition] : g,
                ),
              })
            }
          >
            添加 AND 条件
          </Button>
        </fieldset>
      ))}
      <Button
        type="button"
        variant="outline"
        disabled={busy || rules.groups.length >= 10 || !defaultCondition}
        onClick={() =>
          defaultCondition && onChange({ ...rules, groups: [...rules.groups, [defaultCondition]] })
        }
      >
        {audienceOnly ? '添加回访条件组' : '添加停止条件组'}
      </Button>
      {!audienceOnly && (
        <>
          <p className="field-description">
            条件停止持续当前会话；改变属性或移除标签不会恢复。分段回复和附带素材算一个逻辑回复，已提交的失败回复也计入；系统转人工通知不计入。
          </p>
          <h3>每周停止时段</h3>
          <p className="field-description">
            使用上方配置时区，起点包含、终点不包含。跨午夜请拆为两天，全天可填
            00:00–24:00。时段结束后，新的客户输入恢复接待。
          </p>
          {rules.periods.map((p, i) => (
            <div className="form-grid-two" key={periodKeys.current[i]}>
              <Select
                disabled={busy}
                value={String(p.day)}
                onValueChange={(value) =>
                  onChange({
                    ...rules,
                    periods: rules.periods.map((v, j) =>
                      j === i ? { ...v, day: Number(value) } : v,
                    ),
                  })
                }
              >
                <SelectTrigger aria-label={`停止时段 ${i + 1} 星期`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {days.map((d, j) => (
                    <SelectItem key={d} value={String(j)}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {(['start', 'end'] as const).map((key) => (
                <label
                  key={key}
                  className="form-field"
                  htmlFor={`stop-${periodKeys.current[i]}-${key}`}
                >
                  <span>{key === 'start' ? '开始' : '结束'}</span>
                  <Input
                    id={`stop-${periodKeys.current[i]}-${key}`}
                    disabled={busy}
                    aria-label={`停止时段 ${i + 1} ${key === 'start' ? '开始' : '结束'}`}
                    value={p[key]}
                    placeholder="HH:mm"
                    maxLength={5}
                    onChange={(e) =>
                      onChange({
                        ...rules,
                        periods: rules.periods.map((v, j) =>
                          j === i ? { ...v, [key]: e.target.value } : v,
                        ),
                      })
                    }
                  />
                </label>
              ))}
              <Button
                type="button"
                disabled={busy}
                variant="ghost"
                onClick={() => {
                  periodKeys.current.splice(i, 1)
                  onChange({ ...rules, periods: rules.periods.filter((_, j) => j !== i) })
                }}
              >
                移除时段
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            disabled={busy || rules.periods.length >= 28}
            onClick={() =>
              onChange({
                ...rules,
                periods: [...rules.periods, { day: 1, start: '18:00', end: '24:00' }],
              })
            }
          >
            添加每周停止时段
          </Button>
          <label className="form-field" htmlFor="ai-stop-ending">
            <span className="form-field-label">停止结束文字（可选）</span>
            <Textarea
              id="ai-stop-ending"
              disabled={busy}
              value={rules.endingText}
              maxLength={4000}
              rows={3}
              onChange={(e) => onChange({ ...rules, endingText: e.target.value })}
            />
          </label>
          <Select
            disabled={busy || !assets}
            value={rules.endingMediaAssetId ?? 'NONE'}
            onValueChange={(value) =>
              onChange({ ...rules, endingMediaAssetId: value === 'NONE' ? null : value })
            }
          >
            <SelectTrigger aria-label="停止结束图片">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="NONE">无结束图片</SelectItem>
              {assets?.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.title}
                </SelectItem>
              ))}
              {rules.endingMediaAssetId &&
                assets &&
                !assets.some((a) => a.id === rules.endingMediaAssetId) && (
                  <SelectItem value={rules.endingMediaAssetId}>
                    图片已失效，请移除或重新选择
                  </SelectItem>
                )}
            </SelectContent>
          </Select>
          <p className="field-description">
            只在进入停止时发送一次；留空则不发送。文字由管理员提供，请确认事实和语言；图片必须来自授权私有素材库。发送状态和渠道限制仍会显示在会话中，客户要求人工仍按转人工策略处理。
            启用客户要求人工转接时，停止期间仍使用模型识别请求，并按现有用量计费。
          </p>
        </>
      )}
    </section>
  )
}
