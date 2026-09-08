export function openAnotherParticipant(
  url = location.href,
  open: typeof window.open = window.open.bind(window),
): void {
  open(url, "_blank", "noopener");
}
