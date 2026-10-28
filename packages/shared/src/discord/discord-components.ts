/**
 * Buttons and select menus on Embed Creator messages (Discord's message components). Up to 5 rows per message; a row
 * holds up to 5 buttons, or one select menu. Link buttons open a URL; other buttons, and each option of a select menu,
 * run actions when someone uses them: add, remove or toggle a role, Verify (the join gate's checks, then a role), and a
 * private reply. CONDUIT's bot carries them out (it needs Manage Roles, with its role above the roles it gives).
 */
import { z } from 'zod';

export const COMPONENT_LIMITS = { rows: 5, buttonsPerRow: 5, options: 25, label: 80, optionLabel: 100, description: 100, placeholder: 150, actions: 5, reply: 2000 } as const;

export const BUTTON_STYLES = ['primary', 'secondary', 'success', 'danger', 'link'] as const;
export type ButtonStyle = (typeof BUTTON_STYLES)[number];
export const BUTTON_STYLE_LABEL: Record<ButtonStyle, string> = { primary: 'Blue', secondary: 'Grey', success: 'Green', danger: 'Red', link: 'Link' };
/** Discord's button style numbers. */
export const BUTTON_STYLE_CODE: Record<ButtonStyle, number> = { primary: 1, secondary: 2, success: 3, danger: 4, link: 5 };

export const COMPONENT_ACTIONS = ['add_role', 'remove_role', 'toggle_role', 'verify', 'reply'] as const;
export type ComponentActionType = (typeof COMPONENT_ACTIONS)[number];
export const COMPONENT_ACTION_LABEL: Record<ComponentActionType, string> = {
  add_role: 'Add a role',
  remove_role: 'Remove a role',
  toggle_role: 'Toggle a role',
  verify: 'Verify (join gate checks, then a role)',
  reply: 'Reply privately',
};

const snowflake = z.string().regex(/^\d{1,25}$/, 'Choose a role');
/** Short ids CONDUIT gives each button, menu and option (they go into Discord's custom_id). */
const key = z.string().regex(/^[a-z0-9]{1,12}$/, 'Invalid id');
/** A Unicode emoji, or a server emoji as <:name:id> / <a:name:id>. */
const emoji = z
  .string()
  .trim()
  .max(64, 'At most 64 characters')
  .refine((s) => s === '' || /^<a?:\w{2,32}:\d{1,25}>$/.test(s) || !/[\s<>]/.test(s), 'Use an emoji, or a server emoji like <:name:id>')
  .default('');

export const componentActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('add_role'), roleId: snowflake }),
  z.strictObject({ type: z.literal('remove_role'), roleId: snowflake }),
  z.strictObject({ type: z.literal('toggle_role'), roleId: snowflake }),
  z.strictObject({ type: z.literal('verify'), roleId: snowflake }),
  z.strictObject({ type: z.literal('reply'), content: z.string().trim().min(1, 'Write the reply').max(COMPONENT_LIMITS.reply, `At most ${COMPONENT_LIMITS.reply} characters`) }),
]);
export type ComponentAction = z.output<typeof componentActionSchema>;
const actions = z.array(componentActionSchema).max(COMPONENT_LIMITS.actions, `At most ${COMPONENT_LIMITS.actions} actions`).default([]);

export const buttonSchema = z
  .strictObject({
    id: key,
    kind: z.literal('button'),
    style: z.enum(BUTTON_STYLES),
    label: z.string().trim().max(COMPONENT_LIMITS.label, `Button labels: at most ${COMPONENT_LIMITS.label} characters`).default(''),
    emoji,
    url: z.string().trim().max(512).default(''),
    disabled: z.boolean().default(false),
    actions,
  })
  .superRefine((b, ctx) => {
    if (!b.label && !b.emoji) ctx.addIssue({ code: 'custom', path: ['label'], message: 'A button needs a label or an emoji' });
    if (b.style === 'link') {
      if (!/^https?:\/\/\S+$/i.test(b.url)) ctx.addIssue({ code: 'custom', path: ['url'], message: 'A link button needs an http(s) link' });
    } else if (b.actions.length === 0 && !b.disabled) ctx.addIssue({ code: 'custom', path: ['actions'], message: `“${b.label || 'Button'}” does nothing yet: add an action` });
  });
export type ComponentButton = z.output<typeof buttonSchema>;

export const selectOptionSchema = z.strictObject({
  id: key,
  label: z.string().trim().min(1, 'Each option needs a label').max(COMPONENT_LIMITS.optionLabel, `Option labels: at most ${COMPONENT_LIMITS.optionLabel} characters`),
  description: z.string().trim().max(COMPONENT_LIMITS.description, `Option descriptions: at most ${COMPONENT_LIMITS.description} characters`).default(''),
  emoji,
  actions,
});
export type ComponentSelectOption = z.output<typeof selectOptionSchema>;

export const selectSchema = z
  .strictObject({
    id: key,
    kind: z.literal('select'),
    placeholder: z.string().trim().max(COMPONENT_LIMITS.placeholder, `At most ${COMPONENT_LIMITS.placeholder} characters`).default(''),
    minValues: z.number().int().min(0).max(25).default(1),
    maxValues: z.number().int().min(1).max(25).default(1),
    disabled: z.boolean().default(false),
    options: z.array(selectOptionSchema).min(1, 'A menu needs at least one option').max(COMPONENT_LIMITS.options, `At most ${COMPONENT_LIMITS.options} options`),
  })
  .superRefine((s, ctx) => {
    if (s.minValues > s.maxValues) ctx.addIssue({ code: 'custom', path: ['minValues'], message: 'The minimum can’t be more than the maximum' });
    if (s.maxValues > s.options.length) ctx.addIssue({ code: 'custom', path: ['maxValues'], message: 'The maximum can’t be more than the number of options' });
    if (s.options.every((o) => o.actions.length === 0) && !s.disabled) ctx.addIssue({ code: 'custom', path: ['options'], message: 'The menu does nothing yet: give its options actions' });
  });
export type ComponentSelect = z.output<typeof selectSchema>;

export const componentRowSchema = z
  .strictObject({ components: z.array(z.union([buttonSchema, selectSchema])).min(1, 'A row needs a button or a menu').max(COMPONENT_LIMITS.buttonsPerRow, `At most ${COMPONENT_LIMITS.buttonsPerRow} buttons per row`) })
  .refine((r) => !r.components.some((c) => c.kind === 'select') || r.components.length === 1, 'A select menu takes a whole row');
export type ComponentRow = z.output<typeof componentRowSchema>;

export const componentRowsSchema = z
  .array(componentRowSchema)
  .max(COMPONENT_LIMITS.rows, `At most ${COMPONENT_LIMITS.rows} rows`)
  .default([])
  .superRefine((rows, ctx) => {
    const ids = rows.flatMap((r) => r.components.flatMap((c) => [c.id, ...(c.kind === 'select' ? c.options.map((o) => `${c.id}.${o.id}`) : [])]));
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Two buttons or options have the same id' });
  });

/** A new short id, unique among the ones given. */
export function newComponentId(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = used.size + 1; ; n++) {
    const id = n.toString(36);
    if (!used.has(id)) return id;
  }
}

/** Every id already used in these rows (buttons, menus). */
export function componentIds(rows: readonly ComponentRow[]): string[] {
  return rows.flatMap((r) => r.components.map((c) => c.id));
}

// ── Discord's JSON ───────────────────────────────────────────────────────────

const toEmoji = (e: string): Record<string, unknown> | undefined => {
  if (!e) return undefined;
  const custom = /^<(a?):(\w{2,32}):(\d{1,25})>$/.exec(e);
  return custom ? { id: custom[3], name: custom[2], ...(custom[1] ? { animated: true } : {}) } : { name: e };
};
const fromEmoji = (v: unknown): string => {
  const e = v && typeof v === 'object' ? (v as { id?: unknown; name?: unknown; animated?: unknown }) : null;
  if (!e || typeof e.name !== 'string') return '';
  return typeof e.id === 'string' ? `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` : e.name;
};

/**
 * Rows as Discord's component JSON. With customId, interactive parts get the custom_id CONDUIT's bot answers to (when
 * sending); without, they carry CONDUIT's "actions" instead (the JSON editor), so nothing is lost.
 */
export function componentsToJson(rows: readonly ComponentRow[], customId?: (componentId: string) => string): Array<Record<string, unknown>> {
  return rows.map((r) => ({
    type: 1,
    components: r.components.map((c) => {
      if (c.kind === 'button') {
        return {
          type: 2,
          style: BUTTON_STYLE_CODE[c.style],
          ...(c.label ? { label: c.label } : {}),
          ...(toEmoji(c.emoji) ? { emoji: toEmoji(c.emoji) } : {}),
          ...(c.style === 'link' ? { url: c.url, ...(customId ? {} : { id: c.id }) } : customId ? { custom_id: customId(c.id) } : { id: c.id, actions: c.actions }),
          ...(c.disabled ? { disabled: true } : {}),
        };
      }
      return {
        type: 3,
        ...(customId ? { custom_id: customId(c.id) } : { id: c.id }),
        ...(c.placeholder ? { placeholder: c.placeholder } : {}),
        min_values: c.minValues,
        max_values: c.maxValues,
        ...(c.disabled ? { disabled: true } : {}),
        options: c.options.map((o) => ({
          label: o.label,
          value: o.id,
          ...(o.description ? { description: o.description } : {}),
          ...(toEmoji(o.emoji) ? { emoji: toEmoji(o.emoji) } : {}),
          ...(customId ? {} : { actions: o.actions }),
        })),
      };
    }),
  }));
}

const STYLE_BY_CODE = new Map<number, ButtonStyle>(BUTTON_STYLES.map((s) => [BUTTON_STYLE_CODE[s], s]));

/**
 * Discord's component JSON → rows. CONDUIT's "actions" are kept; buttons and menus from elsewhere arrive without
 * actions (a note says to choose what they do); kinds CONDUIT doesn't offer are left out with a note.
 */
export function componentsFromJson(raw: unknown, notes: string[] = []): ComponentRow[] {
  if (!Array.isArray(raw)) return [];
  const taken: string[] = [];
  const idFor = (v: unknown) => {
    const id = typeof v === 'string' && /^[a-z0-9]{1,12}$/.test(v) && !taken.includes(v) ? v : newComponentId(taken);
    taken.push(id);
    return id;
  };
  let withoutActions = 0;
  let skipped = 0;
  const actionsOf = (v: unknown): ComponentAction[] => {
    const parsed = z.array(componentActionSchema).safeParse(v);
    return parsed.success ? parsed.data : [];
  };
  const rows: ComponentRow[] = [];
  for (const row of raw.slice(0, COMPONENT_LIMITS.rows)) {
    const list = row && typeof row === 'object' && Array.isArray((row as { components?: unknown }).components) ? (row as { components: unknown[] }).components : [];
    const components: ComponentRow['components'] = [];
    for (const item of list) {
      const c = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
      if (c.type === 2 && typeof c.style === 'number' && STYLE_BY_CODE.has(c.style)) {
        const style = STYLE_BY_CODE.get(c.style)!;
        const act = style === 'link' ? [] : actionsOf(c.actions);
        if (style !== 'link' && act.length === 0) withoutActions++;
        components.push({ id: idFor(c.id), kind: 'button', style, label: typeof c.label === 'string' ? c.label : '', emoji: fromEmoji(c.emoji), url: typeof c.url === 'string' ? c.url : '', disabled: c.disabled === true, actions: act });
      } else if (c.type === 3 && Array.isArray(c.options)) {
        const optionIds: string[] = [];
        const options = c.options.slice(0, COMPONENT_LIMITS.options).map((o: Record<string, unknown>) => {
          const id = typeof o?.value === 'string' && /^[a-z0-9]{1,12}$/.test(o.value) && !optionIds.includes(o.value) ? o.value : newComponentId(optionIds);
          optionIds.push(id);
          const act = actionsOf(o?.actions);
          return { id, label: typeof o?.label === 'string' ? o.label : '', description: typeof o?.description === 'string' ? o.description : '', emoji: fromEmoji(o?.emoji), actions: act };
        });
        if (options.every((o: ComponentSelectOption) => o.actions.length === 0)) withoutActions++;
        components.push({
          id: idFor(c.id),
          kind: 'select',
          placeholder: typeof c.placeholder === 'string' ? c.placeholder : '',
          minValues: typeof c.min_values === 'number' ? c.min_values : 1,
          maxValues: typeof c.max_values === 'number' ? c.max_values : 1,
          disabled: c.disabled === true,
          options,
        });
      } else skipped++;
    }
    if (components.length) rows.push({ components: components.slice(0, COMPONENT_LIMITS.buttonsPerRow) });
  }
  if (raw.length > COMPONENT_LIMITS.rows) notes.push(`Only the first ${COMPONENT_LIMITS.rows} rows of buttons were kept.`);
  if (withoutActions) notes.push('Some buttons or menus have no actions here yet: choose what they do.');
  if (skipped) notes.push('Some components CONDUIT doesn’t offer (user, role or channel menus, premium buttons…) were left out.');
  return rows;
}
