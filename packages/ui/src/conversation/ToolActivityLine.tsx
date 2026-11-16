/** The line a placeholder shows; a span so it sits inside an inline frame too. */
export default function ToolActivityLine({ label }: { label: string }): React.JSX.Element {
  return (
    <span className="tool-activity" role="status">
      <span className="tool-activity-spinner" aria-hidden="true" />
      <span className="tool-activity-label">{label}…</span>
    </span>
  )
}
