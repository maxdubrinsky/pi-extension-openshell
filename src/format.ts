/** Small formatting helpers shared by the tool renderers. */

export function formatAge(ms: number | undefined, now: number = Date.now()): string {
  if (!ms || ms <= 0) return "?";
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24}h`;
}

/** First column padded to the widest cell; keeps output readable in the TUI. */
export function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return headers.length > 0 ? `_${headers.join(" | ")}_` : "_none_";
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const renderRow = (row: string[]) =>
    row.map((cell, index) => (cell ?? "").padEnd(widths[index] ?? 0)).join("  ").trimEnd();
  return [renderRow(headers), renderRow(widths.map((width) => "-".repeat(width))), ...rows.map(renderRow)].join("\n");
}

export interface Truncated {
  text: string;
  truncated: boolean;
  /** Characters dropped from the middle. */
  omitted: number;
}

/**
 * Keep the head and tail of long output: errors usually sit at the end while the
 * command line and first diagnostics sit at the start.
 */
export function truncateMiddle(input: string, maxChars: number): Truncated {
  if (maxChars <= 0 || input.length <= maxChars) return { text: input, truncated: false, omitted: 0 };
  const head = Math.ceil(maxChars * 0.6);
  const tail = Math.max(0, maxChars - head);
  const omitted = input.length - head - tail;
  return {
    text: `${input.slice(0, head)}\n... [${omitted} characters omitted] ...\n${tail > 0 ? input.slice(-tail) : ""}`,
    truncated: true,
    omitted,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MiB`;
}

export function oneLine(text: string, maxChars = 160): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1)}…` : collapsed;
}

/** Render a label map as `k=v,k=v`, sorted for stable output. */
export function formatLabels(labels: Record<string, string> | undefined): string {
  if (!labels) return "";
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([key, value]) => `${key}=${value}`).join(",");
}
