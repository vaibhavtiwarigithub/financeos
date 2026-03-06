# FinanceOS — Deployment Guide

## STEP 1: Rotate your Anthropic API key (URGENT)
The key you shared is compromised. Go to console.anthropic.com → API Keys → delete old key → create new one.

---

## STEP 2: Set up Supabase

1. Go to supabase.com → your project (BeAnyOne) → restart it if inactive
2. Go to Settings → API → copy your anon key and URL
3. Go to SQL Editor → paste the entire contents of `supabase/migrations/001_initial_schema.sql` → Run
4. Go to Authentication → Providers → Enable **Google**
   - Add your Google OAuth credentials (get from console.cloud.google.com)
   - Authorized redirect URI: `https://mbnjblsqqnhgfrrpzefy.supabase.co/auth/v1/callback`
5. Authentication → Email → Enable email confirmations

---

## STEP 3: Push to GitHub

```bash
cd financeos
git init
git add .
git commit -m "Initial FinanceOS commit"
git remote add origin https://github.com/vaibhavtiwarigithub/financeos
git push -u origin main
```

---

## STEP 4: Deploy on Vercel

1. Go to vercel.com → New Project → Import your GitHub repo
2. Add these Environment Variables:
   ```
   NEXT_PUBLIC_SUPABASE_URL=https://mbnjblsqqnhgfrrpzefy.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=<from supabase dashboard>
   ANTHROPIC_API_KEY=<your NEW key>
   NEXT_PUBLIC_APP_URL=https://your-domain.com
   ADMIN_EMAIL=vterminater@gmail.com
   ```
3. Deploy. Vercel auto-builds from GitHub on every push.

---

## STEP 5: Set up Stripe (for subscriptions)

1. Go to stripe.com → create account
2. Create 2 products:
   - "FinanceOS Pro" — $29/month recurring → copy Price ID
   - "FinanceOS Elite" — $99/month recurring → copy Price ID
3. Add to Vercel env vars:
   ```
   STRIPE_SECRET_KEY=sk_live_...
   NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_...
   STRIPE_PRO_PRICE_ID=price_...
   STRIPE_ELITE_PRICE_ID=price_...
   ```
4. Stripe → Webhooks → Add endpoint: `https://your-domain.com/api/webhooks/stripe`
   - Events: `checkout.session.completed`, `customer.subscription.deleted`, `customer.subscription.updated`
   - Copy webhook secret → add as `STRIPE_WEBHOOK_SECRET`

---

## STEP 6: Google OAuth setup

1. Go to console.cloud.google.com → New Project → "FinanceOS"
2. APIs & Services → OAuth consent screen → fill in details
3. Credentials → Create OAuth 2.0 Client ID
   - Type: Web application
   - Authorized redirect URIs:
     - `https://mbnjblsqqnhgfrrpzefy.supabase.co/auth/v1/callback`
     - `https://your-domain.com/auth/callback`
4. Copy Client ID + Secret → paste into Supabase Auth → Google provider

---

## STEP 7: Connect domain (optional)

Vercel → your project → Settings → Domains → add your domain → update DNS as shown

---

## Admin access

`vterminater@gmail.com` is automatically set as superadmin on first login.
Admin panel: `/dashboard/admin`

---

## Architecture recap

- **Auth**: Supabase (Google OAuth + email/password)
- **Database**: Supabase Postgres (RLS enabled)
- **AI**: Anthropic API, server-side only (key never exposed to browser)
- **Payments**: Stripe subscriptions, webhook syncs tier to DB
- **Hosting**: Vercel (auto-deploys on GitHub push)
- **Domain**: Vercel DNS or your own

Every push to GitHub = automatic deployment. No manual deploys needed.
