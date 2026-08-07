/**
 * A section that can be shut, saying enough while shut to be worth leaving shut.
 *
 * The summary carries the current state — the timezone and drift, say — so that a closed panel
 * still answers the question somebody would open it to ask. A panel that has to be opened just to
 * check something is worse than one that never collapsed.
 */

import type { ReactNode } from 'react';

export function Collapsible({
  title,
  state,
  defaultOpen,
  children,
}: {
  readonly title: string;
  readonly state: string;
  readonly defaultOpen: boolean;
  readonly children: ReactNode;
}) {
  return (
    <details className="panel-collapse" open={defaultOpen}>
      <summary>
        <span className="panel-title">{title}</span>
        <span className="state">{state}</span>
      </summary>
      {children}
    </details>
  );
}
