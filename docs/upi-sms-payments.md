# UPI QR payments, confirmed by bank SMS

Buyers pay for credits by scanning a UPI QR that pays the owner's own VPA.
The owner's bank texts the owner's phone. The **SMS to URL Forwarder** Android
app forwards that SMS to the API, which reads it, matches it to the order and
adds the credits. The buyer only scans and pays. There is nothing to type.

> **This is prototype-grade verification, not a bank API.** The API believes
> an SMS that arrives with the right token, from a configured bank sender,
> worded the way a parse rule expects. Read [Limits](#limits) before turning
> it on.

## How a payment flows

1. The buyer picks a quantity. `POST /api/billing/upi/orders` reuses the
   existing pricing, bounds and promo rules (`begin_credit_purchase`), then
   turns the order into a UPI order with:
   - our reference (`TSU…`) in `payments.provider_order_id`,
   - an expiry (`UPI_ORDER_TTL_MINUTES`, default 15),
   - a payable amount that is **unique among open orders**: 0–99 paise *below*
     the price. The buyer never pays more than the list price.
2. The page shows the QR (`upi://pay?pa=…&am=…&tn=TradeSathi TSU…`), plus a
   "Pay with a UPI app" button on phones, and polls
   `GET /api/billing/upi/orders/:id` every 3 seconds.
3. The bank's credit SMS reaches the phone, and the forwarder posts it to
   `POST /api/webhooks/sms`.
4. The API drops it unread unless it comes from a sender in `UPI_SMS_SENDERS`.
   Otherwise it stores it, parses it with `UPI_SMS_RULES`, and for a credit
   calls `match_upi_sms`.
5. `match_upi_sms` settles the order only if **all** of these hold:
   - the SMS parsed as a credit, with an amount and a UTR,
   - its UTR has never been seen before (unique index, so duplicate SMS and
     forwarder retries settle nothing twice),
   - if `UPI_ACCOUNT_LAST4` is set and the rule reads the account, the
     credited account ends in those digits,
   - exactly one UPI order has that exact amount, and the SMS was received
     after the order was created and before its expiry plus
     `UPI_SMS_GRACE_MINUTES`.
6. Settling goes through the existing `apply_credit_purchase`: the same
   balance update, ledger row, promo bookkeeping and idempotency as a Razorpay
   capture. The UTR becomes `payments.provider_payment_id`.
7. Anything that does not settle (no matching order, two matching orders, not
   understood, wrong account) goes to **Admin → UPI payments** for a person to
   decide.

The amount is the link between SMS and order because a bank's credit SMS does
not include the UPI note, so our reference never reaches it. Never the only
check, though: sender, rule, UTR uniqueness, account and time window must all
agree too.

When two orders fit, the API checks whether the payer named in the SMS (if a
rule captures one) matches exactly one buyer's profile, by the phone number
in their VPA or by their name. If it does, that order is settled. If not, it
waits for an admin. An amount stays reserved through its order's grace
period, so this only happens in edge cases.

## Setup

### 1. Apply the migrations

```bash
npx supabase migration list --remote
```

```bash
npx supabase db push
```

The two migrations are `20260925120000_billing_provider_upi_direct.sql` (adds
the `upi_direct` provider) and `20260925120100_upi_sms_payments.sql` (tables,
functions, audit log). They have to be separate files: Postgres cannot use a
new enum value in the same transaction that adds it.

### 2. Capture real SMS first (purchases still off)

Set these on the API (Render → tradesathi-api → Environment):

| Variable | Value |
| --- | --- |
| `SMS_WEBHOOK_TOKEN` | output of `openssl rand -hex 32` |
| `UPI_SMS_SENDERS` | your bank's sender id(s), e.g. `HDFCBK` |
| `UPI_PAYMENTS_ENABLED` | `false` for now |

With a token set, the webhook is live even while purchases are off. Configure
the phone (next section), then pay yourself ₹1 from a different account. The
SMS appears in **Admin → UPI payments** as *Not understood*, with its full text.
Collect a few:

- two or three credit SMS (from different UPI apps if you can),
- one debit SMS,
- any reversal or refund SMS your bank sends.

### 3. Write the parse rules

`UPI_SMS_RULES` is a JSON array on one line. No bank format is built in. Each
rule is written from the messages you captured.

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | label shown in the admin queue and logs |
| `senders` | no | restrict the rule to these sender ids (default: any in `UPI_SMS_SENDERS`) |
| `match` | yes | regex that must match for the rule to apply, e.g. the word your bank uses for a credit |
| `exclude` | no | regex that, if it matches, marks the SMS *not a credit* (debits, reversals). Checked first. |
| `amount` | yes | regex with a named group `(?<amount>…)`, e.g. `1,234.50` |
| `utr` | yes | regex with a named group `(?<utr>…)`, the UPI reference/RRN |
| `account` | no | regex with `(?<account>…)`, checked against `UPI_ACCOUNT_LAST4` |
| `payer` | no | regex with `(?<payer>…)`, a VPA or name, used for review and tie-breaks |

Patterns are JavaScript regexes, case-insensitive, matched against the SMS
with whitespace collapsed to single spaces. In JSON every `\` is written `\\`.

An **illustrative** rule for an *invented* message (not any real bank's
format):

```
Example Bank: INR 1,234.50 credited to A/c XX4321 on 07-11-26 from 9876543210@xmpl. Ref No 412345678901
```

```json
[{"name":"example-credit","senders":["XMPLBK"],"match":"credited","exclude":"debited","amount":"INR\\s*(?<amount>[\\d,]+(?:\\.\\d{1,2})?)","utr":"Ref\\s*No\\.?\\s*(?<utr>\\d{12})","account":"A/c\\s*(?<account>[X*]*\\d{4})","payer":"from\\s+(?<payer>[\\w.@-]+?)\\.?\\s"}]
```

The API compiles the rules at startup and refuses to boot if one is invalid,
naming the rule and field. To check a rule against a captured message, add a
case to `apps/api/src/services/upi-sms-parser.test.ts` with the redacted
message and run:

```bash
pnpm --filter @tradesathi/api exec vitest run src/services/upi-sms-parser.test.ts
```

Redact before committing: swap digits for fakes but keep the layout exactly.

### 4. Turn purchases on

| Variable | Value |
| --- | --- |
| `UPI_PAYMENTS_ENABLED` | `true` |
| `UPI_PAYEE_VPA` | the VPA buyers pay, e.g. `yourname@okhdfcbank` |
| `UPI_PAYEE_NAME` | the name shown in the payer's app (optional, default `TradeSathi`) |
| `UPI_ACCOUNT_LAST4` | last four digits of the account (optional, recommended) |
| `UPI_ORDER_TTL_MINUTES` | optional, default 15 (5–60) |
| `UPI_SMS_GRACE_MINUTES` | optional, default 20 (0–240) |

The web app reads `purchasesEnabled` from `GET /api/pricing`, so the Buy
Credits buttons appear without a web rebuild. UPI is offered in the India
pricing region only.

## Android: SMS to URL Forwarder

These field names match the app's documented defaults. Check them against the
version installed on the phone; if a field is named differently, the meaning
is the same.

1. Give the app **SMS permission**. Under Android settings → Apps → SMS to URL
   Forwarder → Battery, choose **Unrestricted** (no battery optimisation), or
   Android will stop it in the background and SMS will arrive late or never.
2. Add a forwarding rule:
   - **Sender**: your bank's sender id. Indian banks send from several DLT
     headers (`AX-…`, `VM-…`, `JD-…`). If your version matches exact senders
     only, add one rule per header you have seen. Avoid `*` (all senders):
     the API drops non-bank SMS unread, but OTPs and personal messages would
     still leave the phone.
   - **Webhook URL**:
     `https://tradesathi-api.onrender.com/api/webhooks/sms`
     Always HTTPS. Leave **Ignore SSL errors** off.
   - **JSON payload template**, the app's default:
     ```json
     {"from":"%from%","text":"%text%","sentStamp":%sentStamp%,"receivedStamp":%receivedStamp%,"sim":"%sim%"}
     ```
     The API reads `from`, `text`, `sentStamp` and `receivedStamp`
     (milliseconds since the epoch). Other fields are ignored.
   - **Headers**:
     ```json
     {"Authorization":"Bearer <SMS_WEBHOOK_TOKEN>","Content-Type":"application/json"}
     ```
     If your version cannot send an `Authorization` header, use
     `{"X-Webhook-Token":"<SMS_WEBHOOK_TOKEN>"}` instead. Never put the token
     in the URL.
   - **Retries**: a few (for example 5). The API answers 200 to everything it
     handled and 500 only when it could not store the SMS, and it ignores a
     retry of an SMS it already has.
3. Test with a ₹1 self-payment. The API log shows `sms webhook: stored` or
   `sms webhook: credit processed`; a wrong token logs
   `sms webhook rejected: bad or missing token` and answers 401.

The API runs on Render. If the service sleeps when idle, the first SMS after a
quiet spell can take tens of seconds to be accepted. The forwarder's retries
cover that, and the order's grace period covers the delay.

## Manual verification (Admin → UPI payments)

- **Needs a decision**: SMS that settled nothing. *Settle order* links one to
  an order (★ marks the likely ones: same amount, or a payer matching the
  buyer's phone or name). The database still refuses unless the amounts are
  equal. *Dismiss* removes a refund, a personal transfer or a non-payment
  alert from the queue.
- **Unpaid UPI orders**: the last three days. *Mark paid without an SMS* is for
  when the SMS never arrived (phone off, forwarder stopped). It needs the UTR
  from the bank statement and a note saying where you checked. It refuses a
  UTR that settled another order, or one an SMS carries (link that SMS
  instead, which checks its amount).

Every decision, automatic or manual, is written to `upi_payment_events` with
the admin who made it. SMS text is stored in `upi_sms_messages`, which has row
level security on and no client policies, so only the service role (the API)
can read it.

## Limits

Take these seriously before sending real buyers to this:

- **A forged SMS is believed.** Anything that can put a message with a bank's
  sender id on the owner's phone, or anyone holding `SMS_WEBHOOK_TOKEN`, can
  settle an order. Keep the token secret and rotate it if the phone is lost.
- **A stranger's payment of the same amount** to the same VPA inside the same
  window would settle the open order with that amount. The odd paise and the
  short window make it unlikely, not impossible.
- **Bank formats change without notice.** A changed SMS lands as *Not
  understood*, and those orders wait for an admin until the rule is updated.
- **The phone is a single point of failure.** If it is off, out of signal or
  the app is killed, nothing settles automatically.
- **The VPA is public.** It is inside every QR.
- **Receiving business payments on a personal UPI ID** may be against your
  bank's terms for personal accounts, and banks can limit or freeze accounts
  that receive many payments from strangers. Check with your bank, and on tax,
  before relying on this.

UPI captures count as revenue in the Admin panel like any other captured
payment, and the payment lists label them *UPI · bank SMS*.
