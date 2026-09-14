/** Invisible alternatives reserve the label's width without changing its accessible name. */
export function ActionLabel({
  value,
  alternatives,
}: {
  value: string;
  alternatives: readonly string[];
}) {
  return (
    <span className="inline-grid">
      <span className="col-start-1 row-start-1">{value}</span>
      {alternatives.map((label) => (
        <span key={label} aria-hidden="true" className="invisible col-start-1 row-start-1">
          {label}
        </span>
      ))}
    </span>
  );
}
