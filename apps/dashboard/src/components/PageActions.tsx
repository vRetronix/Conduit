import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** The page header's action area, provided by the app shell. */
export const PageActionsSlot = createContext<HTMLElement | null>(null);

/** A page's main actions (New…, Save…), shown in the page header next to the title; in place outside the shell. */
export function PageActions({ children }: { children: ReactNode }) {
  const slot = useContext(PageActionsSlot);
  return slot ? createPortal(children, slot) : <div className="page-actions">{children}</div>;
}
