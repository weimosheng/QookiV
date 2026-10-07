import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * A small right-click menu.
 *
 * Positioned in viewport coordinates and flipped when it would overflow the
 * window, so a clip near the right edge does not push its menu off screen.
 */

export interface MenuItem {
  id: string;
  label: string;
  /** Rendered right-aligned, purely as a hint. */
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    setPos({
      x: Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin)),
      y: Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin)),
    });
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // `capture` so the menu closes before any other handler reacts to the click.
    window.addEventListener("mousedown", close, true);
    window.addEventListener("wheel", close, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("wheel", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      className="qv-menu"
      ref={ref}
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.stopPropagation()}
      role="menu"
    >
      {items.map((item) => (
        <div key={item.id}>
          {item.separatorBefore && <div className="qv-menu__sep" />}
          <button
            type="button"
            role="menuitem"
            className={`qv-menu__item${item.danger ? " qv-menu__item--danger" : ""}`}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.onSelect();
              onClose();
            }}
          >
            <span>{item.label}</span>
            {item.shortcut && <span className="qv-menu__shortcut">{item.shortcut}</span>}
          </button>
        </div>
      ))}
    </div>
  );
}
