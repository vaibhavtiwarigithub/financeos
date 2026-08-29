import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { OWNER_EMAIL } from "@/lib/auth/owner";

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

  // Personal tool, single owner. This is the real access gate — the
  // client-side email checks in app/login/page.tsx are cosmetic only (a
  // bypassed/direct Supabase Auth call, or a Google OAuth sign-in, would
  // skip them entirely). Any authenticated session that isn't the owner is
  // rejected here, regardless of how the session was created.
  if (user && user.email !== OWNER_EMAIL) {
    await supabase.auth.signOut();
    if (request.nextUrl.pathname !== "/login") {
      return NextResponse.redirect(new URL("/login?error=restricted", request.url));
    }
  }

  // Protect both authenticated workspaces. Property has its own shell and
  // data boundary, but it shares the same single-owner authentication gate.
  if (!user && isProtectedPage(request.nextUrl.pathname)) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Protect admin routes
  if (request.nextUrl.pathname.startsWith("/admin")) {
    if (!user) return NextResponse.redirect(new URL("/login", request.url));
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    if (!profile || !["admin", "superadmin"].includes(profile.role)) {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }
  }

  // Redirect logged-in users away from login page
  if (user && request.nextUrl.pathname === "/login") {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return supabaseResponse;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
