"use client";

import { History, X } from "lucide-react";
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from "motion/react";
import { Dialog } from "radix-ui";
import { useId, useRef, useState } from "react";
import { EXIT } from "@/components/kit/drawer";
import { HoverCard } from "@/components/kit/hover-card";
import { EASE } from "@/components/kit/seg";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { canUndoHere } from "./activity";
import { ActivitySheet, PANEL_ICON } from "./activity-sheet";
import { FlyingOrb, StatusWord } from "./agent-card";
import { useAgent } from "./context";
import { APPROVE_ALL_INFO } from "./controller";
import { AgentControls, Tip } from "./controls";
import { OrbMenu, OrbMenuName } from "./orb-menu";
import { AgentRuntime, Composer, Thread } from "./thread/thread";
import { usePhone } from "./thread/use-phone";

const label = "text-label font-normal text-ink-3";
/** The header orb, 48 px, at the panel's 28 px padding (plus its 1 px edge). FlyingOrb lands exactly on this spot. */
const ORB = 48;

/**
 * The expanded Hydra Agent panel, in the kit DetailDrawer's look (420 px from the right on desktop, a bottom
 * sheet on the phone). It is not URL-driven and not modal: the agent keeps navigating the page behind it.
 * Holds the thread (assistant-ui over the controller), confirm prompts, routine approvals and the typed input; the
 * activity list with undo slides over them from the header's Activity button. The orb is not inside the sliding
 * sheet: it flies in on its own (FlyingOrb), so the sheet's fade never dims it and there is only ever one orb on screen.
 */
export function AgentPanel() {
  const { ctl, state } = useAgent();
  const phone = usePhone();
  const input = useRef<HTMLTextAreaElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const activityButton = useRef<HTMLButtonElement>(null);
  const activityId = useId();
  // The menu and the activity belong to the open panel: closing the panel closes them.
  if (!state.expanded && menuOpen) setMenuOpen(false);
  if (!state.expanded && activityOpen) setActivityOpen(false);
  // Focus goes back to the Activity button on close without opening its tooltip (Radix opens one on any focus): the
  // focus event runs inside focus(), so the flag is only up for that one event.
  const quietFocus = useRef(false);
  const closeActivity = () => {
    setActivityOpen(false);
    quietFocus.current = true;
    activityButton.current?.focus();
    quietFocus.current = false;
  };
  // Reduced motion: a fade only. MotionConfig alone would snap the panel 28 px and then fade it.
  const still = useReducedMotion();
  const from = still ? { opacity: 0 } : phone ? { y: 28, opacity: 0 } : { x: 28, opacity: 0 };
  const at = phone ? { y: 0, opacity: 1 } : { x: 0, opacity: 1 };

  return (
    <AgentRuntime>
      <Dialog.Root open={state.expanded} onOpenChange={ctl.setExpanded} modal={false}>
        <AnimatePresence>
          {state.expanded && (
            <Dialog.Portal forceMount>
              <MotionConfig reducedMotion="user">
                <Dialog.Content
                  asChild
                  forceMount
                  aria-describedby={undefined}
                  data-testid="agent-panel"
                  // The page behind stays usable: Hydra is working in it.
                  onInteractOutside={(e) => e.preventDefault()}
                  // Escape closes the activity first, then the panel.
                  onEscapeKeyDown={(e) => {
                    if (!activityOpen) return;
                    e.preventDefault();
                    closeActivity();
                  }}
                  onOpenAutoFocus={(e) => {
                    e.preventDefault();
                    if (state.typedOnly) input.current?.focus();
                    else (e.currentTarget as HTMLElement | null)?.focus();
                  }}
                >
                  <motion.div
                    data-slot="agent-panel"
                    className={cn(
                      "fixed z-50 flex flex-col gap-4 bg-surface p-7 outline-none data-[state=closed]:pointer-events-none!",
                      phone
                        ? "inset-x-0 bottom-0 h-[88dvh] rounded-t-xl border-t border-rule pb-[max(20px,env(safe-area-inset-bottom))]"
                        : "inset-y-0 right-0 w-(--drawer-w) border-l border-rule",
                    )}
                    initial={from}
                    animate={{ ...at, transition: { duration: 0.28, ease: EASE } }}
                    exit={{ ...from, transition: EXIT }}
                  >
                    {/* Top-aligned to the 48 px orb. The approve-all tag's line under the status word is always kept, on or
                        off: turning it on never moves the thread. */}
                    <div className="flex items-start gap-3">
                      <Dialog.Title className="sr-only">Hydra</Dialog.Title>
                      <OrbMenu open={menuOpen} onOpenChange={setMenuOpen}>
                        <div className="flex min-w-0 flex-1 items-start gap-3">
                          {!(state.desktop && state.detached) && <div aria-hidden className="flex-none" style={{ width: ORB, height: ORB }} />}
                          <div className="flex min-w-0 flex-1 flex-col items-start">
                            <OrbMenuName>Hydra</OrbMenuName>
                            <StatusWord state={state} testId="agent-panel-status" className="max-w-full min-w-0 [&>[role=status]]:text-ink" />
                            {/* Under the status word: the header has no room beside it for the words (124 px, 80 on a
                                phone). Hover, focus or a tap shows what it means. */}
                            <div data-testid="agent-approve-all-line" className="mt-1 flex h-[18px] items-center">
                              {state.settings.approveAll && (
                                <HoverCard content={APPROVE_ALL_INFO} side="bottom" align="start" className="w-max max-w-[240px] px-2.5 py-2">
                                  <button
                                    type="button"
                                    data-testid="agent-approve-all-tag"
                                    className="relative inline-flex h-[18px] flex-none items-center rounded-lg border border-rule px-1.5 text-tag whitespace-nowrap text-ink-3 outline-none focus-visible:outline-2 focus-visible:outline-ink pointer-coarse:after:absolute pointer-coarse:after:-inset-x-1 pointer-coarse:after:-inset-y-2 pointer-coarse:after:content-['']"
                                  >
                                    Approve all
                                  </button>
                                </HoverCard>
                              )}
                            </div>
                          </div>
                        </div>
                      </OrbMenu>
                      <AgentControls className="h-12" />
                      <div className="-mr-2 flex h-12 flex-none items-center">
                        <Tip label="Activity" side="bottom">
                          <button
                            ref={activityButton}
                            type="button"
                            aria-label="Activity"
                            aria-expanded={activityOpen}
                            aria-controls={activityOpen ? activityId : undefined}
                            data-testid="agent-activity-button"
                            onClick={() => (activityOpen ? closeActivity() : setActivityOpen(true))}
                            onFocus={(e) => quietFocus.current && e.preventDefault()}
                            className={cn(PANEL_ICON, activityOpen && "bg-tint text-ink")}
                          >
                            <History aria-hidden className="size-4" strokeWidth={1.5} />
                            {/* This chat changed something that can still be undone. */}
                            {canUndoHere(state.activity, state.threadId) && (
                              <span aria-hidden data-testid="agent-activity-dot" className="absolute top-[7px] right-[7px] size-1.5 rounded-full bg-ink" />
                            )}
                          </button>
                        </Tip>
                        <Dialog.Close aria-label="Close" className={PANEL_ICON}>
                          <X aria-hidden className="size-4" strokeWidth={1.5} />
                        </Dialog.Close>
                      </div>
                    </div>

                    {/* Under the header: the thread takes the height, the composer stays at the bottom; activity slides over it. */}
                    <div className="relative flex min-h-0 flex-1 flex-col">
                      {/* Covered by the activity, it leaves the tab order and the pointer: nothing typed or approved unseen. */}
                      <div inert={activityOpen} className="flex min-h-0 flex-1 flex-col gap-4">
                      {state.approvals.length > 0 && (
                        <section aria-label="Waiting for you" data-testid="agent-approvals" className="flex flex-col gap-2">
                          <h3 className={label}>Waiting for you</h3>
                          {state.approvals.map((a) => (
                            <div key={a.id} className="flex flex-col gap-2 border-t border-rule pt-3">
                              <p className="text-body text-ink">{a.prompt}</p>
                              <div className="flex gap-2">
                                <Button size="default" onClick={() => ctl.decideApproval(a.id, true)}>
                                  Approve
                                </Button>
                                <Button variant="ghost" onClick={() => ctl.decideApproval(a.id, false)}>
                                  Decline
                                </Button>
                              </div>
                            </div>
                          ))}
                        </section>
                      )}

                      <Thread />

                      <Composer inputRef={input} />
                      </div>
                      <AnimatePresence>{activityOpen && <ActivitySheet key="activity" id={activityId} onClose={closeActivity} />}</AnimatePresence>
                    </div>
                  </motion.div>
                </Dialog.Content>
              </MotionConfig>
            </Dialog.Portal>
          )}
        </AnimatePresence>
      </Dialog.Root>
      {state.expanded && !(state.desktop && state.detached) && (
        // Detached, the orb floats on the Mac: the panel never shows a second one.
        // Outside the presence: on close it leaves at once and the card's orb flies back from this spot.
        <div
          className="pointer-events-none fixed z-[51]"
          style={
            phone
              ? { top: "calc(12dvh + 29px)", left: 28, width: ORB, height: ORB }
              : { top: 28, right: `calc(var(--drawer-w) - 29px - ${ORB}px)`, width: ORB, height: ORB }
          }
        >
          {/* In the header the orb opens Hydra's options; on the card and the phone pill it keeps its tap map. */}
          <FlyingOrb fly className="pointer-events-auto size-full" menu={{ label: "Hydra options", onTap: () => setMenuOpen((o) => !o), expanded: menuOpen }} />
        </div>
      )}
    </AgentRuntime>
  );
}
