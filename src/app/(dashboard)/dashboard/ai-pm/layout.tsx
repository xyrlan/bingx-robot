import { redirect } from 'next/navigation';

// AI PM (portfolio management, chat, activity) is disabled. This layout wraps
// every /dashboard/ai-pm route and redirects to the dashboard. Remove this file
// to re-enable the feature; the underlying pages/components are still intact.
export default function AiPmLayout() {
  redirect('/dashboard');
}
