/**
 * The actions that do not fit on a phone, behind one button that looks like it holds something.
 *
 * What was here before was a horizontally scrolling row, and the user's verdict was exact: *"you
 * wouldn't know to scroll it if you hadn't told me."* That is the whole problem with overflow by
 * scrolling — the affordance is the scrollbar, and phones do not draw one until you are already
 * dragging. Whatever sat past the right edge may as well not have existed.
 *
 * So the row is gone. Undo and Redo stay visible, because a mis-tap on a map wants undoing in one
 * touch, and everything else lives in here.
 */

import { useEffect, useRef, type ReactNode } from 'react';

export function ActionMenu({
  open,
  onOpen,
  onClose,
  children,
}: {
  readonly open: boolean;
  readonly onOpen: () => void;
  readonly onClose: () => void;
  /** Buttons. Clicking any of them closes the menu — see the click handler below. */
  readonly children: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);

  // Escape and a tap anywhere else close it. Both are what a menu is expected to do, and a menu
  // that can only be dismissed by its own button feels stuck.
  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    function onPointerDown(event: PointerEvent) {
      if (!container.current?.contains(event.target as Node)) onClose();
    }

    window.addEventListener('keydown', onKeyDown);
    // Capture, so it runs before a button inside the page swallows the event.
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open, onClose]);

  return (
    <div className="action-menu" ref={container}>
      <button
        type="button"
        className="action-menu-toggle"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => (open ? onClose() : onOpen())}
      >
        More <span aria-hidden="true">▾</span>
      </button>

      {open && (
        // One handler on the container rather than wrapping every child: any action taken from a
        // menu should close it, and threading an onClose through each caller would be a way to
        // forget one.
        <div className="action-menu-panel" role="menu" onClick={onClose}>
          {children}
        </div>
      )}
    </div>
  );
}
