/** Shared building blocks for the shell. */
import {
  Desktop, Eye, EyeSlash, Moon, Sun, type Icon,
} from "@phosphor-icons/react";
import { useId, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import type { RGB } from "../../engine/types";
import { useStore, type AppState } from "../../store";
import { hexToRgb, rgbToHex, sameColor } from "./util";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  icon?: Icon;
  block?: boolean;
};

export function Button({ variant = "secondary", icon: Glyph, block, className, children, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? "button"}
      className={`sh-btn sh-btn-${variant}${block ? " sh-block" : ""}${className ? " " + className : ""}`}
      {...rest}
    >
      {Glyph && <Glyph size={20} aria-hidden />}
      {children}
    </button>
  );
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: Icon;
  label: string;
  /** toggle state; omit for plain actions */
  pressed?: boolean;
  size?: number;
  /** keyboard hint shown in the tooltip */
  hint?: string;
};

export function IconButton({ icon: Glyph, label, pressed, size = 22, hint, className, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      className={`sh-iconbtn${className ? " " + className : ""}`}
      aria-label={label}
      aria-pressed={pressed}
      title={hint ? `${label} (${hint})` : label}
      {...rest}
    >
      <Glyph size={size} weight={pressed ? "fill" : "regular"} aria-hidden />
    </button>
  );
}

export function Segmented<T extends string | number>(props: {
  label: string;
  value: T;
  options: { value: NoInfer<T>; label: ReactNode; title?: string }[];
  onChange: (value: NoInfer<T>) => void;
  hideLabel?: boolean;
}) {
  const id = useId();
  return (
    <div className="sh-field">
      <span id={id} className={props.hideLabel ? "sh-sr" : "sh-label"}>
        {props.label}
      </span>
      <div className="sh-segmented" role="group" aria-labelledby={id}>
        {props.options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={o.value === props.value}
            aria-label={o.title}
            title={o.title}
            onClick={() => props.onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Field(props: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string }) {
  const { label, hint, error, id: given, ...rest } = props;
  const auto = useId();
  const id = given ?? auto;
  return (
    <div className="sh-field">
      <label className="sh-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="sh-input"
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? id + "-hint" : undefined}
        {...rest}
      />
      {(error || hint) && (
        <p id={id + "-hint"} className={error ? "sh-error" : "sh-hint"} role={error ? "alert" : undefined}>
          {error || hint}
        </p>
      )}
    </div>
  );
}

export function PasswordField(props: {
  label: string;
  value: string;
  onChange(value: string): void;
  hint?: string;
  error?: string;
  autoFocus?: boolean;
  autoComplete?: string;
  name?: string;
}) {
  const [visible, setVisible] = useState(false);
  const id = useId();
  return (
    <div className="sh-field">
      <label className="sh-label" htmlFor={id}>
        {props.label}
      </label>
      <div className="sh-input-group">
        <input
          id={id}
          className="sh-input"
          type={visible ? "text" : "password"}
          name={props.name ?? "pdf-password"}
          value={props.value}
          autoComplete={props.autoComplete ?? "off"}
          autoCapitalize="none"
          spellCheck={false}
          data-autofocus={props.autoFocus ? true : undefined}
          aria-invalid={props.error ? true : undefined}
          aria-describedby={props.error || props.hint ? id + "-hint" : undefined}
          onChange={(e) => props.onChange(e.target.value)}
        />
        <IconButton
          icon={visible ? EyeSlash : Eye}
          label={visible ? "Hide password" : "Show password"}
          onClick={() => setVisible(!visible)}
        />
      </div>
      {(props.error || props.hint) && (
        <p id={id + "-hint"} className={props.error ? "sh-error" : "sh-hint"} role={props.error ? "alert" : undefined}>
          {props.error || props.hint}
        </p>
      )}
    </div>
  );
}

export function Check(props: { label: string; hint?: string; checked: boolean; onChange(v: boolean): void; disabled?: boolean }) {
  return (
    <label className="sh-check">
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span>
        {props.label}
        {props.hint && <small>{props.hint}</small>}
      </span>
    </label>
  );
}

export const INK_SWATCHES: { name: string; value: RGB }[] = [
  { name: "Black", value: [0.07, 0.07, 0.09] },
  { name: "Blue", value: [0.1, 0.27, 0.75] },
  { name: "Red", value: [0.8, 0.16, 0.13] },
  { name: "Green", value: [0.09, 0.5, 0.27] },
  { name: "White", value: [1, 1, 1] },
];

export const MARKER_SWATCHES: { name: string; value: RGB }[] = [
  { name: "Yellow", value: [1, 0.86, 0.2] },
  { name: "Green", value: [0.55, 0.9, 0.45] },
  { name: "Blue", value: [0.55, 0.8, 1] },
  { name: "Pink", value: [1, 0.65, 0.78] },
  { name: "Orange", value: [1, 0.7, 0.35] },
];

export function Swatches(props: {
  label: string;
  value: RGB | null;
  onChange(color: RGB | null): void;
  swatches?: { name: string; value: RGB }[];
  /** offer "none" (used for fills) */
  allowNone?: boolean;
  hideLabel?: boolean;
}) {
  const id = useId();
  const list = props.swatches ?? INK_SWATCHES;
  const value = props.value;
  const custom = value !== null && !list.some((s) => sameColor(s.value, value));
  return (
    <div className="sh-field">
      <span id={id} className={props.hideLabel ? "sh-sr" : "sh-label"}>
        {props.label}
      </span>
      <div className="sh-swatches" role="group" aria-labelledby={id}>
        {props.allowNone && (
          <button
            type="button"
            className="sh-swatch sh-swatch-none"
            aria-label={`${props.label}: none`}
            title="None"
            aria-pressed={value === null}
            onClick={() => props.onChange(null)}
          >
            <span />
          </button>
        )}
        {list.map((s) => (
          <button
            key={s.name}
            type="button"
            className="sh-swatch"
            aria-label={`${props.label}: ${s.name}`}
            title={s.name}
            aria-pressed={value !== null && sameColor(s.value, value)}
            onClick={() => props.onChange(s.value)}
          >
            <span style={{ background: rgbToHex(s.value) }} />
          </button>
        ))}
        <label className="sh-swatch sh-swatch-custom" data-active={custom || undefined} title="Custom colour">
          <span style={{ background: custom ? rgbToHex(value) : undefined }} data-empty={!custom || undefined} />
          <input
            type="color"
            aria-label={`${props.label}: custom colour`}
            value={rgbToHex(value ?? list[0]!.value)}
            onChange={(e) => props.onChange(hexToRgb(e.target.value))}
          />
        </label>
      </div>
    </div>
  );
}

const THEMES: { value: AppState["theme"]; label: string; icon: Icon }[] = [
  { value: "system", label: "System", icon: Desktop },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

export function ThemePicker() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  return (
    <Segmented
      label="Theme"
      value={theme}
      onChange={setTheme}
      options={THEMES.map((t) => ({
        value: t.value,
        label: (
          <>
            <t.icon size={18} aria-hidden />
            {t.label}
          </>
        ),
      }))}
    />
  );
}

/** one button that steps through system, light, dark */
export function ThemeButton() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const index = THEMES.findIndex((t) => t.value === theme);
  const current = THEMES[index] ?? THEMES[0]!;
  const next = THEMES[(index + 1) % THEMES.length]!;
  return (
    <IconButton
      icon={current.icon}
      label={`Theme: ${current.label}. Switch to ${next.label}`}
      onClick={() => setTheme(next.value)}
    />
  );
}

export function Progress({ value, label }: { value: number; label: string }) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      className="sh-progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <span style={{ transform: `scaleX(${percent / 100})` }} />
    </div>
  );
}

export function Empty({ icon: Glyph, title, children }: { icon: Icon; title: string; children?: ReactNode }) {
  return (
    <div className="sh-empty">
      <Glyph size={32} aria-hidden />
      <p className="sh-empty-title">{title}</p>
      {children}
    </div>
  );
}
