"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { safeNext } from "@/lib/auth/gate";
import { finishSignIn } from "@/lib/auth/session";
import { createBrowserClient } from "@/lib/supabase/client";
import { HydraLoader } from "@/components/kit/hydra-loader";
import { InlineScript } from "@/components/shell/nav";
import { ErrorText, Field, FilledButton, PlainButton } from "./controls";
import { Lockup } from "./lockup";

type Step = "start" | "email" | "sent" | "finishing" | "add-passkey";

function client() {
  try {
    return createBrowserClient();
  } catch {
    return null;
  }
}

/** Full navigation so the proxy sees the fresh session cookie. `next` stays same-origin. */
function goNext() {
  window.location.assign(safeNext(new URLSearchParams(window.location.search).get("next")));
}

const noop = () => () => {};
/**
 * True inside Hydra Desktop (its window adds `window.hydraDesktop` before the page runs). Its web view has no
 * passkeys (the app is not signed with an Apple Developer ID), so it signs in by email code only.
 */
function useInDesktop() {
  return useSyncExternalStore(noop, () => "hydraDesktop" in window, () => false);
}

/** Marks the login column inside Hydra Desktop while the HTML parses, so the passkey button never paints there. */
const DESKTOP_FLAG = `if("hydraDesktop" in window)document.currentScript.parentElement.setAttribute("data-desktop","")`;

/** The code a sent email holds, kept for its lifetime (otp_expiry in supabase/config.toml), so a reload keeps it. */
const SENT_KEY = "hydra:code-sent";
const CODE_TTL_MS = 10 * 60_000;

function readSent(): string | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SENT_KEY) ?? "null") as { email: string; at: number } | null;
    return saved && Date.now() - saved.at < CODE_TTL_MS ? saved.email : null;
  } catch {
    return null;
  }
}

function writeSent(email: string | null) {
  try {
    if (email) sessionStorage.setItem(SENT_KEY, JSON.stringify({ email, at: Date.now() }));
    else sessionStorage.removeItem(SENT_KEY);
  } catch {
    /* private mode: a reload asks for a new code */
  }
}

/**
 * Sign-in is a passkey or a 6-digit email code. The email holds only the code: a link works only in the browser
 * that asked for it (PKCE), and opening it elsewhere (Mail opens the default browser, link scanners prefetch) used
 * the code up. `?step=passkey` and `?error=link` still serve links from emails sent before the change.
 */
export function LoginForm() {
  const inDesktop = useInDesktop();
  return (
    <div className="contents" data-desktop={inDesktop ? "" : undefined} suppressHydrationWarning>
      <InlineScript html={DESKTOP_FLAG} />
      <Suspense fallback={<StartShell />}>
        <Form />
      </Suspense>
    </div>
  );
}

/** Passkey first on the web; inside Hydra Desktop (no passkeys there) one filled "Email me a code". CSS picks. */
function StartButtons({ onPasskey, onEmail, busy }: { onPasskey?: () => void; onEmail?: () => void; busy?: boolean }) {
  return (
    <>
      <div className="contents in-data-desktop:hidden">
        <FilledButton type="button" onClick={onPasskey} disabled={busy}>
          Sign in with passkey
        </FilledButton>
        <PlainButton type="button" onClick={onEmail} disabled={busy}>
          Email me a code
        </PlainButton>
      </div>
      <div className="hidden w-full in-data-desktop:contents">
        <FilledButton type="button" onClick={onEmail} disabled={busy}>
          Email me a code
        </FilledButton>
      </div>
    </>
  );
}

/** Same column, same height as the start step, so the lockup does not move when the form hydrates. */
function StartShell() {
  return (
    <div className="flex w-full max-w-[280px] flex-col items-center">
      <Lockup className="mb-10" />
      <div className="flex w-full flex-col items-center gap-3">
        <StartButtons />
        <ErrorText>{null}</ErrorText>
      </div>
    </div>
  );
}

function Form() {
  const params = useSearchParams();
  const fromLink = params.get("step") === "passkey";
  const [step, setStep] = useState<Step>(fromLink ? "finishing" : "start");
  const inDesktop = useInDesktop();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(params.get("error") === "link" ? "Link failed." : null);
  const [busy, setBusy] = useState(false);
  // The first step paints over the identical static shell, so only later step changes fade in.
  const [shownStep, setShownStep] = useState(step);
  const [animate, setAnimate] = useState(false);
  if (step !== shownStep) {
    setShownStep(step);
    setAnimate(true);
  }

  async function run(task: () => Promise<string | null>) {
    setBusy(true);
    setError(null);
    try {
      setError(await task());
    } catch {
      setError("Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const signInWithPasskey = () =>
    run(async () => {
      const supabase = client();
      if (!supabase) return "Not configured.";
      const { error } = await supabase.auth.signInWithPasskey();
      if (error) return "Passkey failed.";
      if ((await finishSignIn(supabase)) !== "ok") return "Not allowed.";
      goNext();
      return null;
    });

  const sendLink = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => {
      const supabase = client();
      if (!supabase) return "Not configured.";
      const { error } = await supabase.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: false } });
      // Same answer for an unknown email: do not reveal who has an account.
      if (error?.status === 429) return "Too many codes. Try again later.";
      if (error && error.status !== 400 && error.status !== 422) return "Code not sent.";
      writeSent(email.trim());
      setCode("");
      setStep("sent");
      return null;
    });
  };

  const signInWithCode = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => {
      const supabase = client();
      if (!supabase) return "Not configured.";
      const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email" });
      if (error) return error.status === 429 ? "Too many tries. Try again later." : "Code failed.";
      writeSent(null);
      if ((await finishSignIn(supabase)) !== "ok") return "Not allowed.";
      // Hydra Desktop cannot add a passkey, so it goes straight on.
      const desktop = "hydraDesktop" in window;
      const { data: passkeys } = desktop ? { data: null } : await supabase.auth.passkey.list();
      if (desktop || (passkeys && passkeys.length > 0)) goNext();
      else setStep("add-passkey");
      return null;
    });
  };

  // Back from the email link with a fresh session: finish the sign-in (owner check, time zone,
  // idle-lock reset), then offer a passkey if the owner has none.
  useEffect(() => {
    if (!fromLink) return;
    let live = true;
    (async () => {
      const supabase = client();
      if (!supabase || (await finishSignIn(supabase)) !== "ok") {
        if (live) {
          setError("Not allowed.");
          setStep("start");
        }
        return;
      }
      // Hydra Desktop cannot add a passkey, so it goes straight on.
      if ("hydraDesktop" in window) return goNext();
      const { data: passkeys } = await supabase.auth.passkey.list();
      if (passkeys && passkeys.length > 0) goNext();
      else if (live) setStep("add-passkey");
    })().catch(() => {
      if (live) {
        setError("Something went wrong.");
        setStep("start");
      }
    });
    return () => {
      live = false;
    };
  }, [fromLink]);

  const addPasskey = () =>
    run(async () => {
      const supabase = client();
      if (!supabase) return "Not configured.";
      const { error } = await supabase.auth.registerPasskey();
      if (error) return "Passkey not added.";
      goNext();
      return null;
    });

  const toStart = () => {
    writeSent(null);
    setError(null);
    setStep("start");
  };

  // A code still on its way (after a reload, say) goes straight back to the code box: sends are rate-limited.
  const toEmail = () => {
    setError(null);
    const saved = readSent();
    if (saved) setEmail(saved);
    setStep(saved ? "sent" : "email");
  };

  return (
    <div className="flex w-full max-w-[280px] flex-col items-center">
      <Lockup className="mb-10" />
      <div key={step} className={`flex w-full flex-col items-center gap-3 ${animate ? "animate-hy-fade" : ""}`}>
        {step === "start" && <StartButtons onPasskey={signInWithPasskey} onEmail={toEmail} busy={busy} />}

        {step === "email" && (
          <form onSubmit={sendLink} className="flex w-full flex-col items-center gap-3">
            <Field
              type="email"
              name="email"
              aria-label="Email"
              placeholder="Email"
              autoComplete="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <FilledButton type="submit" disabled={busy}>
              Send code
            </FilledButton>
            <PlainButton type="button" onClick={toStart} disabled={busy}>
              {inDesktop ? "Back" : "Use a passkey"}
            </PlainButton>
          </form>
        )}

        {step === "sent" && (
          <form onSubmit={signInWithCode} className="flex w-full flex-col items-center gap-3">
            <p role="status" className="text-label text-ink-2">
              Check your email
            </p>
            <Field
              type="text"
              name="code"
              aria-label="Code"
              placeholder="6-digit code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              required
              autoFocus
              value={code}
              // No maxLength: it would cut a pasted "123 456" before the spaces are dropped.
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className="text-center tracking-[0.3em]"
            />
            <FilledButton type="submit" disabled={busy}>
              Sign in
            </FilledButton>
            <PlainButton type="button" onClick={toStart} disabled={busy}>
              {inDesktop ? "Back" : "Use a passkey"}
            </PlainButton>
          </form>
        )}

        {step === "finishing" && (
          // Same height as the two buttons, so the lockup stays put when the next step fades in.
          <div className="flex h-20 items-center justify-center">
            <HydraLoader size={48} label="Signing in" />
          </div>
        )}

        {step === "add-passkey" && (
          <>
            <FilledButton type="button" onClick={addPasskey} disabled={busy}>
              Add a passkey
            </FilledButton>
            <PlainButton type="button" onClick={goNext} disabled={busy}>
              Not now
            </PlainButton>
          </>
        )}

        <ErrorText>{error}</ErrorText>
      </div>
    </div>
  );
}
