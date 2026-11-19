"use client";

/**
 * The box a table copied out of another program is pasted into (Skola24, Excel, Google Sheets): plain text, with the headers on
 * top. The two places that read a pasted table, the schedule exchange's card and the CSV importers' dialog, share it.
 */
export function PasteTable({
  id,
  label,
  hint,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={6}
        spellCheck={false}
        className="block w-full rounded-md border border-input-strong bg-transparent px-3 py-2 font-mono text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <p className="mt-1 text-sm text-muted-foreground">{hint}</p>
    </div>
  );
}
