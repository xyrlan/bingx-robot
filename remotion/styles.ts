import { CSSProperties } from "react";

export const colors = {
  bg: "#0a0a0a",
  bgCard: "#18181b",
  border: "#27272a",
  fg: "#fafafa",
  muted: "#a1a1aa",
  default100: "#18181b",
  default200: "#27272a",
  default400: "#71717a",
  default500: "#a1a1aa",
  success: "#22c55e",
  danger: "#ef4444",
  accent: "#06b6d4",
  primary: "#3b82f6",
  warning: "#f59e0b",
} as const;

export const fontFamily =
  "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

export const card: CSSProperties = {
  background: colors.bgCard,
  border: `1px solid ${colors.border}`,
  borderRadius: 12,
  overflow: "hidden",
};

export const badge = (
  bg: string,
  color: string
): CSSProperties => ({
  display: "inline-block",
  fontSize: 11,
  padding: "2px 8px",
  borderRadius: 999,
  fontWeight: 500,
  marginLeft: 6,
  background: bg,
  color,
});
