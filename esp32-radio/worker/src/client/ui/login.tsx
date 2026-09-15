import { useActionState } from 'react';
import { errorText } from '@/client/radio/api.ts';

export function Login({ onLogin }: { onLogin: (password: string) => Promise<void> }) {
  const [error, submit, pending] = useActionState(async (_previous: string, form: FormData) => {
    try {
      await onLogin(String(form.get('password') ?? ''));
      return '';
    } catch (error) {
      return errorText(error);
    }
  }, '');
  return (
    <form
      action={submit}
      className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-line p-4 sm:p-5 [&>div]:min-w-[200px] [&>div]:flex-1 [&>div]:basis-full lg:[&>div]:basis-auto [&_strong]:text-base [&_strong]:font-medium [&_p]:mt-1 [&_p]:text-xs [&_p]:leading-relaxed [&_p]:text-muted [&_label]:min-w-32 [&_label]:flex-1 lg:[&_label]:flex-none [&_input]:w-full [&_input]:rounded-md [&_input]:border [&_input]:border-line [&_input]:bg-leaf [&_input]:px-3 [&_input]:py-3 [&_input]:text-sm"
      aria-label="Private radio access"
    >
      <div>
        <strong>Private access</strong>
        <p>Enter the password to listen and use the controls.</p>
      </div>
      <label>
        <span className="sr-only">Viewer password</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          placeholder="Viewer password"
          aria-label="Viewer password"
          required
          maxLength={256}
          disabled={pending}
        />
      </label>
      <button
        type="submit"
        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-line px-3 py-2 text-xs font-medium whitespace-nowrap border-ink bg-ink text-paper enabled:hover:bg-ink-hover"
        disabled={pending}
      >
        {pending ? 'Unlocking…' : 'Unlock exhibit'}
      </button>
      {error ? (
        <p className="basis-full text-error!" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
