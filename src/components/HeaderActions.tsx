import { useEffect, useRef, useState } from "react";
import { ResetIcon, ShareIcon } from "./ActionIcons";

const SHARE_FEEDBACK_MS = 2000;
const SHARE_TITLE = "coil3d";

type ShareStatus = "idle" | "copied" | "failed";
type FocusTarget = "share" | "reset";

const SHARE_LABELS: Record<ShareStatus, string> = {
  idle: "Share",
  copied: "Copied",
  failed: "Couldn't copy",
};

const SHARE_ANNOUNCEMENTS: Record<ShareStatus, string> = {
  idle: "",
  copied: "Link copied to the clipboard",
  failed: "Couldn't copy the link",
};

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function useShare() {
  const [status, setStatus] = useState<ShareStatus>("idle");

  useEffect(() => {
    if (status === "idle") return;
    const timer = window.setTimeout(() => setStatus("idle"), SHARE_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [status]);

  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  };

  const share = async () => {
    const url = window.location.href;
    if (!navigator.share) {
      await copyLink(url);
      return;
    }
    try {
      await navigator.share({ title: SHARE_TITLE, url });
    } catch (error) {
      if (!isAbort(error)) await copyLink(url);
    }
  };

  return { status, share };
}

export function HeaderActions({ canReset, onReset }: { canReset: boolean; onReset: () => void }) {
  const { status, share } = useShare();
  const [confirming, setConfirming] = useState(false);
  const groupRef = useRef<HTMLDivElement>(null);
  const shareRef = useRef<HTMLButtonElement>(null);
  const resetRef = useRef<HTMLButtonElement>(null);
  const noRef = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<FocusTarget | null>(null);
  const pressing = useRef(false);

  useEffect(() => {
    if (confirming) {
      noRef.current?.focus();
      return;
    }
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target === "share") shareRef.current?.focus();
    if (target === "reset") resetRef.current?.focus();
  }, [confirming]);

  useEffect(() => {
    if (!canReset) setConfirming(false);
  }, [canReset]);

  useEffect(() => {
    if (!confirming) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!groupRef.current?.contains(event.target as Node)) setConfirming(false);
    };
    const onPointerUp = () => {
      pressing.current = false;
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointerup", onPointerUp);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onPointerUp);
    };
  }, [confirming]);

  const cancelAndRefocus = () => {
    pendingFocus.current = "reset";
    setConfirming(false);
  };

  const confirm = () => {
    pendingFocus.current = "share";
    setConfirming(false);
    onReset();
  };

  const resetControl = confirming ? (
    <div
      ref={groupRef}
      className="reset-confirm"
      role="group"
      aria-label="Reset the design"
      data-testid="reset-confirm"
      onPointerDown={() => {
        pressing.current = true;
      }}
      onBlur={(event) => {
        if (pressing.current) return;
        if (!event.currentTarget.contains(event.relatedTarget)) setConfirming(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") cancelAndRefocus();
      }}
    >
      <span className="reset-confirm-prompt">Sure to reset?</span>
      <button type="button" className="header-btn" data-testid="reset-yes" onClick={confirm}>
        Yes
      </button>
      <button type="button" ref={noRef} className="header-btn" data-testid="reset-no" onClick={cancelAndRefocus}>
        No
      </button>
    </div>
  ) : (
    <button type="button" ref={resetRef} className="header-btn" data-testid="reset" onClick={() => setConfirming(true)}>
      <ResetIcon />
      <span>Reset</span>
    </button>
  );

  return (
    <div className="header-actions">
      {canReset && resetControl}
      {!confirming && (
        <button type="button" ref={shareRef} className="header-btn" data-testid="share" onClick={share}>
          <ShareIcon />
          <span>{SHARE_LABELS[status]}</span>
        </button>
      )}
      <span className="visually-hidden" role="status" aria-live="polite">
        {SHARE_ANNOUNCEMENTS[status]}
      </span>
    </div>
  );
}
