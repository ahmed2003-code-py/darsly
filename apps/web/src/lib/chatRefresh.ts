import type { QueryClient } from '@tanstack/react-query';

let pending: ReturnType<typeof setTimeout> | null = null;

/**
 * Refresh the conversation list — once, however many events asked.
 *
 * One group message reaches an open tab as a message, a thread update and then
 * a read receipt per member who opens it; each used to refetch the whole list,
 * so a busy class chat turned into a stream of identical requests (and, on a
 * shared school or carrier connection, 429s). Everything inside a quarter of a
 * second becomes one refetch.
 */
export function refreshThreadList(queryClient: QueryClient) {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    void queryClient.invalidateQueries({ queryKey: ['chat-threads'] });
  }, 250);
}
