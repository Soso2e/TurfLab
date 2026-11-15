import React, { useEffect, useRef } from "react";

export interface RubberDockItem {
  id: string;
  title: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}

interface SpringState {
  x: number;
  v: number;
  t: number;
  k: number;
  c: number;
}

const S = (x: number, k = 400, c = 30): SpringState => ({ x, v: 0, t: x, k, c });
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

const SPRING_LEAD: [number, number] = [640, 38];
const SPRING_TRAIL: [number, number] = [150, 16];
const SPRING_DRAG_LEAD: [number, number] = [1100, 56];
const SPRING_DRAG_TRAIL: [number, number] = [320, 26];
const SPRING_POP: [number, number] = [520, 16];

const TAB_W = 74;
const TAB_H = 54;
const GAP = 4;
const DOCK_PAD = 6; // 左右・上下の余白合計 12px

/**
 * Rubber Dock (DesignBookmark Motion インスパイア)
 * ピルの左右エッジに独立したスプリングを持たせ、移動・ドラッグ時にゴムのように伸縮する。
 * 2層アイコン + clip-path により、ピルが横切る部分のアイコンとラベルが滑らかに反転する。
 */
export function RubberDock({
  items,
  activeId,
  onSelect,
}: {
  items: RubberDockItem[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  const dockRef = useRef<HTMLDivElement | null>(null);
  const groundRef = useRef<HTMLDivElement | null>(null);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const indRef = useRef<HTMLDivElement | null>(null);
  const topIconsRef = useRef<HTMLDivElement | null>(null);
  const baseBtnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const topItemRefs = useRef<(HTMLDivElement | null)[]>([]);

  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const activeIdx = Math.max(
    0,
    items.findIndex((item) => item.id === activeId),
  );

  // スプリングとドラッグ状態を ref で保持し、rAF ループから直接更新する
  const engineRef = useRef<{
    setActive: (index: number, dirHint?: number, notify?: boolean) => void;
  } | null>(null);

  useEffect(() => {
    const N = items.length;
    if (N === 0) return;

    const reduce =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const tune = (s: SpringState, k: number, c: number) => {
      s.k = k;
      s.c = reduce ? 2 * Math.sqrt(k) : c;
    };

    const step = (s: SpringState, dt: number) => {
      const a = -s.k * (s.x - s.t) - s.c * s.v;
      s.v += a * dt;
      s.x += s.v * dt;
    };

    const TW = N * TAB_W + (N - 1) * GAP;
    const COL_W = TW + DOCK_PAD * 2;
    const COL_H = TAB_H + DOCK_PAD * 2;
    const cx = (i: number) => TAB_W / 2 + i * (TAB_W + GAP);

    const initIdx = clamp(activeIdx, 0, N - 1);
    const L = S(cx(initIdx) - TAB_W / 2);
    const R = S(cx(initIdx) + TAB_W / 2);
    const W = S(reduce ? COL_W : TAB_W + DOCK_PAD * 2, 260, 20);
    const H = S(COL_H, 400, 34);
    const nudge = S(0, 300, 18);
    const pops = items.map(() => S(1, ...SPRING_POP));
    const all = [L, R, W, H, nudge, ...pops];

    let currentActive = initIdx;
    let suppressClick = false;

    const moveTo = (center: number, dir: number, drag = false) => {
      const lead = drag ? SPRING_DRAG_LEAD : SPRING_LEAD;
      const trail = drag ? SPRING_DRAG_TRAIL : SPRING_TRAIL;
      if (dir === 0 || reduce) {
        tune(L, 600, 44);
        tune(R, 600, 44);
      } else {
        const [l, r] = dir > 0 ? [trail, lead] : [lead, trail];
        tune(L, ...l);
        tune(R, ...r);
      }
      L.t = center - TAB_W / 2;
      R.t = center + TAB_W / 2;
    };

    const setActive = (i: number, dirHint?: number, notify = true) => {
      const next = clamp(i, 0, N - 1);
      const dir = dirHint ?? Math.sign(cx(next) - (L.x + R.x) / 2);
      moveTo(cx(next), dir);
      if (next !== currentActive && !reduce) {
        pops[next].v -= 3.2;
      }
      currentActive = next;
      if (notify) {
        const target = itemsRef.current[next];
        if (target) onSelectRef.current(target.id);
      }
    };

    engineRef.current = { setActive };

    // イントロ: 1つのピルから左右に伸びてドックになる
    let introTimer: number | undefined;
    if (!reduce) {
      introTimer = window.setTimeout(() => {
        W.t = COL_W;
        tune(W, 220, 15);
      }, 120);
    } else {
      W.x = COL_W;
      W.t = COL_W;
    }

    // ドラッグ操作
    const tabsEl = tabsRef.current;
    const dockEl = dockRef.current;
    let drag: {
      id: number;
      x0: number;
      last: number;
      live: boolean;
      dir: number;
    } | null = null;

    const rubber = (x: number, min: number, max: number, d = 46) =>
      x < min
        ? min - (1 - 1 / (((min - x) * 0.55) / d + 1)) * d
        : x > max
          ? max + (1 - 1 / (((x - max) * 0.55) / d + 1)) * d
          : x;

    const localX = (e: PointerEvent) => {
      const rect = dockEl?.getBoundingClientRect();
      if (!rect) return cx(currentActive);
      return e.clientX - (rect.left + rect.width / 2 - nudge.x) + TW / 2;
    };

    const onPointerDown = (e: PointerEvent) => {
      drag = {
        id: e.pointerId,
        x0: e.clientX,
        last: localX(e),
        live: false,
        dir: 0,
      };
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id || !tabsEl) return;
      if (!drag.live && Math.abs(e.clientX - drag.x0) > 4) {
        drag.live = true;
        tabsEl.setPointerCapture(e.pointerId);
        tabsEl.classList.add("dragging");
      }
      if (!drag.live) return;
      const raw = localX(e);
      const d = raw - drag.last;
      drag.last = raw;
      if (Math.abs(d) > 0.5) drag.dir = Math.sign(d);
      const c = rubber(raw, cx(0), cx(N - 1));
      moveTo(c, drag.dir, true);
      nudge.t = (c - clamp(c, cx(0), cx(N - 1))) * 0.35;
    };

    const endDrag = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id || !tabsEl) return;
      if (drag.live) {
        const c = (L.t + R.t) / 2;
        nudge.t = 0;
        const targetIdx = Math.round(
          (c - cx(0)) / (TAB_W + GAP) + drag.dir * 0.18,
        );
        setActive(targetIdx, drag.dir || 0, true);
        suppressClick = true;
        window.setTimeout(() => {
          suppressClick = false;
        }, 0);
        tabsEl.classList.remove("dragging");
      }
      drag = null;
    };

    tabsEl?.addEventListener("pointerdown", onPointerDown);
    tabsEl?.addEventListener("pointermove", onPointerMove);
    tabsEl?.addEventListener("pointerup", endDrag);
    tabsEl?.addEventListener("pointercancel", endDrag);

    // クリック判定のために suppressClick を参照できるようにする
    const handleTabClick = (i: number) => {
      if (suppressClick) return;
      setActive(i, undefined, true);
    };

    const clickHandlers = baseBtnRefs.current.map((btn, i) => {
      const fn = () => handleTabClick(i);
      btn?.addEventListener("click", fn);
      return { btn, fn };
    });

    // rAF ループ
    let rafId = 0;
    let last = performance.now();

    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 1 / 30);
      last = now;
      const sub = 4;
      for (let k = 0; k < sub; k++) {
        for (const s of all) step(s, dt / sub);
      }

      const w = W.x;
      const h = Math.max(H.x, 40);
      if (dockRef.current) {
        dockRef.current.style.width = `${w}px`;
        dockRef.current.style.height = `${h}px`;
        dockRef.current.style.borderRadius = `${Math.min(h / 2, 34)}px`;
        dockRef.current.style.transform = `translate3d(calc(-50% + ${nudge.x}px), 0, 0)`;
      }
      if (groundRef.current) {
        groundRef.current.style.width = `${w * 0.86}px`;
        groundRef.current.style.transform = `translate3d(calc(-50% + ${nudge.x * 0.6}px), 0, 0)`;
      }

      let l = L.x;
      let r = R.x;
      if (r < l) [l, r] = [r, l];
      const iw = Math.max(r - l, 24);
      const ih = TAB_H * clamp(1 / Math.sqrt(iw / TAB_H), 0.72, 1.08);
      const top = (TAB_H - ih) / 2;

      if (indRef.current) {
        indRef.current.style.width = `${iw}px`;
        indRef.current.style.height = `${ih}px`;
        indRef.current.style.borderRadius = `${ih / 2}px`;
        indRef.current.style.transform = `translate3d(${l}px, ${top}px, 0)`;
      }
      if (topIconsRef.current) {
        topIconsRef.current.style.clipPath = `inset(${top}px ${TW - l - iw}px ${TAB_H - top - ih}px ${l}px round ${ih / 2}px)`;
      }

      pops.forEach((p, i) => {
        const scale = `scale(${p.x})`;
        const baseInner = baseBtnRefs.current[i]?.firstElementChild as HTMLElement | null;
        const topInner = topItemRefs.current[i]?.firstElementChild as HTMLElement | null;
        if (baseInner) baseInner.style.transform = scale;
        if (topInner) topInner.style.transform = scale;
      });

      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rafId);
      if (introTimer !== undefined) window.clearTimeout(introTimer);
      tabsEl?.removeEventListener("pointerdown", onPointerDown);
      tabsEl?.removeEventListener("pointermove", onPointerMove);
      tabsEl?.removeEventListener("pointerup", endDrag);
      tabsEl?.removeEventListener("pointercancel", endDrag);
      clickHandlers.forEach(({ btn, fn }) => btn?.removeEventListener("click", fn));
      engineRef.current = null;
    };
  }, [items.length]);

  // 外部（ボタンクリックや詳細からの戻りなど）で activeId が変わった場合にピルを追従させる
  useEffect(() => {
    engineRef.current?.setActive(activeIdx, undefined, false);
  }, [activeIdx]);

  const tw = items.length * TAB_W + Math.max(0, items.length - 1) * GAP;

  return (
    <div className="rubber-dock-wrap" aria-label="メインナビゲーション">
      <div className="rubber-dock-ground" ref={groundRef} aria-hidden="true" />
      <div className="rubber-dock" ref={dockRef}>
        <div
          className="rubber-dock-tabs"
          ref={tabsRef}
          style={{ width: `${tw}px`, height: `${TAB_H}px` }}
        >
          <div className="rubber-dock-icons base" role="tablist" aria-label="タブ">
            {items.map((item, i) => {
              const IconComp = item.icon;
              const isSelected = item.id === activeId;
              return (
                <button
                  key={item.id}
                  ref={(el) => {
                    baseBtnRefs.current[i] = el;
                  }}
                  type="button"
                  role="tab"
                  aria-label={item.title}
                  aria-selected={isSelected}
                  tabIndex={isSelected ? 0 : -1}
                  title={item.title}
                  style={{ width: `${TAB_W}px`, height: `${TAB_H}px` }}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowRight") {
                      e.preventDefault();
                      const next = Math.min(items.length - 1, i + 1);
                      engineRef.current?.setActive(next, 1, true);
                      baseBtnRefs.current[next]?.focus();
                    } else if (e.key === "ArrowLeft") {
                      e.preventDefault();
                      const prev = Math.max(0, i - 1);
                      engineRef.current?.setActive(prev, -1, true);
                      baseBtnRefs.current[prev]?.focus();
                    }
                  }}
                >
                  <span className="rubber-dock-item-inner">
                    <IconComp size={20} className="rubber-dock-svg" />
                    <span className="rubber-dock-label">{item.title}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="rubber-dock-indicator" ref={indRef} aria-hidden="true" />
          <div className="rubber-dock-icons top" ref={topIconsRef} aria-hidden="true">
            {items.map((item, i) => {
              const IconComp = item.icon;
              return (
                <div
                  key={item.id}
                  ref={(el) => {
                    topItemRefs.current[i] = el;
                  }}
                  style={{ width: `${TAB_W}px`, height: `${TAB_H}px` }}
                >
                  <span className="rubber-dock-item-inner">
                    <IconComp size={20} className="rubber-dock-svg" />
                    <span className="rubber-dock-label">{item.title}</span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
