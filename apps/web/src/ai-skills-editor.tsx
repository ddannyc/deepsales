import { AiInstructionInsert } from './ai-instruction-insert'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'
import { Textarea } from './components/ui/textarea'

export type AiSkillDraft = { id: string; name: string; condition: string; instructions: string }

export function AiSkillsEditor({
  skills,
  onChange,
  disabled,
  workspaceId,
  memberId,
}: {
  skills: AiSkillDraft[]
  onChange: (skills: AiSkillDraft[]) => void
  disabled: boolean
  workspaceId: string
  memberId: string
}) {
  function update(id: string, field: keyof Omit<AiSkillDraft, 'id'>, value: string) {
    onChange(skills.map((skill) => (skill.id === id ? { ...skill, [field]: value } : skill)))
  }
  function move(index: number, offset: number) {
    const reordered = [...skills]
    ;[reordered[index], reordered[index + offset]] = [reordered[index + offset], reordered[index]]
    onChange(reordered)
  }
  return (
    <section className="ai-config-section" aria-labelledby="ai-skills-title">
      <div className="section-heading">
        <div>
          <h3 id="ai-skills-title">技能</h3>
          <p className="field-description">
            发布后按此顺序判断条件，每轮仅执行首个命中的技能；未命中时使用普通回复。
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={disabled || skills.length >= 20}
          onClick={() =>
            onChange([
              ...skills,
              { id: crypto.randomUUID(), name: '', condition: '', instructions: '' },
            ])
          }
        >
          添加技能
        </Button>
      </div>
      {!skills.length && (
        <p className="field-description">暂无技能。添加后与主配置一起保存、发布。</p>
      )}
      <ol className="ai-skills-list">
        {skills.map((skill, index) => (
          <li key={skill.id} className="ai-config-section" aria-label={`技能 ${index + 1}`}>
            <div className="section-heading">
              <strong>优先级 {index + 1}</strong>
              <div className="form-actions">
                <Button
                  type="button"
                  variant="outline"
                  disabled={disabled || index === 0}
                  onClick={() => move(index, -1)}
                >
                  上移
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={disabled || index === skills.length - 1}
                  onClick={() => move(index, 1)}
                >
                  下移
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => onChange(skills.filter((item) => item.id !== skill.id))}
                >
                  删除技能
                </Button>
              </div>
            </div>
            <label className="form-field" htmlFor={`skill-name-${skill.id}`}>
              <span className="form-field-label">技能名称</span>
              <Input
                id={`skill-name-${skill.id}`}
                value={skill.name}
                maxLength={100}
                disabled={disabled}
                required
                onChange={(event) => update(skill.id, 'name', event.currentTarget.value)}
              />
            </label>
            <label className="form-field" htmlFor={`skill-condition-${skill.id}`}>
              <span className="form-field-label">触发条件</span>
              <Textarea
                id={`skill-condition-${skill.id}`}
                value={skill.condition}
                maxLength={2000}
                disabled={disabled}
                required
                onChange={(event) => update(skill.id, 'condition', event.currentTarget.value)}
              />
            </label>
            <label className="form-field" htmlFor={`skill-instructions-${skill.id}`}>
              <span className="form-field-label">技能指令</span>
              <Textarea
                id={`skill-instructions-${skill.id}`}
                value={skill.instructions}
                maxLength={8000}
                disabled={disabled}
                required
                onChange={(event) => update(skill.id, 'instructions', event.currentTarget.value)}
              />
            </label>
            <AiInstructionInsert
              workspaceId={workspaceId}
              memberId={memberId}
              disabled={disabled}
              onInsert={(token) => {
                const textarea = document.getElementById(`skill-instructions-${skill.id}`)
                const start =
                  textarea instanceof HTMLTextAreaElement
                    ? textarea.selectionStart
                    : skill.instructions.length
                const end = textarea instanceof HTMLTextAreaElement ? textarea.selectionEnd : start
                update(
                  skill.id,
                  'instructions',
                  skill.instructions.slice(0, start) + token + skill.instructions.slice(end),
                )
                requestAnimationFrame(() => {
                  if (textarea instanceof HTMLTextAreaElement) {
                    textarea.focus()
                    textarea.setSelectionRange(start + token.length, start + token.length)
                  }
                })
              }}
            />
          </li>
        ))}
      </ol>
    </section>
  )
}
