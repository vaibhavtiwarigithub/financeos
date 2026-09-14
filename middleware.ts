import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { OWNER_EMAIL } from "@/lib/auth/owner";
import { isViewerPage, isViewerApiRoute, VIEWER_HOME } from "@/lib/auth/roles";

/** Paths that require a signed-in owner to VIEW. */
function isProtectedPage(pathname: string): boolean {
  return pathname.startsWith("/dashboard")
    || pathname.startsWith("/property")
    || pathname.startsWith("/admin");
}

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  // FAST PATH — no session cookie means no session.
  //
  // `supabase.auth.getUser()` below is a NETWORK round-trip to the Supabase Auth
  // server, and it ran on EVERY matched request: every page, every /api/* call,
  // every pg_cron agent invocation carrying only a CRON_SECRET header. On a cold
  // start that round-trip can exceed Vercel's middleware budget and 504 the whole
  // request — observed in production 2026-08-29 as MIDDLEWARE_INVOCATION_TIMEOUT
  // on the LOGIN page, which by definition has no session to look up.
  //
  // A request with no Supabase auth cookie cannot resolve to a user, so the call
  // can only ever return null. Short-circuiting preserves the exact behaviour of
  // the code below for that case (unauthenticated -> redirect protected pages to
  // /login, pass everything else through) while removing the round-trip.
  const hasAuthCookie = request.cookies.getAll()
    .some((c) => c.name.startsWith("sb-") && c.name.includes("auth-token"));
  if (!hasAuthCookie) {
    return isProtectedPage(request.nextUrl.pathname)
      ? NextResponse.redirect(new URL("/login", request.url))
      : NextResponse.next({ request });
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return request.cookies.getAll(); },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options as any)
          );
        },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();

  // This is the real access gate — the client-side email checks in
  // app/login/page.tsx are cosmetic only (a bypassed/direct Supabase Auth call,
  // or a Google OAuth sign-in, would skip them entirely). Any authenticated
  // session that is neither the owner nor an active viewer is rejected here,
  // regardless of how the session was created.
  //
  // A viewer's grant lives in `app_user_roles`, which only service-role can
  // write. It is deliberately NOT read from `profiles.role`: that table lets a
  // user update their own row, so trusting it would let a guest self-promote.
  // The table starts empty, so until a grant is created this behaves exactly as
  // the previous owner-only gate did.
  const isOwner = user?.email === OWNER_EMAIL;
  let isViewer = false;
  if (user && !isOwner) {
    const { data: grant } = await supabase
      .from("app_user_roles")
      .select("revoked_at")
      .eq("user_id", user.id)
      .maybeSingle();
    isViewer = Boolean(grant && !grant.revoked_at);
    if (!isViewer) {
      await supabase.auth.signOut();
      if (request.nextUrl.pathname !== "/login") {
        return NextResponse.redirect(new URL("/login?error=restricted", request.url));
      }
    }
  }

  // Viewers are confined to an explicit page set and an explicit API set.
  // Defence in depth: each viewer-safe API route re-checks this itself, so a
  // middleware matcher change cannot silently widen a viewer's reach.
  if (isViewer) {
    const { pathname } = request.nextUrl;
    if (pathname.startsWith("/api/")) {
      if (!isViewerApiRoute(pathname, request.method)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    } else if (isProtectedPage(pathname) && !isViewerPage(pathname)) {
      return NextResponse.redirect(new URL(VIEWER_HOME, request.url));
    }
  }

  // Protect both authenticated workspaces. Property has its own shell and
  // data boundary, but it shares the same single-owner authentication gate.
  if (!user && isProtectedPage(request.nextUrl.pathname)) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Protect admin routes. Gate on OWNER identity, not `profiles.role`: that
  // column is user-writable (RLS `FOR ALL USING (auth.uid() = id)`), so reading
  // it here was a self-promotion path to /admin the moment a second account
  // existed. A DB trigger now blocks the write as well; this is the second lock.
  if (request.nextUrl.pathname.startsWith("/admin")) {
    if (!user) return NextResponse.redirect(new URL("/login", request.url));
    if (!isOwner) return NextResponse.redirect(new URL(VIEWER_HOME, request.url));
  }

  // Redirect logged-in users away from login page
  if (user && request.nextUrl.pathname === "/login") {
    return NextResponse.redirect(new URL(isViewer ? VIEWER_HOME : "/dashboard", request.url));
  }

  return supabaseResponse;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
