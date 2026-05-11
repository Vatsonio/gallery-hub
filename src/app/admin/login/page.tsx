import { loginAction } from "./actions";

interface LoginPageProps {
  searchParams: Promise<{ error?: string; next?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const sp = await searchParams;
  const error = sp.error;
  const next = sp.next ?? "/admin/albums";
  const errorMessage =
    error === "invalid"
      ? "Invalid email or password"
      : error === "missing"
        ? "Please enter both email and password"
        : null;

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-bg-elevated p-8 shadow-2xl">
        <h1 className="text-xl font-semibold tracking-wider mb-1">Gallery Hub</h1>
        <p className="text-text-muted text-xs uppercase tracking-widest mb-6">Admin sign in</p>

        <form action={loginAction} className="space-y-4">
          <input type="hidden" name="next" value={next} />
          <label className="block">
            <span className="text-xs text-text-muted uppercase tracking-wider">Email</span>
            <input
              name="email"
              type="email"
              autoComplete="username"
              required
              className="mt-1 w-full rounded-lg bg-bg-card border border-line px-3 py-2 text-sm focus:outline-none focus:border-rose-accent"
            />
          </label>
          <label className="block">
            <span className="text-xs text-text-muted uppercase tracking-wider">Password</span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="mt-1 w-full rounded-lg bg-bg-card border border-line px-3 py-2 text-sm focus:outline-none focus:border-rose-accent"
            />
          </label>
          {errorMessage ? (
            <p className="text-sm text-rose-accent" role="alert">{errorMessage}</p>
          ) : null}
          <button
            type="submit"
            className="w-full rounded-lg bg-rose-accent hover:bg-rose-hover transition px-3 py-2 text-sm font-medium cursor-pointer"
          >
            Sign in
          </button>
        </form>
      </div>
    </main>
  );
}
