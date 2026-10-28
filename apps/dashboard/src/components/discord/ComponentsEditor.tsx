/**
 * Buttons and select menus for an Embed Creator message: up to 5 rows, each with up to 5 buttons or one select menu.
 * Link buttons open a URL; other buttons and each menu option run actions (add / remove / toggle a role, Verify, reply
 * privately), carried out by CONDUIT's bot when someone uses them.
 */
import { useEffect, useState } from 'react';
import {
  BUTTON_STYLE_LABEL,
  BUTTON_STYLES,
  COMPONENT_ACTION_LABEL,
  COMPONENT_ACTIONS,
  COMPONENT_LIMITS,
  componentIds,
  newComponentId,
  type ButtonStyle,
  type ComponentAction,
  type ComponentActionType,
  type ComponentButton,
  type ComponentRow,
  type ComponentSelect,
} from '@conduit/shared/discord/discord-components';
import type { LoyaltyRoleOptions } from '@conduit/shared/discord/loyalty';
import { api } from '../../api';
import { Button } from '../forms';

type Roles = LoyaltyRoleOptions['guilds'];

/** The bot's servers and their roles (whether the bot can give each), loaded once per editor. */
function useRoles(): Roles | null {
  const [roles, setRoles] = useState<Roles | null>(null);
  useEffect(() => {
    api<LoyaltyRoleOptions>('GET', '/api/loyalty/roles').then(
      (r) => setRoles(r.guilds),
      () => setRoles([]),
    );
  }, []);
  return roles;
}

export function ComponentsEditor({ rows, onChange }: { rows: ComponentRow[]; onChange: (rows: ComponentRow[]) => void }) {
  const roles = useRoles();
  const taken = componentIds(rows);
  const setRow = (i: number, row: ComponentRow | null) => onChange(row ? rows.map((r, j) => (j === i ? row : r)) : rows.filter((_, j) => j !== i));
  const newButton = (): ComponentButton => ({ id: newComponentId(taken), kind: 'button', style: 'primary', label: 'Button', emoji: '', url: '', disabled: false, actions: [] });
  const newSelect = (): ComponentSelect => ({
    id: newComponentId(taken),
    kind: 'select',
    placeholder: 'Choose…',
    minValues: 1,
    maxValues: 1,
    disabled: false,
    options: [{ id: '1', label: 'Option 1', description: '', emoji: '', actions: [] }],
  });
  return (
    <div className="components-editor">
      <span className="components-editor-title">Buttons &amp; Menus</span>
      {rows.length === 0 && <p className="muted small">No buttons yet. Buttons can give or take roles, verify members, or reply privately; link buttons open a website.</p>}
      {rows.map((row, ri) => {
        const select = row.components[0]?.kind === 'select';
        return (
          <div key={ri} className="component-row" role="group" aria-label={`Row ${ri + 1}`}>
            <div className="component-row-head">
              <strong className="small">Row {ri + 1}</strong>
              {!select && row.components.length < COMPONENT_LIMITS.buttonsPerRow && (
                <Button variant="ghost" className="btn btn-ghost btn-small" onClick={() => setRow(ri, { components: [...row.components, newButton()] })}>
                  + Button
                </Button>
              )}
              <Button variant="ghost" className="btn btn-ghost btn-small btn-row-delete" onClick={() => setRow(ri, null)}>
                Remove row
              </Button>
            </div>
            {row.components.map((c, ci) => {
              const put = (next: ComponentButton | ComponentSelect | null) =>
                setRow(ri, next ? { components: row.components.map((x, k) => (k === ci ? next : x)) } : row.components.length > 1 ? { components: row.components.filter((_, k) => k !== ci) } : null);
              return c.kind === 'button' ? <ButtonEditor key={c.id} b={c} roles={roles} onChange={put} /> : <SelectEditor key={c.id} m={c} roles={roles} onChange={put} />;
            })}
          </div>
        );
      })}
      {rows.length < COMPONENT_LIMITS.rows && (
        <div className="components-add">
          <Button variant="secondary" className="btn-row" onClick={() => onChange([...rows, { components: [newButton()] }])}>
            + Buttons
          </Button>
          <Button variant="secondary" className="btn-row" onClick={() => onChange([...rows, { components: [newSelect()] }])}>
            + Select Menu
          </Button>
        </div>
      )}
    </div>
  );
}

function ButtonEditor({ b, roles, onChange }: { b: ComponentButton; roles: Roles | null; onChange: (b: ComponentButton | null) => void }) {
  const set = (patch: Partial<ComponentButton>) => onChange({ ...b, ...patch });
  return (
    <div className="component-item">
      <div className="component-fields">
        <label className="field">
          <span className="field-label">Style</span>
          <select value={b.style} onChange={(e) => set({ style: e.target.value as ButtonStyle, ...(e.target.value === 'link' ? { actions: [] } : { url: '' }) })}>
            {BUTTON_STYLES.map((st) => (
              <option key={st} value={st}>
                {BUTTON_STYLE_LABEL[st]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Label</span>
          <input value={b.label} maxLength={COMPONENT_LIMITS.label} onChange={(e) => set({ label: e.target.value })} />
        </label>
        <label className="field field-narrow">
          <span className="field-label">Emoji</span>
          <input value={b.emoji} placeholder="✅ or <:name:id>" onChange={(e) => set({ emoji: e.target.value })} />
        </label>
        {b.style === 'link' && (
          <label className="field">
            <span className="field-label">Link</span>
            <input value={b.url} placeholder="https://…" onChange={(e) => set({ url: e.target.value })} />
          </label>
        )}
        <label className="inline-check small">
          <input type="checkbox" checked={b.disabled} onChange={(e) => set({ disabled: e.target.checked })} /> Disabled
        </label>
        <Button variant="ghost" className="btn btn-ghost btn-small btn-row-delete" aria-label={`Remove button ${b.label || b.id}`} onClick={() => onChange(null)}>
          ✕
        </Button>
      </div>
      {b.style !== 'link' && <ActionsEditor actions={b.actions} roles={roles} onChange={(actions) => set({ actions })} what="When clicked" />}
    </div>
  );
}

function SelectEditor({ m, roles, onChange }: { m: ComponentSelect; roles: Roles | null; onChange: (m: ComponentSelect | null) => void }) {
  const set = (patch: Partial<ComponentSelect>) => onChange({ ...m, ...patch });
  const optionIds = m.options.map((o) => o.id);
  return (
    <div className="component-item">
      <div className="component-fields">
        <label className="field">
          <span className="field-label">Menu placeholder</span>
          <input value={m.placeholder} maxLength={COMPONENT_LIMITS.placeholder} onChange={(e) => set({ placeholder: e.target.value })} />
        </label>
        <label className="field field-narrow">
          <span className="field-label">Pick at least</span>
          <input type="number" min={0} max={25} value={m.minValues} onChange={(e) => set({ minValues: Number(e.target.value) })} />
        </label>
        <label className="field field-narrow">
          <span className="field-label">At most</span>
          <input type="number" min={1} max={25} value={m.maxValues} onChange={(e) => set({ maxValues: Number(e.target.value) })} />
        </label>
        <label className="inline-check small">
          <input type="checkbox" checked={m.disabled} onChange={(e) => set({ disabled: e.target.checked })} /> Disabled
        </label>
        <Button variant="ghost" className="btn btn-ghost btn-small btn-row-delete" aria-label="Remove menu" onClick={() => onChange(null)}>
          ✕
        </Button>
      </div>
      {m.options.map((o, oi) => {
        const setOption = (patch: Partial<(typeof m.options)[number]>) => set({ options: m.options.map((x, k) => (k === oi ? { ...x, ...patch } : x)) });
        return (
          <div key={o.id} className="component-option">
            <div className="component-fields">
              <label className="field">
                <span className="field-label">Option {oi + 1}</span>
                <input value={o.label} maxLength={COMPONENT_LIMITS.optionLabel} onChange={(e) => setOption({ label: e.target.value })} />
              </label>
              <label className="field">
                <span className="field-label">Description</span>
                <input value={o.description} maxLength={COMPONENT_LIMITS.description} onChange={(e) => setOption({ description: e.target.value })} />
              </label>
              <label className="field field-narrow">
                <span className="field-label">Emoji</span>
                <input value={o.emoji} onChange={(e) => setOption({ emoji: e.target.value })} />
              </label>
              {m.options.length > 1 && (
                <Button variant="ghost" className="btn btn-ghost btn-small btn-row-delete" aria-label={`Remove option ${oi + 1}`} onClick={() => set({ options: m.options.filter((_, k) => k !== oi) })}>
                  ✕
                </Button>
              )}
            </div>
            <ActionsEditor actions={o.actions} roles={roles} onChange={(actions) => setOption({ actions })} what="When chosen" />
          </div>
        );
      })}
      {m.options.length < COMPONENT_LIMITS.options && (
        <Button
          variant="ghost"
          className="btn btn-ghost btn-small"
          onClick={() => set({ options: [...m.options, { id: newComponentId(optionIds), label: `Option ${m.options.length + 1}`, description: '', emoji: '', actions: [] }] })}
        >
          + Option
        </Button>
      )}
    </div>
  );
}

const ROLE_ACTIONS: readonly ComponentActionType[] = ['add_role', 'remove_role', 'toggle_role', 'verify'];

function ActionsEditor({ actions, roles, onChange, what }: { actions: ComponentAction[]; roles: Roles | null; onChange: (a: ComponentAction[]) => void; what: string }) {
  const change = (i: number, next: ComponentAction | null) => onChange(next ? actions.map((a, k) => (k === i ? next : a)) : actions.filter((_, k) => k !== i));
  const firstRole = roles?.flatMap((g) => g.roles).find((r) => r.assignable)?.id ?? '';
  return (
    <div className="component-actions">
      <span className="field-label">{what}</span>
      {actions.length === 0 && <span className="muted small">Nothing yet.</span>}
      {actions.map((a, i) => (
        <div key={i} className="editor-row">
          <select
            aria-label={`Action ${i + 1}`}
            value={a.type}
            onChange={(e) => {
              const type = e.target.value as ComponentActionType;
              change(i, type === 'reply' ? { type, content: a.type === 'reply' ? a.content : '' } : { type, roleId: a.type !== 'reply' ? a.roleId : firstRole });
            }}
          >
            {COMPONENT_ACTIONS.map((t) => (
              <option key={t} value={t}>
                {COMPONENT_ACTION_LABEL[t]}
              </option>
            ))}
          </select>
          {a.type === 'reply' ? (
            <input className="grow" aria-label={`Action ${i + 1} reply`} placeholder="Only they see this reply" value={a.content} maxLength={COMPONENT_LIMITS.reply} onChange={(e) => change(i, { type: 'reply', content: e.target.value })} />
          ) : (
            <select aria-label={`Action ${i + 1} role`} value={a.roleId} onChange={(e) => change(i, { ...a, roleId: e.target.value })}>
              <option value="">{roles === null ? 'Loading roles…' : 'Choose a role…'}</option>
              {roles?.map((g) => (
                <optgroup key={g.id} label={g.name}>
                  {g.roles.map((r) => (
                    <option key={r.id} value={r.id} disabled={!r.assignable}>
                      @{r.name}
                      {r.problem ? ` — ${r.problem}` : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
              {a.roleId && roles && !roles.some((g) => g.roles.some((r) => r.id === a.roleId)) && <option value={a.roleId}>A role that no longer exists</option>}
            </select>
          )}
          <Button variant="ghost" className="btn btn-ghost btn-small btn-row-delete" aria-label={`Remove action ${i + 1}`} onClick={() => change(i, null)}>
            ✕
          </Button>
        </div>
      ))}
      {actions.length < COMPONENT_LIMITS.actions && (
        <Button
          variant="ghost"
          className="btn btn-ghost btn-small"
          onClick={() => onChange([...actions, actions.some((x) => ROLE_ACTIONS.includes(x.type)) ? { type: 'reply', content: '' } : { type: 'add_role', roleId: firstRole }])}
        >
          + Action
        </Button>
      )}
    </div>
  );
}
