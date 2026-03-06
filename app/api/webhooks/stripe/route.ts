import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@/lib/supabase/server";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST(req: NextRequest) {
    const body = await req.text();
    const sig = req.headers.get("stripe-signature")!;

  let event: Stripe.Event;
    try {
          event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
      import { NextRequest, NextResponse } from "next/server";
      import Stripe from "stripe";
      import { createClient } from "@/lib/supabase/server";

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

  export async function POST(req: NextRequest) {
      const body = await req.text();
      const sig = req.headers.get("stripe-signature")!;

        let event: Stripe.Event;
      try {
            event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
      } catch {
            return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
      }

        const supabase = await createClient();

        switch (event.type) {
          case "checkout.session.completed": {
                  const session = event.data.object as Stripe.Checkout.Session;
                  const userId = session.metadata?.supabase_user_id;
                  const tier = session.metadata?.tier;
                  if (userId && tier) {
                            await supabase.from("profiles").update({
                                        subscription_tier: tier,
                                        subscription_status: "active",
                                        stripe_subscription_id: session.subscription as string,
                            }).eq("id", userId);
                  }
                  break;
          }
          case "customer.subscription.deleted": {
                  const sub = event.data.object as Stripe.Subscription;
                  await supabase.from("profiles").update({
                            subscription_tier: "free",
                            subscription_status: "canceled",
                            stripe_subscription_id: null,
                  }).eq("stripe_subscription_id", sub.id);
                  break;
          }
          case "customer.subscription.updated": {
                  const sub = event.data.object as Stripe.Subscription;
                  const status = sub.status === "active" ? "active" : sub.status === "past_due" ? "past_due" : "canceled";
                  await supabase.from("profiles").update({
                            subscription_status: status,
                  }).eq("stripe_subscription_id", sub.id);
                  break;
          }
        }

        return NextResponse.json({ receive
