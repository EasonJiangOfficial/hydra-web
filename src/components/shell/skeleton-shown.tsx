"use client";

import { useLayoutEffect, useRef } from "react";

/**
 * Put inside a route skeleton root (data-route-loading). Once the skeleton has shown, it marks the (app) template
 * (the root's parent) `data-skeleton-shown`, so the page that replaces the skeleton skips the layout's fade and
 * simply takes its place, as UGM's pages do. The template remounts on the next navigation, which clears the mark.
 */
export function SkeletonShown() {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    ref.current?.parentElement?.parentElement?.setAttribute("data-skeleton-shown", "");
  }, []);
  return <span ref={ref} hidden />;
}
