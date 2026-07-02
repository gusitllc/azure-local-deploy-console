# site

The azurestack.nyc marketing site + the $200 deployment-service sign-up + Stripe checkout.

Source of truth currently lives in the Luca Express monorepo at
`cloudflare-pages/azurestack-nyc-website/` (Cloudflare Pages project `azurestack-nyc-website`,
custom domain azurestack.nyc). It will be migrated here. Key files:
- `index.html` — homepage incl. the `#service` $200 section
- `signup.html` — order form → checkout
- `functions/api/deploy-signup.js` — Stripe Checkout Session (+ Resend notify, fail-open)
- `success.html` — post-payment confirmation
