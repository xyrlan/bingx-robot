export default function DashboardLoading() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-default-200 border-t-accent" />
        <p className="text-sm text-muted">Loading...</p>
      </div>
    </div>
  );
}
