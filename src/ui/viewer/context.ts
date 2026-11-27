import { createContext, type RefObject } from "react";

export const ViewerContext = createContext<{
  /** the viewer element: floating controls are placed in it */
  root: RefObject<HTMLDivElement | null>;
  scroller: RefObject<HTMLDivElement | null>;
}>({ root: { current: null }, scroller: { current: null } });
