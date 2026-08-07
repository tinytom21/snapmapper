/**
 * The sidebar's sections, of which exactly one is open.
 *
 * It began as independent collapsibles, and that was the mistake. Two open sections compete for a
 * height neither can have — the photo list wants to fill the sidebar and the Camera clock is tall
 * because of the QR code — and every attempt to divide it fairly failed differently: the list
 * squeezed to eight pixels, sections painted over one another, and finally a clock panel scrolling
 * inside three centimetres, which is what "the camera clock section doesn't work" meant.
 *
 * With one section open the arithmetic disappears. Closed sections are their headers, the open one
 * takes what is left, and nothing has to be shared.
 *
 * Radio semantics, not toggles: clicking the open section does nothing rather than closing it. All
 * three shut would be a sidebar showing nothing at all, which is not a state worth being able to
 * reach by accident.
 */

import type { ReactNode } from 'react';

export interface AccordionSection {
  readonly id: string;
  readonly title: string;
  /**
   * What the section would say if you opened it — the timezone and drift, the photo count.
   *
   * The point of a closed section that still answers the question somebody would open it to ask.
   */
  readonly state: string;
  readonly content: ReactNode;
}

export function Accordion({
  sections,
  open,
  onOpen,
}: {
  readonly sections: readonly AccordionSection[];
  readonly open: string;
  readonly onOpen: (id: string) => void;
}) {
  return (
    <div className="accordion">
      {sections.map((section) => {
        const isOpen = section.id === open;

        return (
          <section key={section.id} className={`section${isOpen ? ' open' : ''}`}>
            <h2>
              <button
                type="button"
                className="section-summary"
                aria-expanded={isOpen}
                onClick={() => onOpen(section.id)}
              >
                <span className="section-title">{section.title}</span>
                <span className="state">{section.state}</span>
                <span className="chevron" aria-hidden="true" />
              </button>
            </h2>

            {/* Unmounted rather than hidden: a closed section holds a QR code being redrawn four
                times a second, and there is no reason to pay for it while nobody can see it. */}
            {isOpen && <div className="section-body">{section.content}</div>}
          </section>
        );
      })}
    </div>
  );
}
