import type { ChangeEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Diamond, Minus, Plus, X } from "./icons";

/**
 * The editor's form controls.
 *
 * Deliberately dependency-free and small: every panel is built from these, so
 * the inspector, template slots and export dialog all look and behave alike.
 */

/* ------------------------------------------------------------------ *
 * Layout
 * ------------------------------------------------------------------ */

export function Field({
  label,
  hint,
  children,
  inline = false,
  onKeyframe,
  keyframed = false,
}: {
  label?: string;
  hint?: string;
  children: ReactNode;
  inline?: boolean;
  /** When provided, renders the keyframe toggle button beside the label. */
  onKeyframe?: () => void;
  keyframed?: boolean;
}) {
  return (
    <div className={inline ? "qv-field qv-field--inline" : "qv-field"}>
      {label !== undefined && (
        <div className="qv-field__head">
          <span className="qv-field__label">{label}</span>
          {onKeyframe && (
            <button
              type="button"
              className={keyframed ? "qv-kf qv-kf--on" : "qv-kf"}
              title={keyframed ? "删除该属性的关键帧" : "在当前时间打关键帧"}
              onClick={onKeyframe}
            >
              <Diamond size={11} strokeWidth={2.5} />
            </button>
          )}
        </div>
      )}
      <div className="qv-field__body">{children}</div>
      {hint && <div className="qv-field__hint">{hint}</div>}
    </div>
  );
}

export function Section({
  title,
  children,
  collapsible = true,
  defaultOpen = true,
  right,
}: {
  title: string;
  children: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  right?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="qv-section">
      <div className="qv-section__head">
        <button
          type="button"
          className="qv-section__title"
          onClick={() => collapsible && setOpen((v) => !v)}
        >
          {collapsible && (
            <ChevronDown
              size={13}
              className={open ? "qv-caret qv-caret--open" : "qv-caret"}
            />
          )}
          <span>{title}</span>
        </button>
        {right}
      </div>
      {open && <div className="qv-section__body">{children}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Text
 * ------------------------------------------------------------------ */

export function TextInput({
  value,
  onChange,
  placeholder,
  onCommit,
  multiline = false,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Called on blur/Enter; useful for values that are expensive to rebuild. */
  onCommit?: (value: string) => void;
  multiline?: boolean;
  disabled?: boolean;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);

  if (multiline) {
    return (
      <textarea
        className="qv-input qv-input--area"
        value={local}
        rows={3}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => {
          setLocal(e.target.value);
          onChange(e.target.value);
        }}
        onBlur={() => onCommit?.(local)}
      />
    );
  }

  return (
    <input
      className="qv-input"
      value={local}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => {
        setLocal(e.target.value);
        onChange(e.target.value);
      }}
      onBlur={() => onCommit?.(local)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/* ------------------------------------------------------------------ *
 * Numbers
 * ------------------------------------------------------------------ */

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  precision = 2,
  disabled = false,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  precision?: number;
  disabled?: boolean;
}) {
  const [text, setText] = useState(String(round(value, precision)));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setText(String(round(value, precision)));
  }, [value, precision, editing]);

  const commit = (raw: string) => {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      let next = parsed;
      if (min !== undefined) next = Math.max(min, next);
      if (max !== undefined) next = Math.min(max, next);
      onChange(next);
      setText(String(round(next, precision)));
    } else {
      setText(String(round(value, precision)));
    }
    setEditing(false);
  };

  return (
    <div className="qv-number">
      {step > 0 && (
        <button
          type="button"
          className="qv-number__step"
          onClick={() => onChange(clamp(value - step, min, max))}
          tabIndex={-1}
        >
          <Minus size={11} />
        </button>
      )}
      <input
        className="qv-input qv-input--number"
        value={text}
        disabled={disabled}
        onFocus={() => setEditing(true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
      {suffix && <span className="qv-number__suffix">{suffix}</span>}
      {step > 0 && (
        <button
          type="button"
          className="qv-number__step"
          onClick={() => onChange(clamp(value + step, min, max))}
          tabIndex={-1}
        >
          <Plus size={11} />
        </button>
      )}
    </div>
  );
}

export function Slider({
  value,
  onChange,
  onCommit,
  min = 0,
  max = 1,
  step = 0.01,
  showValue = true,
  precision = 2,
}: {
  value: number;
  onChange: (value: number) => void;
  onCommit?: () => void;
  min?: number;
  max?: number;
  step?: number;
  showValue?: boolean;
  precision?: number;
}) {
  return (
    <div className="qv-slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(Number(e.target.value))}
        onPointerUp={() => onCommit?.()}
        onKeyUp={() => onCommit?.()}
      />
      {showValue && <span className="qv-slider__value">{round(value, precision)}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Colour
 * ------------------------------------------------------------------ */

const SWATCHES = [
  "#C97640",
  "#E29A5A",
  "#EFC17B",
  "#A5532E",
  "#55251E",
  "#ffffff",
  "#c6c8d2",
  "#8b8e9c",
  "#10131a",
  "#000000",
  "#6FCF97",
  "#5AA9E6",
  "#9B8CFF",
  "#E86A7C",
];

export function ColorInput({
  value,
  onChange,
  onCommit,
  presets = SWATCHES,
}: {
  value: string;
  onChange: (value: string) => void;
  onCommit?: () => void;
  presets?: string[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="qv-color">
      <button type="button" className="qv-color__chip" onClick={() => {
        if (open) onCommit?.();
        setOpen((v) => !v);
      }}>
        <span className="qv-color__swatch" style={{ background: value }} />
        <span className="qv-color__value">{value}</span>
      </button>
      {open && (
        <div className="qv-color__pop">
          <input
            type="color"
            value={normalizeHex(value)}
            onChange={(e) => onChange(e.target.value)}
            onBlur={() => onCommit?.()}
          />
          <div className="qv-color__grid">
            {presets.map((c) => (
              <button
                key={c}
                type="button"
                className="qv-color__preset"
                style={{ background: c }}
                title={c}
                onClick={() => {
                  onChange(c);
                  onCommit?.();
                  setOpen(false);
                }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function normalizeHex(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : "#c97640";
}

/* ------------------------------------------------------------------ *
 * Choice
 * ------------------------------------------------------------------ */

export interface Option<T extends string> {
  value: T;
  label: string;
}

export function Select<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<Option<T>>;
}) {
  return (
    <div className="qv-select">
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown size={13} className="qv-select__caret" />
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<Option<T>>;
}) {
  return (
    <div className="qv-seg">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={o.value === value ? "qv-seg__item qv-seg__item--on" : "qv-seg__item"}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={
        checked
          ? "qv-toggle qv-toggle--on"
          : "qv-toggle" + (disabled ? " qv-toggle--disabled" : "")
      }
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
    >
      <span className="qv-toggle__knob" />
      {label && <span className="qv-toggle__label">{label}</span>}
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * Buttons
 * ------------------------------------------------------------------ */

export function Button({
  children,
  onClick,
  variant = "default",
  disabled,
  title,
  icon,
  full,
}: {
  children?: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "ghost" | "danger";
  disabled?: boolean;
  title?: string;
  icon?: ReactNode;
  full?: boolean;
}) {
  return (
    <button
      type="button"
      className={`qv-btn qv-btn--${variant}${full ? " qv-btn--full" : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {icon}
      {children}
    </button>
  );
}

export function IconButton({
  icon,
  onClick,
  title,
  active,
  disabled,
  danger,
}: {
  icon: ReactNode;
  onClick?: () => void;
  title?: string;
  active?: boolean;
  disabled?: boolean;
  danger?: boolean;
}) {
  const classes = ["qv-icon-btn"];
  if (active) classes.push("qv-icon-btn--on");
  if (danger) classes.push("qv-icon-btn--danger");
  return (
    <button
      type="button"
      className={classes.join(" ")}
      onClick={onClick}
      title={title}
      disabled={disabled}
    >
      {icon}
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * Misc
 * ------------------------------------------------------------------ */

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="qv-empty">
      {icon && <div className="qv-empty__icon">{icon}</div>}
      <div className="qv-empty__title">{title}</div>
      {hint && <div className="qv-empty__hint">{hint}</div>}
      {action && <div className="qv-empty__action">{action}</div>}
    </div>
  );
}

/** Inline progress bar used by export and long-running tasks. */
export function ProgressBar({ ratio, label }: { ratio: number; label?: string }) {
  return (
    <div className="qv-progress">
      <div className="qv-progress__track">
        <div
          className="qv-progress__fill"
          style={{ width: `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%` }}
        />
      </div>
      {label && <div className="qv-progress__label">{label}</div>}
    </div>
  );
}

/** Modal shell shared by the export dialogs. */
export function Modal({
  title,
  children,
  onClose,
  footer,
  width = 520,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="qv-modal__backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="qv-modal" style={{ width }} ref={ref}>
        <div className="qv-modal__head">
          <span>{title}</span>
          <button type="button" className="qv-icon-btn" onClick={onClose} title="关闭">
            <X size={15} />
          </button>
        </div>
        <div className="qv-modal__body">{children}</div>
        {footer && <div className="qv-modal__foot">{footer}</div>}
      </div>
    </div>
  );
}

function round(v: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(v * f) / f;
}

function clamp(v: number, min?: number, max?: number): number {
  if (min !== undefined && v < min) return min;
  if (max !== undefined && v > max) return max;
  return v;
}
