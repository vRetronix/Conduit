import type { Section } from '../../sections';

export function PlannedPage({ section }: { section: Section }) {
  return (
    <section className="card planned">
      <span className="badge badge-soon">Soon · not available yet</span>
      <h2>{section.label}</h2>
      <p>{section.summary}</p>
      <p className="muted">This section has no functionality yet: nothing is connected and no permissions are requested for it.</p>
    </section>
  );
}
