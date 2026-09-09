import type {
  ButtonHTMLAttributes,
  ReactNode,
} from "react";

const ACTION_CLASS =
  "min-h-10 rounded-[4px] border px-3 py-2 font-display text-[0.72rem] font-bold uppercase tracking-[0.07em] transition-colors motion-reduce:transition-none focus-visible:outline-[3px] focus-visible:outline-offset-3 focus-visible:outline-field-orange disabled:cursor-not-allowed disabled:border-[#5b554e] disabled:text-[#787168]";

export function ActionButton({
  children,
  tone = "default",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "danger" | "default" | "primary" | "quiet";
}): ReactNode {
  const toneClass = {
    danger:
      "border-[#b56550] text-[#ffdfd4] enabled:hover:bg-[#443d35] enabled:hover:text-white",
    default:
      "border-[#82776a] text-bone enabled:hover:border-[#c8bba8] enabled:hover:bg-[#443d35] enabled:hover:text-white",
    primary:
      "border-field-green bg-field-green text-[#172019] enabled:hover:border-[#8db990] enabled:hover:bg-[#8db990]",
    quiet:
      "border-dashed border-[#82776a] text-bone/75 enabled:hover:border-[#c8bba8] enabled:hover:bg-[#443d35] enabled:hover:text-white",
  }[tone];
  return (
    <button className={`${ACTION_CLASS} ${toneClass}`} type="button" {...props}>
      {children}
    </button>
  );
}

export function StatusRow({
  label,
  value,
}: {
  label: string;
  value: string;
}): ReactNode {
  return (
    <div className="flex justify-between gap-4 border-t border-[#514b43] py-2 text-xs">
      <dt className="text-bone/60">{label}</dt>
      <dd className="m-0 text-right font-mono text-[0.65rem] uppercase tracking-[0.04em]">
        {value}
      </dd>
    </div>
  );
}
