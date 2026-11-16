import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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

/**
 * 7. ExpandCardList (DesignBookmark "Expand Card" 準拠)
 * 複数の行カードを並べ、クリックした1枚をスプリング物理で最上段へ引き上げつつ展開する。
 * 同じスプリング定数 (p: 240/21, a: 260/28, y: 300/26, o: 300/30, s: 300/26) を使用。
 */
export interface ExpandCardItem {
  id: string;
  title: string;
  subtitle?: React.ReactNode;
  badge?: React.ReactNode;
  expandedHeader?: React.ReactNode;
  badgeTone?: "emerald" | "amber" | "slate" | "blue";
  value?: React.ReactNode;
  summary: React.ReactNode;
  chips?: React.ReactNode[];
  action?: React.ReactNode;
}

interface SpringState {
  x: number;
  v: number;
  t: number;
  k: number;
  c: number;
}

function makeSpring(x: number, k: number, c: number, reduced: boolean): SpringState {
  return { x, v: 0, t: x, k, c: reduced ? 2 * Math.sqrt(k) : c };
}

function stepSpring(s: SpringState, dt: number): void {
  const a = -s.k * (s.x - s.t) - s.c * s.v;
  s.v += a * dt;
  s.x += s.v * dt;
}

function isSettled(s: SpringState): boolean {
  return Math.abs(s.x - s.t) < 0.001 && Math.abs(s.v) < 0.01;
}

export function ExpandCardList({
  items,
  className = "",
  emptyMessage,
}: {
  items: ExpandCardItem[];
  className?: string;
  emptyMessage?: string;
}) {
  const ROW = 72;
  const GAP = 8;
  const THUMB_EXPANDED_H = 88;
  const MORE_TOP = 166;
  const listRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const thumbRefs = useRef<(HTMLDivElement | null)[]>([]);
  const headRefs = useRef<(HTMLDivElement | null)[]>([]);
  const valRefs = useRef<(HTMLDivElement | null)[]>([]);
  const moreRefs = useRef<(HTMLDivElement | null)[]>([]);
  const openIndexRef = useRef<number>(-1);
  const [openId, setOpenId] = useState<string | null>(null);

  const springsRef = useRef<
    {
      p: SpringState;
      a: SpringState;
      y: SpringState;
      o: SpringState;
      s: SpringState;
    }[]
  >([]);
  const listHRef = useRef<SpringState | null>(null);
  const rafRef = useRef<number>(0);
  const delayTimerRef = useRef<number | null>(null);

  const closedListHeight = Math.max(0, items.length * ROW + Math.max(0, items.length - 1) * GAP);

  const ensureSprings = useCallback(() => {
    const reduced = prefersReducedMotion();
    if (springsRef.current.length !== items.length) {
      springsRef.current = items.map((_, i) => ({
        p: makeSpring(0, 240, 21, reduced),
        a: makeSpring(0, 260, 28, reduced),
        y: makeSpring(i * (ROW + GAP), 300, 26, reduced),
        o: makeSpring(1, 300, 30, reduced),
        s: makeSpring(1, 300, 26, reduced),
      }));
      listHRef.current = makeSpring(closedListHeight, 240, 21, reduced);
      openIndexRef.current = -1;
    }
  }, [items, closedListHeight]);

  const renderFrame = useCallback(() => {
    const listEl = listRef.current;
    const W = listEl ? listEl.offsetWidth : 320;
    const springs = springsRef.current;

    if (listEl && listHRef.current) {
      listEl.style.height = `${Math.max(ROW, listHRef.current.x).toFixed(2)}px`;
    }

    springs.forEach((sp, idx) => {
      const el = rowRefs.current[idx];
      const thumb = thumbRefs.current[idx];
      const head = headRefs.current[idx];
      const val = valRefs.current[idx];
      const more = moreRefs.current[idx];
      if (!el || !thumb || !head || !val || !more) return;

      const p = sp.p.x;
      const q = Math.max(0, Math.min(1, p));
      const full = MORE_TOP + more.offsetHeight + 16;

      el.style.height = `${(ROW + p * (full - ROW)).toFixed(2)}px`;
      el.style.transform = `translateY(${sp.y.x.toFixed(2)}px) scale(${sp.s.x.toFixed(4)})`;
      el.style.opacity = Math.max(0, Math.min(1, sp.o.x)).toFixed(3);
      el.style.pointerEvents = sp.o.t > 0.5 ? "auto" : "none";

      thumb.style.width = `${(48 + q * Math.max(0, W - 24 - 48)).toFixed(2)}px`;
      thumb.style.height = `${Math.max(48, 48 + p * (THUMB_EXPANDED_H - 48)).toFixed(2)}px`;
      thumb.style.borderRadius = `${(10 + q * 4).toFixed(2)}px`;

      head.style.transform = `translate(${(72 - 56 * q).toFixed(2)}px, ${(16 + 96 * p).toFixed(2)}px)`;
      val.style.transform = `translateY(${(25 + 93 * p).toFixed(2)}px)`;

      const a = Math.max(0, Math.min(1, sp.a.x));
      more.style.opacity = a.toFixed(3);
      more.style.transform = `translateY(${((1 - sp.a.x) * 10).toFixed(2)}px)`;
    });
  }, []);

  const startLoop = useCallback(() => {
    if (rafRef.current) return;
    let last = performance.now();

    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 1 / 30);
      last = now;

      const sub = 4;
      const subDt = dt / sub;
      for (let k = 0; k < sub; k++) {
        springsRef.current.forEach((sp) => {
          stepSpring(sp.p, subDt);
          stepSpring(sp.a, subDt);
          stepSpring(sp.y, subDt);
          stepSpring(sp.o, subDt);
          stepSpring(sp.s, subDt);
        });
        if (listHRef.current) {
          stepSpring(listHRef.current, subDt);
        }
      }

      renderFrame();

      const allSettled =
        springsRef.current.every(
          (sp) =>
            isSettled(sp.p) &&
            isSettled(sp.a) &&
            isSettled(sp.y) &&
            isSettled(sp.o) &&
            isSettled(sp.s),
        ) && (!listHRef.current || isSettled(listHRef.current));

      if (allSettled) {
        rafRef.current = 0;
      } else {
        rafRef.current = requestAnimationFrame(tick);
      }
    };

    rafRef.current = requestAnimationFrame(tick);
  }, [renderFrame]);

  const toggleIndex = useCallback(
    (targetIdx: number) => {
      ensureSprings();
      if (delayTimerRef.current !== null) {
        window.clearTimeout(delayTimerRef.current);
        delayTimerRef.current = null;
      }

      const nextOpen = openIndexRef.current === targetIdx ? -1 : targetIdx;
      openIndexRef.current = nextOpen;
      setOpenId(nextOpen >= 0 ? (items[nextOpen]?.id ?? null) : null);

      springsRef.current.forEach((sp, i) => {
        const home = i * (ROW + GAP);
        const el = rowRefs.current[i];
        if (nextOpen < 0) {
          sp.p.t = 0;
          sp.a.t = 0;
          sp.y.t = home;
          sp.o.t = 1;
          sp.s.t = 1;
          if (el) el.style.zIndex = "1";
          return;
        }
        if (i === nextOpen) {
          sp.p.t = 1;
          sp.y.t = 0;
          sp.o.t = 1;
          sp.s.t = 1;
          if (el) el.style.zIndex = "2";
          const delayMs = prefersReducedMotion() ? 0 : 160;
          delayTimerRef.current = window.setTimeout(() => {
            if (openIndexRef.current === nextOpen && springsRef.current[i]) {
              springsRef.current[i].a.t = 1;
              startLoop();
            }
          }, delayMs);
        } else {
          sp.a.t = 0;
          sp.p.t = 0;
          sp.o.t = 0;
          sp.s.t = 0.94;
          sp.y.t = home + (i < nextOpen ? -24 : 24);
          if (el) el.style.zIndex = "1";
        }
      });

      if (listHRef.current) {
        if (nextOpen >= 0) {
          const moreEl = moreRefs.current[nextOpen];
          const full = MORE_TOP + (moreEl ? moreEl.offsetHeight : 80) + 16;
          listHRef.current.t = Math.max(ROW + 40, full);
        } else {
          listHRef.current.t = closedListHeight;
        }
      }

      startLoop();
    },
    [ensureSprings, items, closedListHeight, startLoop],
  );

  useLayoutEffect(() => {
    ensureSprings();
    if (openIndexRef.current < 0 && listHRef.current) {
      listHRef.current.t = closedListHeight;
      listHRef.current.x = closedListHeight;
    }
    renderFrame();
  }, [ensureSprings, closedListHeight, renderFrame]);

  useEffect(() => {
    const onResize = () => renderFrame();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (delayTimerRef.current !== null) window.clearTimeout(delayTimerRef.current);
    };
  }, [renderFrame]);

  if (!items.length) {
    return emptyMessage ? <p className="muted">{emptyMessage}</p> : null;
  }

  return (
    <div
      ref={listRef}
      className={`expand-card-list ${className}`}
      style={{ height: `${closedListHeight}px` }}
    >
      {items.map((item, i) => {
        const isOpen = openId === item.id;
        return (
          <div
            key={item.id}
            ref={(node) => {
              rowRefs.current[i] = node;
            }}
            className={`expand-card-item ${isOpen ? "is-open" : ""}`}
            role="button"
            tabIndex={0}
            aria-expanded={isOpen}
            onClick={() => toggleIndex(i)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggleIndex(i);
              }
            }}
          >
            <div
              ref={(node) => {
                thumbRefs.current[i] = node;
              }}
              className={`expand-card-thumb tone-${item.badgeTone ?? "emerald"}`}
            >
              <span className="expand-card-badge-compact">{item.badge}</span>
              {item.expandedHeader && (
                <span className="expand-card-badge-expanded">{item.expandedHeader}</span>
              )}
            </div>
            <div
              ref={(node) => {
                headRefs.current[i] = node;
              }}
              className="expand-card-head"
            >
              <p className="expand-card-title">{item.title}</p>
              {item.subtitle && <p className="expand-card-sub">{item.subtitle}</p>}
            </div>
            {item.value != null && (
              <div
                ref={(node) => {
                  valRefs.current[i] = node;
                }}
                className="expand-card-value"
              >
                {item.value}
              </div>
            )}
            <div
              ref={(node) => {
                moreRefs.current[i] = node;
              }}
              className="expand-card-more"
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("button, a, input, select")) {
                  e.stopPropagation();
                }
              }}
            >
              <div className="expand-card-summary">{item.summary}</div>
              {(item.chips?.length || item.action) && (
                <div className="expand-card-footer">
                  {item.chips?.map((chip, idx) => (
                    <span key={idx} className="expand-card-chip">
                      {chip}
                    </span>
                  ))}
                  {item.action && <div className="expand-card-action">{item.action}</div>}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 6. GooMarkMenu (Goo Menu インスパイア)
 * SVG Goo フィルターとスプリング物理（tokens.css 準拠: out 230/15, in 520/34,
 * release 300/12, toast 260/17）で、液体のように弾ける手動予想印ピッカー。
 */
export function GooFilterSvg() {
  return (
    <svg width="0" height="0" style={{ position: "absolute", pointerEvents: "none" }} aria-hidden="true">
      <defs>
        <filter id="turflab-goo" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="8" result="b" />
          <feColorMatrix
            in="b"
            mode="matrix"
            values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -10"
            result="g"
          />
          <feComposite in="SourceGraphic" in2="g" operator="atop" />
        </filter>
      </defs>
    </svg>
  );
}

export interface GooMarkOption {
  mark: string;
  label: string;
  tone: string;
}

export const GOO_MARK_OPTIONS: GooMarkOption[] = [
  { mark: "◎", label: "本命", tone: "m1" },
  { mark: "○", label: "対抗", tone: "m2" },
  { mark: "▲", label: "単穴", tone: "m3" },
  { mark: "△", label: "連下", tone: "m4" },
  { mark: "☆", label: "星", tone: "m5" },
  { mark: "", label: "解除", tone: "clear" },
];

type GooSpringState = { x: number; v: number; t: number; k: number; c: number };

const gooMakeSpring = (x: number, k = 400, c = 30): GooSpringState => ({ x, v: 0, t: x, k, c });
const gooTuneSpring = (s: GooSpringState, k: number, c: number, reduce: boolean) => {
  s.k = k;
  s.c = reduce ? 2 * Math.sqrt(k) : c;
};
const gooStepSpring = (s: GooSpringState, dt: number) => {
  const a = -s.k * (s.x - s.t) - s.c * s.v;
  s.v += a * dt;
  s.x += s.v * dt;
};
const gooSpringSettled = (s: GooSpringState) =>
  Math.abs(s.x - s.t) < 0.05 && Math.abs(s.v) < 0.05;

export function GooMarkMenu({
  value,
  onChange,
  ariaLabel = "手動予想印",
  radius = 84,
}: {
  value: string;
  onChange: (next: string) => void;
  ariaLabel?: string;
  radius?: number;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const portalRef = useRef<HTMLDivElement | null>(null);
  const mainBlobRef = useRef<HTMLDivElement | null>(null);
  const mainBtnRef = useRef<HTMLButtonElement | null>(null);
  const plusRef = useRef<HTMLSpanElement | null>(null);
  const toastRef = useRef<HTMLSpanElement | null>(null);
  const bubBlobRefs = useRef<(HTMLDivElement | null)[]>([]);
  const bubBtnRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const [open, setOpen] = useState(false);
  const [portalActive, setPortalActive] = useState(false);
  const [anchorPos, setAnchorPos] = useState<{ left: number; top: number; flipDown: boolean }>({
    left: 0,
    top: 0,
    flipDown: false,
  });
  const [toastInfo, setToastInfo] = useState<GooMarkOption | null>(null);
  const openRef = useRef(false);
  const toastActiveRef = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const MS = 36;
  const BS = 36;
  const OX = 115;
  const OY = 112;

  const getHome = useCallback(
    (flipDown: boolean) =>
      [-168, -140, -112, -68, -40, -12].map((deg) => {
        const d = flipDown ? -deg : deg;
        const a = (d * Math.PI) / 180;
        return { x: Math.cos(a) * radius, y: Math.sin(a) * radius };
      }),
    [radius],
  );
  const homeRef = useRef(getHome(false));

  const simRef = useRef<{
    main: { sc: GooSpringState; w: GooSpringState; rot: GooSpringState };
    bubs: {
      x: GooSpringState;
      y: GooSpringState;
      s: GooSpringState;
      pending: { t: number; pos: { x: number; y: number }; k: number; c: number } | null;
      drag: { id: number; x0: number; y0: number; live: boolean } | null;
    }[];
    raf: number | null;
    last: number;
    toastTimer: number | null;
    timers: number[];
    wake: () => void;
  } | null>(null);

  if (!simRef.current) {
    simRef.current = {
      main: {
        sc: gooMakeSpring(1, 520, 16),
        w: gooMakeSpring(MS, 300, 20),
        rot: gooMakeSpring(0, 320, 20),
      },
      bubs: GOO_MARK_OPTIONS.map(() => ({
        x: gooMakeSpring(0),
        y: gooMakeSpring(0),
        s: gooMakeSpring(0.5, 420, 22),
        pending: null,
        drag: null,
      })),
      raf: null,
      last: 0,
      toastTimer: null,
      timers: [],
      wake: () => {},
    };
  }

  useEffect(() => {
    const sim = simRef.current!;
    const reduce = prefersReducedMotion();

    const renderFrame = () => {
      const mainBlob = mainBlobRef.current;
      const mainBtn = mainBtnRef.current;
      const plus = plusRef.current;
      if (mainBlob && mainBtn) {
        const w = sim.main.w.x;
        const s = sim.main.sc.x;
        const mt = `translate(${OX - w / 2}px, ${OY - MS / 2}px) scale(${s})`;
        mainBlob.style.width = `${w}px`;
        mainBlob.style.transform = mt;
        mainBtn.style.width = `${w}px`;
        mainBtn.style.transform = mt;
      }
      if (plus) {
        plus.style.transform = `rotate(${sim.main.rot.x}deg)`;
      }
      sim.bubs.forEach((b, i) => {
        const blob = bubBlobRefs.current[i];
        const btn = bubBtnRefs.current[i];
        const x = OX + b.x.x - BS / 2;
        const y = OY + b.y.x - BS / 2;
        const sc = b.s.x;
        const sp = Math.hypot(b.x.v, b.y.v);
        const st = 1 + Math.min(sp / 2600, 0.32);
        const a = Math.atan2(b.y.v, b.x.v);
        if (blob) {
          blob.style.transform = `translate(${x}px, ${y}px) rotate(${a}rad) scale(${sc * st}, ${sc / st})`;
        }
        if (btn) {
          btn.style.transform = `translate(${x}px, ${y}px) scale(${sc})`;
          const dist = Math.hypot(b.x.x, b.y.x);
          btn.style.opacity = String(Math.max(0, Math.min(1, (dist - 12) / 30)));
          btn.style.pointerEvents = openRef.current ? "auto" : "none";
        }
      });
    };

    const tick = (now: number) => {
      const dt = Math.min((now - sim.last) / 1000, 1 / 30);
      sim.last = now;
      const sub = 4;
      const subDt = dt / sub;
      for (let k = 0; k < sub; k++) {
        sim.bubs.forEach((b) => {
          if (b.pending && (b.pending.t -= subDt) <= 0) {
            const p = b.pending;
            b.pending = null;
            gooTuneSpring(b.x, p.k, p.c, reduce);
            gooTuneSpring(b.y, p.k, p.c, reduce);
            b.x.t = p.pos.x;
            b.y.t = p.pos.y;
          }
          gooStepSpring(b.x, subDt);
          gooStepSpring(b.y, subDt);
          gooStepSpring(b.s, subDt);
        });
        gooStepSpring(sim.main.sc, subDt);
        gooStepSpring(sim.main.w, subDt);
        gooStepSpring(sim.main.rot, subDt);
      }
      renderFrame();

      const busy =
        !gooSpringSettled(sim.main.sc) ||
        !gooSpringSettled(sim.main.w) ||
        !gooSpringSettled(sim.main.rot) ||
        sim.bubs.some(
          (b) =>
            b.pending !== null ||
            b.drag !== null ||
            !gooSpringSettled(b.x) ||
            !gooSpringSettled(b.y) ||
            !gooSpringSettled(b.s),
        );
      if (busy) {
        sim.raf = requestAnimationFrame(tick);
      } else {
        sim.raf = null;
        if (!openRef.current && !toastActiveRef.current) {
          setPortalActive(false);
        }
      }
    };

    sim.wake = () => {
      if (sim.raf === null) {
        sim.last = performance.now();
        sim.raf = requestAnimationFrame(tick);
      }
    };

    if (portalActive) {
      renderFrame();
      sim.wake();
    }

    return () => {
      if (sim.raf !== null) cancelAnimationFrame(sim.raf);
      sim.raf = null;
    };
  }, [portalActive]);

  useEffect(() => {
    const sim = simRef.current!;
    return () => {
      if (sim.toastTimer !== null) window.clearTimeout(sim.toastTimer);
      sim.timers.forEach((t) => window.clearTimeout(t));
    };
  }, []);

  const syncAnchor = useCallback(() => {
    const el = rootRef.current;
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const flipDown = rect.top < 125;
    homeRef.current = getHome(flipDown);
    setAnchorPos({
      left: rect.left + rect.width / 2,
      top: rect.top + rect.height / 2,
      flipDown,
    });
    return true;
  }, [getHome]);

  const setMenuOpen = useCallback((next: boolean) => {
    if (next === openRef.current) return;
    if (next) {
      syncAnchor();
      setPortalActive(true);
    }
    openRef.current = next;
    setOpen(next);
    const sim = simRef.current!;
    const reduce = prefersReducedMotion();
    const stagger = 0.045;
    sim.main.rot.t = next ? 135 : 0;
    sim.main.sc.v -= next ? 3 : 1.6;
    sim.bubs.forEach((b, i) => {
      if (next) {
        b.pending = { t: i * stagger, pos: homeRef.current[i], k: 230, c: 15 };
        b.s.t = 1;
        gooTuneSpring(b.s, 300, 14, reduce);
      } else {
        b.pending = {
          t: (sim.bubs.length - 1 - i) * stagger * 0.66,
          pos: { x: 0, y: 0 },
          k: 520,
          c: 34,
        };
        b.s.t = 0.5;
        gooTuneSpring(b.s, 420, 30, reduce);
      }
    });
    sim.wake();
  }, [syncAnchor]);

  const endToast = useCallback(() => {
    const sim = simRef.current!;
    const reduce = prefersReducedMotion();
    sim.toastTimer = null;
    toastActiveRef.current = false;
    setToastInfo(null);
    gooTuneSpring(sim.main.w, 320, 22, reduce);
    sim.main.w.t = MS;
    sim.main.sc.v -= 1.5;
    sim.wake();
  }, []);

  const triggerToast = useCallback(
    (opt: GooMarkOption) => {
      const sim = simRef.current!;
      const reduce = prefersReducedMotion();
      toastActiveRef.current = true;
      setToastInfo(opt);
      requestAnimationFrame(() => {
        const tw = toastRef.current ? toastRef.current.scrollWidth : 64;
        gooTuneSpring(sim.main.w, 260, 17, reduce);
        sim.main.w.t = Math.max(MS, tw + 28);
        sim.main.sc.v -= 2;
        sim.wake();
      });
      if (sim.toastTimer !== null) window.clearTimeout(sim.toastTimer);
      sim.toastTimer = window.setTimeout(endToast, 1400);
    },
    [endToast],
  );

  const selectOption = useCallback(
    (idx: number) => {
      const opt = GOO_MARK_OPTIONS[idx];
      const sim = simRef.current!;
      onChangeRef.current(opt.mark);
      const t1 = window.setTimeout(() => setMenuOpen(false), 70);
      const t2 = window.setTimeout(() => triggerToast(opt), 260);
      sim.timers.push(t1, t2);
    },
    [setMenuOpen, triggerToast],
  );

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        rootRef.current &&
        !rootRef.current.contains(target) &&
        (!portalRef.current || !portalRef.current.contains(target))
      ) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    const onScrollOrResize = () => {
      syncAnchor();
    };
    document.addEventListener("click", onDocClick);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("click", onDocClick);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open, setMenuOpen, syncAnchor]);

  const band = (r: number, d = 54) => d * (1 - 1 / ((r * 0.55) / d + 1));
  const activeOpt = GOO_MARK_OPTIONS.find((o) => o.mark === value && value !== "");

  return (
    <div
      ref={rootRef}
      className={`goo-mark-wrap ${open ? "is-open" : ""}`}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className={`goo-mark-trigger ${activeOpt ? `has-mark tone-${activeOpt.tone}` : ""}`}
        style={{ visibility: portalActive ? "hidden" : "visible" }}
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          if (simRef.current!.toastTimer !== null) {
            window.clearTimeout(simRef.current!.toastTimer);
            endToast();
          }
          setMenuOpen(!openRef.current);
        }}
      >
        {value ? (
          <span className="goo-current-mark">{value}</span>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        )}
      </button>
      {portalActive &&
        createPortal(
          <div
            ref={portalRef}
            className={`goo-mark-portal ${open ? "is-open" : ""} ${anchorPos.flipDown ? "flip-down" : ""}`}
            style={{ left: anchorPos.left, top: anchorPos.top }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="goo-mark-stage">
              <div className="goo-mark-layer">
                {GOO_MARK_OPTIONS.map((opt, i) => (
                  <div
                    key={opt.tone}
                    ref={(el) => {
                      bubBlobRefs.current[i] = el;
                    }}
                    className={`goo-mark-blob goo-bub-blob tone-${opt.tone}`}
                    style={{ width: BS, height: BS }}
                  />
                ))}
                <div
                  ref={mainBlobRef}
                  className={`goo-mark-blob goo-main-blob ${activeOpt ? `tone-${activeOpt.tone}` : ""}`}
                  style={{ width: MS, height: MS }}
                />
              </div>
              <div className="goo-mark-ui">
                {GOO_MARK_OPTIONS.map((opt, i) => (
                  <button
                    key={opt.tone}
                    type="button"
                    ref={(el) => {
                      bubBtnRefs.current[i] = el;
                    }}
                    className={`goo-mark-btn goo-bub-btn tone-${opt.tone} ${value === opt.mark && opt.mark !== "" ? "is-selected" : ""}`}
                    style={{ width: BS, height: BS }}
                    tabIndex={open ? 0 : -1}
                    aria-label={`${ariaLabel}: ${opt.mark || "解除"} (${opt.label})`}
                    onPointerEnter={() => {
                      if (!openRef.current) return;
                      const b = simRef.current!.bubs[i];
                      b.s.t = 1.14;
                      gooTuneSpring(b.s, 500, 18, prefersReducedMotion());
                      simRef.current!.wake();
                    }}
                    onPointerLeave={() => {
                      const b = simRef.current!.bubs[i];
                      if (openRef.current && !b.drag) {
                        b.s.t = 1;
                        simRef.current!.wake();
                      }
                    }}
                    onPointerDown={(e) => {
                      if (!openRef.current) return;
                      const b = simRef.current!.bubs[i];
                      b.drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, live: false };
                      try {
                        e.currentTarget.setPointerCapture(e.pointerId);
                      } catch {
                        /* ignore */
                      }
                      b.s.t = 0.92;
                      simRef.current!.wake();
                    }}
                    onPointerMove={(e) => {
                      const b = simRef.current!.bubs[i];
                      const d = b.drag;
                      if (!d || d.id !== e.pointerId) return;
                      const dx = e.clientX - d.x0;
                      const dy = e.clientY - d.y0;
                      const r = Math.hypot(dx, dy);
                      if (!d.live && r > 4) {
                        d.live = true;
                        b.s.t = 1.08;
                      }
                      if (!d.live) return;
                      const k = band(r) / (r || 1);
                      b.pending = null;
                      const reduce = prefersReducedMotion();
                      gooTuneSpring(b.x, 900, 50, reduce);
                      gooTuneSpring(b.y, 900, 50, reduce);
                      b.x.t = homeRef.current[i].x + dx * k;
                      b.y.t = homeRef.current[i].y + dy * k;
                      simRef.current!.wake();
                    }}
                    onPointerUp={(e) => {
                      const b = simRef.current!.bubs[i];
                      const d = b.drag;
                      if (!d || d.id !== e.pointerId) return;
                      b.drag = null;
                      const reduce = prefersReducedMotion();
                      if (d.live) {
                        gooTuneSpring(b.x, 300, 12, reduce);
                        gooTuneSpring(b.y, 300, 12, reduce);
                        b.x.t = homeRef.current[i].x;
                        b.y.t = homeRef.current[i].y;
                        b.s.t = 1;
                        simRef.current!.wake();
                      } else {
                        b.s.t = 1;
                        b.s.v += 4;
                        simRef.current!.wake();
                        selectOption(i);
                      }
                    }}
                    onPointerCancel={(e) => {
                      const b = simRef.current!.bubs[i];
                      if (b.drag && b.drag.id === e.pointerId) {
                        b.drag = null;
                        const reduce = prefersReducedMotion();
                        gooTuneSpring(b.x, 300, 12, reduce);
                        gooTuneSpring(b.y, 300, 12, reduce);
                        b.x.t = homeRef.current[i].x;
                        b.y.t = homeRef.current[i].y;
                        b.s.t = 1;
                        simRef.current!.wake();
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        selectOption(i);
                      }
                    }}
                  >
                    <span className="goo-bub-glyph">{opt.mark || "✕"}</span>
                    <span className="goo-tip">{opt.label}</span>
                  </button>
                ))}
                <button
                  type="button"
                  ref={mainBtnRef}
                  className={`goo-mark-btn goo-main-btn ${toastInfo ? "toasting" : ""} ${activeOpt ? `has-mark tone-${activeOpt.tone}` : ""}`}
                  style={{ width: MS, height: MS }}
                  aria-label={ariaLabel}
                  aria-expanded={open}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (simRef.current!.toastTimer !== null) {
                      window.clearTimeout(simRef.current!.toastTimer);
                      endToast();
                    }
                    setMenuOpen(!openRef.current);
                  }}
                >
                  <span ref={plusRef} className="goo-plus">
                    {value && !open ? (
                      <span className="goo-current-mark">{value}</span>
                    ) : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                    )}
                  </span>
                  <span ref={toastRef} className="goo-toast">
                    {toastInfo ? `${toastInfo.mark || "✕"} ${toastInfo.label}` : ""}
                  </span>
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
