import React from "react";
import { Switch } from "@/components/ui/Switch";

/** A settings page: a title, one line of why, then cards. */
export const PfPage: React.FC<{
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}> = ({ title, subtitle, children, action }) => (
  <div className="max-w-2xl w-full mx-auto flex flex-col gap-5 pb-8 pf-rise">
    <header className="flex items-end gap-4 px-1 pt-2">
      <div className="flex-1 min-w-0">
        <h1 className="text-[24px] font-semibold tracking-tight text-pf-text">
          {title}
        </h1>
        {subtitle && (
          <p className="text-[14px] text-pf-muted mt-1 leading-relaxed">
            {subtitle}
          </p>
        )}
      </div>
      {action}
    </header>
    {children}
  </div>
);

export const PfCard: React.FC<{
  title?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  /** The children bring their own card. */
  bare?: boolean;
}> = ({ title, description, children, className = "", bare = false }) => (
  <section className={`flex flex-col gap-2 ${className}`}>
    {title && (
      <div className="px-1">
        <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-pf-muted">
          {title}
        </h2>
        {description && (
          <p className="text-[12.5px] text-pf-muted/90 mt-0.5">{description}</p>
        )}
      </div>
    )}
    {bare ? (
      children
    ) : (
      <div className="pf-card divide-y divide-pf-border">{children}</div>
    )}
  </section>
);

/** One row: what it is, what it does, and its control. */
export const PfRow: React.FC<{
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  stacked?: boolean;
  id?: string;
}> = ({ title, description, children, stacked = false, id }) => (
  <div
    className={`px-4 py-3.5 flex ${
      stacked ? "flex-col gap-3" : "items-center gap-4"
    }`}
  >
    <div className="flex-1 min-w-0">
      <div id={id} className="text-[14px] font-medium text-pf-text">
        {title}
      </div>
      {description && (
        <div className="text-[12.5px] text-pf-muted mt-0.5 leading-relaxed">
          {description}
        </div>
      )}
    </div>
    {children && <div className={stacked ? "" : "shrink-0"}>{children}</div>}
  </div>
);

export const PfToggleRow: React.FC<{
  id: string;
  title: string;
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}> = ({ id, title, description, checked, onChange, disabled }) => (
  <PfRow id={id} title={title} description={description}>
    <Switch
      checked={checked}
      onChange={onChange}
      disabled={disabled}
      ariaLabelledBy={id}
    />
  </PfRow>
);

/** Choices shown side by side, one picked (a segmented control). */
export function PfSegmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex flex-wrap gap-1 p-1 rounded-xl bg-pf-surface-2 border border-pf-border"
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={`px-3 h-8 rounded-lg text-[13px] font-medium transition-all cursor-pointer ${
              on
                ? "bg-pf-surface text-pf-text shadow-sm ring-1 ring-pf-border-strong"
                : "text-pf-muted hover:text-pf-text"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A small status pill. */
export const PfBadge: React.FC<{
  tone?: "violet" | "mint" | "amber" | "muted" | "blue";
  children: React.ReactNode;
}> = ({ tone = "muted", children }) => {
  const tones = {
    violet: "bg-pf-violet/15 text-pf-violet",
    blue: "bg-pf-blue/15 text-pf-blue",
    mint: "bg-pf-mint/15 text-pf-mint",
    amber: "bg-pf-amber/15 text-pf-amber",
    muted: "bg-pf-surface-2 text-pf-muted",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 h-6 px-2.5 rounded-full text-[11.5px] font-semibold ${tones[tone]}`}
    >
      {children}
    </span>
  );
};
