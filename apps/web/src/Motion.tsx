import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconCheck } from "./Icons";

/**
 * DesignBookmark Motion (https://designbookmark.com/motion) の設計思想に基づく
 * ゼロ依存・スプリング物理＆マイクロインタラクション集
 */

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * 1. ParallaxCard (Parallax Ticket インスパイア)
 * マウス位置に応じて 3D チルトし、表面に光沢（Specular Highlight）を追従させる。
 */
export function ParallaxCard({
  children,
  className = "",
  onClick,
  maxTilt = 4,
  as = "button",
}: {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  maxTilt?: number;
  as?: "button" | "div";
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [style, setStyle] = useState<React.CSSProperties>({});

  const handleMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (prefersReducedMotion() || e.pointerType === "touch") return;
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const px = (e.clientX - rect.left) / rect.width;
      const py = (e.clientY - rect.top) / rect.height;
      const rx = (0.5 - py) * maxTilt * 2;
      const ry = (px - 0.5) * maxTilt * 2;
      setStyle({
        transform: `perspective(900px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) translateY(-1px)`,
        "--mx": `${(px * 100).toFixed(1)}%`,
        "--my": `${(py * 100).toFixed(1)}%`,
        "--glow-opacity": "1",
      } as React.CSSProperties);
    },
    [maxTilt],
  );

  const handleLeave = useCallback(() => {
    setStyle({
      transform: "perspective(900px) rotateX(0deg) rotateY(0deg) translateY(0px)",
      "--glow-opacity": "0",
    } as React.CSSProperties);
  }, []);

  if (as === "div") {
    return (
      <div
        ref={(node) => {
          ref.current = node;
        }}
        className={`motion-parallax ${className}`}
        style={style}
        onPointerMove={handleMove}
        onPointerLeave={handleLeave}
      >
        <span className="motion-parallax-glow" aria-hidden="true" />
        {children}
      </div>
    );
  }

  return (
    <button
      ref={(node) => {
        ref.current = node;
      }}
      type="button"
      className={`motion-parallax ${className}`}
      style={style}
      onClick={onClick}
      onPointerMove={handleMove}
      onPointerLeave={handleLeave}
    >
      <span className="motion-parallax-glow" aria-hidden="true" />
      {children}
    </button>
  );
}

/**
 * 2. TabPillNav / TabPillTrack (Tab Pill インスパイア)
 * アクティブな要素の背後にスプリング慣性でスライド・伸縮するピルインジケーターを描画する。
 */
export function useSlidingPill(activeKey: string, deps: unknown[] = []) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [pillStyle, setPillStyle] = useState<React.CSSProperties>({ opacity: 0 });
  const hasMeasured = useRef(false);

  const depsKey = deps.map((d) => String(d)).join("|");

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const activeEl = container.querySelector<HTMLElement>("[data-pill-active='true']");
    if (!activeEl) {
      setPillStyle({ opacity: 0 });
      return;
    }
    const next: React.CSSProperties = {
      opacity: 1,
      width: `${activeEl.offsetWidth}px`,
      height: `${activeEl.offsetHeight}px`,
      transform: `translate3d(${activeEl.offsetLeft}px, ${activeEl.offsetTop}px, 0)`,
      transition: hasMeasured.current ? undefined : "none",
    };
    hasMeasured.current = true;
    setPillStyle(next);
  }, [activeKey, depsKey]);

  useEffect(() => {
    const onResize = () => {
      const container = containerRef.current;
      if (!container) return;
      const activeEl = container.querySelector<HTMLElement>("[data-pill-active='true']");
      if (!activeEl) return;
      setPillStyle({
        opacity: 1,
        width: `${activeEl.offsetWidth}px`,
        height: `${activeEl.offsetHeight}px`,
        transform: `translate3d(${activeEl.offsetLeft}px, ${activeEl.offsetTop}px, 0)`,
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return { containerRef, pillStyle };
}

/**
 * 3. CopyButton (Copy Button + Loading to Success インスパイア)
 * クリックでアイコンが回転・スケールしながらチェックマークに変化し、一定時間後に戻る。
 */
export function CopyButton({
  text,
  label = "コピー",
  copiedLabel = "コピーしました",
  className = "",
  onCopied,
}: {
  text: string;
  label?: string;
  copiedLabel?: string;
  className?: string;
  onCopied?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  const handleClick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      onCopied?.();
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API fallback ignored
    }
  };

  return (
    <button
      type="button"
      className={`motion-copy-btn ${copied ? "is-copied" : ""} ${className}`}
      onClick={() => void handleClick()}
    >
      <span className="motion-copy-icon" aria-hidden="true">
        {copied ? (
          <IconCheck size={14} />
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </span>
      <span>{copied ? copiedLabel : label}</span>
    </button>
  );
}

/**
 * 4. HoldConfirmButton (Hold to Publish インスパイア)
 * 長押しでプログレスが充填され、完了すると確定アクションを実行する誤操作防止ボタン。
 * 途中で指を離すとスプリングで巻き戻る。
 */
export function HoldConfirmButton({
  children,
  onConfirm,
  disabled = false,
  durationMs = 650,
  className = "",
  holdHint = "長押しで確定",
}: {
  children: React.ReactNode;
  onConfirm: () => void;
  disabled?: boolean;
  durationMs?: number;
  className?: string;
  holdHint?: string;
}) {
  const [progress, setProgress] = useState(0);
  const [holding, setHolding] = useState(false);
  const [completed, setCompleted] = useState(false);
  const rafRef = useRef<number | undefined>(undefined);
  const startRef = useRef<number>(0);

  const cancelHold = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = undefined;
    setHolding(false);
    setProgress(0);
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const startHold = useCallback(() => {
    if (disabled || holding) return;
    if (prefersReducedMotion()) {
      setCompleted(true);
      onConfirm();
      window.setTimeout(() => setCompleted(false), 900);
      return;
    }
    setHolding(true);
    setCompleted(false);
    startRef.current = performance.now();

    const tick = (now: number) => {
      const elapsed = now - startRef.current;
      const ratio = Math.min(1, elapsed / durationMs);
      setProgress(ratio);
      if (ratio >= 1) {
        rafRef.current = undefined;
        setHolding(false);
        setCompleted(true);
        onConfirm();
        window.setTimeout(() => {
          setCompleted(false);
          setProgress(0);
        }, 900);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [disabled, durationMs, holding, onConfirm]);

  return (
    <button
      type="button"
      disabled={disabled}
      title={holdHint}
      className={`motion-hold-btn ${holding ? "is-holding" : ""} ${completed ? "is-completed" : ""} ${className}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        startHold();
      }}
      onPointerUp={cancelHold}
      onPointerLeave={cancelHold}
      onPointerCancel={cancelHold}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (!disabled) {
            onConfirm();
          }
        }
      }}
    >
      <span
        className="motion-hold-fill"
        style={{ transform: `scaleX(${progress})` }}
        aria-hidden="true"
      />
      <span className="motion-hold-label">
        {completed ? (
          <>
            <IconCheck size={14} /> 実行しました
          </>
        ) : holding ? (
          <>そのまま長押し…</>
        ) : (
          children
        )}
      </span>
    </button>
  );
}

/**
 * 5. MorphIslandToast (Morph Island + Goo Thinking インスパイア)
 * busy 時はコンパクトな処理中ピル、notice 時はチェックマーク付きの通知ピルへ滑らかに変形する。
 */
export function MorphIslandToast({
  busy,
  notice,
  onDismiss,
}: {
  busy: boolean;
  notice: string;
  onDismiss: () => void;
}) {
  const visible = busy || Boolean(notice);
  if (!visible) return null;

  return (
    <div
      className={`floating-toast motion-morph-island ${busy && !notice ? "is-thinking" : "is-notice"}`}
      role="status"
      aria-live="polite"
    >
      <div className="floating-toast-content">
        {busy && !notice ? (
          <>
            <span className="goo-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span>処理中…</span>
          </>
        ) : (
          <>
            <span className="toast-icon motion-pop-in">
              <IconCheck size={14} />
            </span>
            <span>{notice}</span>
          </>
        )}
      </div>
      {notice && (
        <button
          type="button"
          className="toast-close"
          onClick={onDismiss}
          title="閉じる"
        >
          ×
        </button>
      )}
    </div>
  );
}

/**
 * 6. NumberRoll (Word Roll / カウントアップ インスパイア)
 * 数値の変化をスロットのように滑らかにロール表示する。
 */
export function NumberRoll({
  value,
  format,
}: {
  value: number;
  format: (n: number) => string;
}) {
  const [display, setDisplay] = useState(value);
  const prevRef = useRef(value);

  useEffect(() => {
    const from = prevRef.current;
    const to = value;
    prevRef.current = to;
    if (from === to || prefersReducedMotion() || !Number.isFinite(from) || !Number.isFinite(to)) {
      setDisplay(to);
      return;
    }

    const duration = 380;
    const start = performance.now();
    let raf = 0;

    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // easeOutExpo
      const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      setDisplay(Math.round(from + (to - from) * eased));
      if (t < 1) {
        raf = requestAnimationFrame(step);
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return <>{format(display)}</>;
}
