// Kick notifications: the "Use default layout" control.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { defaultNotificationLayout } from '@conduit/shared/kick/stream-notifications';
import { DefaultLayoutBlock } from '../pages/kick/KickNotificationsPage';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const vars = { streamer: 'StreamerName' };

describe('Use default layout', () => {
  it('a custom layout offers the default (behind a confirmation, nothing saved yet)', () => {
    const custom = { ...defaultNotificationLayout(), content: '{Streamer} is now live!' };
    const html = renderToStaticMarkup(<DefaultLayoutBlock current={custom} previewVars={vars} mention={null} onApply={() => {}} />);
    expect(text(html)).toContain('This notification uses a custom layout.');
    expect(html).toMatch(/<button[^>]*>Use default layout…<\/button>/);
    // The replacement itself only happens after "Replace with default" in the confirmation step.
    expect(html).not.toContain('Replace with default');
    expect(text(html)).toContain('is corrected when you save');
  });

  it('the default layout needs no action', () => {
    const html = renderToStaticMarkup(<DefaultLayoutBlock current={defaultNotificationLayout()} previewVars={vars} mention={null} onApply={() => {}} />);
    expect(text(html)).toContain('This notification uses the default layout.');
    expect(html).not.toContain('Use default layout…');
  });
});
